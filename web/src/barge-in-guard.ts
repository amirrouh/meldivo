type Mode = "idle" | "candidate" | "accepted";

/** A short filler/backchannel is never enough on its own to cut off a reply. */
const fillerWords = new Set(["um", "uh", "uhm", "erm", "hmm", "mm", "mhm", "ah", "oh"]);

/** How many real (non-filler) words a transcript needs before it interrupts a reply. */
const meaningfulWordThreshold = 2;

/** How often the interrupt condition is rechecked while confirmed speech runs over a reply. */
export const meaningfulSpeechMs = 1_200;

/**
 * A live preview transcript older than this (or one that never arrived) is treated as
 * stale: it says nothing reliable about what the speaker just said, so speechEnd must
 * not use it to drop the recording. The final transcription is awaited instead.
 */
export const previewFreshnessMs = 700;

function tokenize(text: string): string[] {
  return [...text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)].map((match) => match[0]);
}

function realWords(text: string): string[] {
  return tokenize(text).filter((word) => !fillerWords.has(word));
}

/** True when every position of `segment` matches the same-length run of `window` starting at `at`. */
function runMatches(segment: string[], window: string[], at: number, allowedMismatches: number): boolean {
  let mismatches = 0;
  for (let index = 0; index < segment.length; index++) {
    if (segment[index] !== window[at + index]) {
      mismatches++;
      if (mismatches > allowedMismatches) return false;
    }
  }
  return true;
}

/**
 * The longest contiguous run of transcript words (start inclusive, end exclusive) that
 * lines up, in order, with some contiguous run of the recently played words - allowing
 * about one substituted word per four (a misheard word here or there), so ASR noise
 * does not defeat the match.
 */
function longestAlignedRun(transcriptWords: string[], windowWords: string[]): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (let start = 0; start < transcriptWords.length; start++) {
    for (let end = transcriptWords.length; end > start; end--) {
      const length = end - start;
      if (best && length <= best.end - best.start) break;
      if (length < 2 || length > windowWords.length) continue;
      const allowedMismatches = Math.floor(length / 4);
      const segment = transcriptWords.slice(start, end);
      let found = false;
      for (let at = 0; at <= windowWords.length - length; at++) {
        if (runMatches(segment, windowWords, at, allowedMismatches)) { found = true; break; }
      }
      if (found) { best = { start, end }; break; }
    }
  }
  return best;
}

export type SpeechClassification = { echo: boolean; meaningful: boolean };

/**
 * Position-aware replacement for the old bag-of-words echo check: a transcript only
 * counts as the reply's own echo when an ordered run of its words actually lines up
 * with what was recently playing, and almost nothing else was said around it. Anything
 * else - including a transcript that happens to share individual words with the reply
 * but never lines up in order - is judged purely on how many real words it has.
 */
export function classifySpeech(transcript: string, recentWindow: string): SpeechClassification {
  const transcriptWords = tokenize(transcript);
  const real = transcriptWords.filter((word) => !fillerWords.has(word));
  if (real.length < meaningfulWordThreshold) return { echo: false, meaningful: false };
  const windowWords = tokenize(recentWindow);
  if (windowWords.length) {
    const run = longestAlignedRun(transcriptWords, windowWords);
    if (run) {
      const outsideReal = transcriptWords.filter(
        (word, index) => (index < run.start || index >= run.end) && !fillerWords.has(word),
      ).length;
      if (outsideReal < meaningfulWordThreshold) return { echo: true, meaningful: false };
    }
  }
  return { echo: false, meaningful: true };
}

/**
 * Whether a (partial or final) transcript has said enough - once assistant echo and
 * filler words are stripped - to justify cutting off an in-progress reply.
 */
export function isMeaningfulSpeech(transcript: string, recentWindow: string): boolean {
  return classifySpeech(transcript, recentWindow).meaningful;
}

/** A short, deliberate word or phrase asking the assistant to stop, said on purpose. */
const cuePhrases = ["stop", "wait", "hold on", "hang on", "pause", "shut up", "enough"];
const cuePatterns = cuePhrases.map((phrase) => new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "iu"));

/**
 * Looks for a deliberate stop cue in `transcript` that is not itself just the reply
 * echoing the same word (e.g. the assistant saying "please wait" heard back through the
 * mic). Returns the transcript with the cue phrase removed, so a lone cue word can be
 * recognized as "say nothing more, just stop" instead of being sent as a new message.
 */
