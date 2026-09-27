import { removeAssistantEcho } from "./assistant-echo";

type Mode = "idle" | "candidate" | "accepted";

/** A short filler/backchannel is never enough on its own to cut off a reply. */
const fillerWords = new Set(["um", "uh", "uhm", "erm", "hmm", "mm", "mhm", "ah", "oh"]);

/** How many real (non-filler) words a transcript needs before it interrupts a reply. */
const meaningfulWordThreshold = 2;

/** How often the interrupt condition is rechecked while confirmed speech runs over a reply. */
export const meaningfulSpeechMs = 1_200;

/** Share of heard words that, when all found in the reply, marks the transcript as the reply's own echo. */
const echoWordShare = 0.6;

function realWords(text: string): string[] {
  return [...text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)]
    .map((match) => match[0])
    .filter((word) => !fillerWords.has(word));
}

/**
 * Whether a (partial or final) transcript has said enough - once assistant echo and
 * filler words are stripped - to justify cutting off an in-progress reply.
 */
export function isMeaningfulSpeech(transcript: string, echo: string): boolean {
  const stripped = echo ? removeAssistantEcho(transcript, echo) : transcript;
  const heard = realWords(stripped);
  if (heard.length < meaningfulWordThreshold) return false;
  // The mic picks up the reply itself, often only a few words at a time and slightly misheard:
  // mostly the reply's own words means echo, not the user.
  if (echo) {
    const replyWords = new Set(realWords(echo));
    const fromReply = heard.filter((word) => replyWords.has(word)).length;
    if (fromReply / heard.length >= echoWordShare) return false;
  }
  return true;
}

type StartDecision = { duck: boolean; begin: boolean; accepted: boolean };
type RealStartDecision = { keepDucked: boolean; begin: boolean; accepted: boolean };
type EndDecision = { accepted: boolean; interrupt: boolean; send: boolean };

/**
 * The active turn is not cancelled just because VAD confirms speech: a reply keeps playing
 * until the speaker has said something meaningful (two real words that aren't filler or the
 * reply's own echo), so a quick "um", noise, or the reply heard through the mic never cancels
 * it. If speech ends without meeting that bar, the reply is left alone and the recording is
 * discarded instead of being sent as a new turn.
 */
export class BargeInGuard {
  private mode: Mode = "idle";
  private interruptOnConfirm = false;
  private interrupted = false;
  private startedAt = 0;
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  speechStart(hasActiveTurn: boolean): StartDecision {
    this.mode = "candidate";
    this.interruptOnConfirm = hasActiveTurn;
    this.interrupted = false;
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
  shouldInterruptNow(transcript: string, echo: string): boolean {
    if (this.mode !== "accepted" || !this.interruptOnConfirm || this.interrupted) return false;
    // Only words count: how long the "speech" lasts says nothing when the mic can hear the reply.
    if (isMeaningfulSpeech(transcript, echo)) {
      this.interrupted = true;
      return true;
    }
    return false;
  }

  /**
   * Final decision once VAD reports speech has ended. `transcript` is the latest
   * transcript available at that moment (the live speculative preview).
   */
  speechEnd(transcript: string, echo: string): EndDecision {
    const accepted = this.mode === "accepted";
    if (!accepted) {
      this.reset();
      return { accepted: false, interrupt: false, send: false };
    }
    if (!this.interruptOnConfirm || this.interrupted) {
      // Either this was never a candidate to interrupt, or it already was, earlier.
      this.reset();
      return { accepted: true, interrupt: false, send: true };
    }
    if (isMeaningfulSpeech(transcript, echo)) {
      this.reset();
      return { accepted: true, interrupt: true, send: true };
    }
    // Only filler, echo, or nothing was heard, and the reply was never interrupted:
    // let the reply keep playing and drop this recording instead of sending it.
    this.reset();
    return { accepted: true, interrupt: false, send: false };
  }

  reset() {
    this.mode = "idle";
    this.interruptOnConfirm = false;
    this.interrupted = false;
    this.startedAt = 0;
  }
}
