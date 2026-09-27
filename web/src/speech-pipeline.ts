export type PreparedSpeech = ((signal: AbortSignal) => Promise<void>) & {
  /** Resolves once the whole phrase's audio has arrived, with its actual duration in seconds
   * (used to refine the estimated position of a barge-in mid-phrase; see cut-sentence.ts). */
  completed?: Promise<number>;
};

// Queued phrases are merged into one TTS request up to this length. Each new request waits for
// the speech server's first audio again, but a very long one can generate slower than it plays.
export const maxMergedSpeechChars = 300;

type Run = {
  controller: AbortController;
  text: string[];
  audio: { text: string; prepared: PreparedSpeech }[];
  hasDispatchedSpeech: boolean;
  generating: boolean;
  /** The text of the phrase currently playing, or null when nothing is. */
  playing: string | null;
  /** Paused in place by hold(): nothing plays or generates until resume()/cancel(). */
  held: boolean;
};

/** One TTS producer and one audio consumer with at most two prepared phrases. */
export class SpeechPipeline {
  private run = this.fresh();
  private synthesize: (text: string, signal: AbortSignal) => Promise<PreparedSpeech>;
  private changed: () => void;
  private reportError: (error: unknown) => void;

  constructor(
    synthesize: (text: string, signal: AbortSignal) => Promise<PreparedSpeech>,
    changed: () => void,
    reportError: (error: unknown) => void,
  ) {
    this.synthesize = synthesize;
    this.changed = changed;
    this.reportError = reportError;
  }

  get busy() {
    const run = this.run;
    return run.held || run.generating || run.playing !== null || run.text.length > 0 || run.audio.length > 0;
  }

  enqueue(text: string[]) {
    this.run.text.push(...text);
    this.pump(this.run);
  }

  /**
   * Pauses the run in place, at a barge-in's acoustic-gate pass: whatever is currently playing,
   * and anything already prepared but not yet played, is aborted right away (they will be
   * re-synthesized if their text is needed again via resume()) but their text is kept, queued
   * ahead of everything still waiting. Nothing new plays or generates until resume() or cancel().
   * `busy` stays true for as long as the run is held, so a turn paused mid-reply is never
   * mistaken for one that has finished. Returns whether anything was actually playing or
   * prepared at the moment of the hold - a caller that pauses speculatively can use this to
   * tell a real pause from a no-op.
   */
  hold(): boolean {
    const run = this.run;
    if (run.held) return false;
    const wasActive = run.playing !== null || run.generating || run.audio.length > 0;
    // Nothing playing or prepared: leave the run exactly as it is (still idle, or still simply
    // queued) rather than parking it in a held state that only resume()/cancel() can release.
    if (!wasActive) return false;
    const bufferedText = run.audio.map((phrase) => phrase.text);
    run.audio = [];
    run.text = [...bufferedText, ...run.text];
    run.playing = null;
    run.generating = false;
    run.held = true;
    // The signal shared by whatever was in flight is aborted so it stops (and its promise
    // settles) right away; a fresh controller takes over for whatever resume()/cancel() do next.
    run.controller.abort();
    run.controller = new AbortController();
    this.changed();
    return true;
  }

  /**
   * Resumes a held run: `prefixText` (typically a bridge phrase plus the sentence that was cut
   * off, or "" when there is nothing left to resume) is spoken first, then whatever was already
   * queued, in the same order it was queued. A no-op if the run is not currently held (e.g.
   * cancel() already replaced it with a fresh one).
   */
  resume(prefixText: string) {
    const run = this.run;
    if (!run.held) return;
    run.held = false;
    if (prefixText.trim()) run.text.unshift(prefixText);
    this.pump(run);
  }

  cancel() {
    const previous = this.run;
    this.run = this.fresh();
    previous.text = [];
    previous.audio = [];
    previous.controller.abort();
    this.changed();
  }

  private fresh(): Run {
    return {
      controller: new AbortController(),
      text: [],
      audio: [],
      hasDispatchedSpeech: false,
      generating: false,
      playing: null,
      held: false,
    };
  }

  private fail(run: Run, error: unknown) {
    // A hold() deliberately aborts whatever was in flight; that is not a failure.
    if (run !== this.run || run.controller.signal.aborted || run.held) return;
    this.cancel();
    this.reportError(error);
  }

  private pump(run: Run) {
    if (run !== this.run || run.controller.signal.aborted) return;
    if (run.held) { this.changed(); return; }
    const signal = run.controller.signal;

    if (!run.playing && run.audio.length) {
      const next = run.audio.shift()!;
      run.playing = next.text;
      void (async () => {
        try {
          await next.prepared(signal);
        } catch (error) {
          this.fail(run, error);
        } finally {
          run.playing = null;
          if (run === this.run) this.pump(run);
        }
      })();
    }

    // At most two phrases outstanding at once (queued/playing audio plus one request in flight):
    // the next phrase's request dispatches as soon as this one's audio starts arriving, so its
    // round trip and the backend's first byte are paid while the previous phrase is still playing,
    // instead of only after the previous phrase's whole stream has been downloaded.
    if (!run.generating && run.audio.length < 2 && run.text.length) {
      let text = run.text.shift()!;
      if (run.hasDispatchedSpeech) {
        while (run.text.length && text.length + run.text[0].length + 1 <= maxMergedSpeechChars) {
          text += ` ${run.text.shift()!}`;
        }
      }
      run.hasDispatchedSpeech = true;
      run.generating = true;
      void (async () => {
        try {
          const prepared = await this.synthesize(text, signal);
          if (run === this.run && !signal.aborted) {
            run.audio.push({ text, prepared });
          }
          // The request stays open after this point (the rest of the phrase keeps streaming); catch
          // a late failure without blocking the next phrase's request, already free to dispatch below.
          prepared.completed?.catch((error) => this.fail(run, error));
        } catch (error) {
          this.fail(run, error);
        } finally {
          run.generating = false;
          if (run === this.run) this.pump(run);
        }
      })();
    }

    this.changed();
  }
}