export function findDeliberateCue(transcript: string, recentWindow: string): { remainder: string } | null {
  for (const pattern of cuePatterns) {
    if (!pattern.test(transcript) || pattern.test(recentWindow)) continue;
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    const stripped = transcript.replace(global, " ").replace(/\s+/gu, " ").trim().replace(/^[\s,.;:!?—-]+/u, "");
    return { remainder: realWords(stripped).length ? stripped : "" };
  }
  return null;
}

export function hasDeliberateCue(transcript: string, recentWindow: string): boolean {
  return findDeliberateCue(transcript, recentWindow) !== null;
}

/** A phrase the assistant (or a working cue) actually played, for windowing what the mic could be echoing. */
export type PlayedPhrase = { text: string; startedAt: number; seconds: number };

/** Rough spoken duration of a phrase, used only to size the echo window - about 15 characters per second. */
export function estimatePhraseSeconds(text: string): number {
  return Math.max(0.2, text.trim().length / 15);
}

/** How far back from the moment speech starts a played phrase can still be the thing the mic is echoing. */
const recentPlaybackLookbackMs = 1_500;
/** A little slack after "now", since audio in flight can still be a few words behind what was requested. */
const recentPlaybackPadMs = 300;
/** Phrases older than this are dropped from the ring outright; nothing plays that long into an utterance. */
const playedPhraseMaxAgeMs = 10_000;

/** Appends a just-started phrase to the ring, dropping entries too old to ever matter. */
export function recordPlayedPhrase(ring: PlayedPhrase[], text: string, startedAt: number): PlayedPhrase[] {
  const trimmed = ring.filter((phrase) => startedAt - (phrase.startedAt + phrase.seconds * 1_000) < playedPhraseMaxAgeMs);
  trimmed.push({ text, startedAt, seconds: estimatePhraseSeconds(text) });
  return trimmed;
}

/**
 * The text of whatever was playing recently enough, relative to when the candidate
 * speech started, that the mic could plausibly be hearing it rather than the user.
 */
export function recentPlaybackWindow(ring: PlayedPhrase[], speechStartAt: number, now: number): string {
  const from = speechStartAt - recentPlaybackLookbackMs;
  const to = now + recentPlaybackPadMs;
  return ring
    .filter((phrase) => phrase.startedAt + phrase.seconds * 1_000 >= from && phrase.startedAt <= to)
    .map((phrase) => phrase.text)
    .join(" ");
}

/** How many mic RMS frames the acoustic gate samples right after a candidate starts (~250 ms of 32 ms frames). */
export const acousticGateFrames = 8;
/** The candidate must be at least this many times louder than the known echo floor to trust the word path. */
export const acousticGateRatio = 2.5;

/** Whether the mean RMS of a fresh candidate is too close to the echo floor to trust word-based interruption. */
export function isBelowEchoFloor(candidateMeanRms: number, echoFloor: number | null): boolean {
  if (echoFloor === null) return false;
  return candidateMeanRms < echoFloor * acousticGateRatio;
}

type StartDecision = { duck: boolean; begin: boolean; accepted: boolean };
type RealStartDecision = { keepDucked: boolean; begin: boolean; accepted: boolean };
type EndDecision = {
  accepted: boolean;
  interrupt: boolean;
  send: boolean;
  /**
   * The live preview was empty or stale, so the decision to interrupt/send could not be
   * made yet. The recording is sent through the normal transcription pipeline anyway
   * (never silently dropped), and the caller must classify the final transcript itself -
   * using `wordPathBlocked` below - once it arrives.
   */
  deferDecision: boolean;
  /** Snapshot of the acoustic gate at speech end, for a deferred decision to honor it too. */
  wordPathBlocked: boolean;
};

/**
 * The active turn is not cancelled just because VAD confirms speech: a reply keeps playing
 * until the speaker has said something meaningful (two real words that aren't filler or the
 * reply's own echo) or a deliberate stop cue, so a quick "um", noise, or the reply heard
 * through the mic never cancels it. A recording is only ever dropped once a transcript -
 * live preview or, failing that, the final one - has actually been judged unmeaningful;
 * an empty or stale preview is never enough on its own to drop it.
 */
