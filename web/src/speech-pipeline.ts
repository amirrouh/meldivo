export type PreparedSpeech = ((signal: AbortSignal) => Promise<void>) & {
  completed?: Promise<void>;
};

type Run = {
  controller: AbortController;
  text: string[];
  audio: PreparedSpeech[];
  hasDispatchedSpeech: boolean;
  generating: boolean;
  playing: boolean;
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
    return run.generating || run.playing || run.text.length > 0 || run.audio.length > 0;
  }

  enqueue(text: string[]) {
    this.run.text.push(...text);
    this.pump(this.run);
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
      playing: false,
    };
  }

  private fail(run: Run, error: unknown) {
    if (run !== this.run || run.controller.signal.aborted) return;
    this.cancel();
    this.reportError(error);
  }

  private pump(run: Run) {
    if (run !== this.run || run.controller.signal.aborted) return;
    const signal = run.controller.signal;

    if (!run.playing && run.audio.length) {
      const play = run.audio.shift()!;
      run.playing = true;
      void (async () => {
        try {
          await play(signal);
        } catch (error) {
          this.fail(run, error);
        } finally {
          run.playing = false;
          if (run === this.run) this.pump(run);
        }
      })();
    }

    // Keep synthesis serial while playback runs to preserve voice continuity.
    if (!run.generating && run.audio.length < 2 && run.text.length) {
      let text = run.text.shift()!;
      if (run.hasDispatchedSpeech) {
        while (run.text.length && text.length + run.text[0].length + 1 <= 600) {
          text += ` ${run.text.shift()!}`;
        }
      }
      run.hasDispatchedSpeech = true;
      run.generating = true;
      void (async () => {
        try {
          const prepared = await this.synthesize(text, signal);
          if (run === this.run && !signal.aborted) {
            run.audio.push(prepared);
            this.pump(run);
          }
          await prepared.completed;
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