export class BargeInGuard {
  private mode: Mode = "idle";
  private interruptOnConfirm = false;
  private interrupted = false;
  private startedAt = 0;
  private wordPathBlockedFlag = false;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** No speech candidate is currently open: safe to fold a frame into the echo-floor baseline. */
  get idle() {
    return this.mode === "idle";
  }

  get wordPathBlocked() {
    return this.wordPathBlockedFlag;
  }

  /** The acoustic gate (see App.tsx's onFrameProcessed) found this candidate too quiet to trust the word path. */
  blockWordPath() {
    if (this.mode === "candidate" || this.mode === "accepted") this.wordPathBlockedFlag = true;
  }

  speechStart(hasActiveTurn: boolean): StartDecision {
    this.mode = "candidate";
    this.interruptOnConfirm = hasActiveTurn;
    this.interrupted = false;
    this.wordPathBlockedFlag = false;
    this.startedAt = this.now();
    return { duck: hasActiveTurn, begin: true, accepted: false };
  }

  speechRealStart(): RealStartDecision {
    if (this.mode === "candidate") {
      this.mode = "accepted";
      return { keepDucked: this.interruptOnConfirm, begin: false, accepted: true };
    }
    return { keepDucked: false, begin: false, accepted: this.mode === "accepted" };
  }

  /**
   * Called as new partial transcript text arrives (or a watchdog timer fires) while
   * accepted speech is still running. Returns true at most once per accepted speech
   * segment, the moment the interrupt condition is first met.
   */
  shouldInterruptNow(transcript: string, recentWindow: string): boolean {
    if (this.mode !== "accepted" || !this.interruptOnConfirm || this.interrupted) return false;
    // A deliberate cue ("stop", "wait", ...) always interrupts, even through the acoustic
    // gate, as long as it is not itself just an echo of the reply saying the same word.
    if (hasDeliberateCue(transcript, recentWindow)) {
      this.interrupted = true;
      return true;
    }
    if (this.wordPathBlockedFlag) return false;
    // Only words count: how long the "speech" lasts says nothing when the mic can hear the reply.
    if (isMeaningfulSpeech(transcript, recentWindow)) {
      this.interrupted = true;
      return true;
    }
    return false;
  }

  /**
   * Final decision once VAD reports speech has ended. `transcript` is the latest live
   * preview available at that moment, and `freshPreview` says whether it can be trusted
   * (non-empty and recent enough) to judge on the spot. When it cannot, the recording is
   * still sent through transcription (`send: true`, `deferDecision: true`) instead of
   * being silently discarded; the caller judges the final transcript once it arrives.
   */
  speechEnd(transcript: string, recentWindow: string, freshPreview: boolean): EndDecision {
    const accepted = this.mode === "accepted";
    const wordPathBlocked = this.wordPathBlockedFlag;
    if (!accepted) {
      this.reset();
      return { accepted: false, interrupt: false, send: false, deferDecision: false, wordPathBlocked };
    }
    if (!this.interruptOnConfirm || this.interrupted) {
      // Either this was never a candidate to interrupt, or it already was, earlier.
      this.reset();
      return { accepted: true, interrupt: false, send: true, deferDecision: false, wordPathBlocked };
    }
    if (!freshPreview) {
      // Never drop real speech over a reply just because the preview hasn't caught up:
      // let the final transcription decide, with the reply left playing meanwhile.
      this.reset();
      return { accepted: true, interrupt: false, send: true, deferDecision: true, wordPathBlocked };
    }
    if (hasDeliberateCue(transcript, recentWindow) || (!wordPathBlocked && isMeaningfulSpeech(transcript, recentWindow))) {
      this.reset();
      return { accepted: true, interrupt: true, send: true, deferDecision: false, wordPathBlocked };
    }
    // A fresh preview said only filler, echo, or nothing, and the reply was never
    // interrupted: let it keep playing and drop this recording instead of sending it.
    this.reset();
    return { accepted: true, interrupt: false, send: false, deferDecision: false, wordPathBlocked };
  }

  reset() {
    this.mode = "idle";
    this.interruptOnConfirm = false;
    this.interrupted = false;
    this.wordPathBlockedFlag = false;
    this.startedAt = 0;
  }
}
