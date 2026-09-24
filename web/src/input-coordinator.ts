export type VoiceRecording = {
  samples: Float32Array;
  possibleEcho?: string;
};

type Transcribe = (recording: VoiceRecording, signal: AbortSignal) => Promise<string>;
type Send = (text: string) => Promise<void>;

/**
 * Keeps capture independent from assistant cancellation. A resumed utterance
 * never discards an already-running transcription; completed text waits until
 * the user has stopped speaking and every captured recording is transcribed.
 */
export class VoiceInputCoordinator {
  private recordings: VoiceRecording[] = [];
  private transcripts: string[] = [];
  private hearing = false;
  private pumpingEpoch: number | null = null;
  private active: AbortController | null = null;
  private epoch = 0;
  private transcribe: Transcribe;
  private send: Send;
  private report: (error: unknown) => void;
  private changed: () => void;

  constructor(
    transcribe: Transcribe,
    send: Send,
    report: (error: unknown) => void = () => {},
    changed: () => void = () => {},
  ) {
    this.transcribe = transcribe;
    this.send = send;
    this.report = report;
    this.changed = changed;
  }

  get busy() {
    return this.pumpingEpoch !== null || this.recordings.length > 0 || this.transcripts.length > 0;
  }

  speechStarted() {
    this.hearing = true;
    this.changed();
  }

  speechEnded(recording: VoiceRecording) {
    this.hearing = false;
    this.recordings.push(recording);
    this.changed();
    this.pump();
  }

  speechDiscarded() {
    this.hearing = false;
    this.changed();
    this.pump();
  }

  reset() {
    this.epoch++;
    this.active?.abort();
    this.active = null;
    this.recordings = [];
    this.transcripts = [];
    this.hearing = false;
    this.pumpingEpoch = null;
    this.changed();
  }

  private pump() {
    const epoch = this.epoch;
    if (this.pumpingEpoch === epoch) return;
    this.pumpingEpoch = epoch;
    this.changed();
    void (async () => {
      try {
        while (this.recordings.length && epoch === this.epoch) {
          const recording = this.recordings.shift()!;
          const controller = new AbortController();
          this.active = controller;
          try {
            const transcript = (await this.transcribe(recording, controller.signal)).trim();
            if (epoch === this.epoch && transcript) this.transcripts.push(transcript);
          } catch (error) {
            if (epoch === this.epoch && !controller.signal.aborted) throw error;
          } finally {
            if (this.active === controller) this.active = null;
            if (epoch === this.epoch) this.changed();
          }
        }

        if (epoch !== this.epoch || this.hearing || this.recordings.length || !this.transcripts.length) return;
        const text = this.transcripts.join(" ").trim();
        this.transcripts = [];
        this.changed();
        if (text) await this.send(text);
      } catch (error) {
        if (epoch === this.epoch) this.report(error);
      } finally {
        if (this.pumpingEpoch === epoch) {
          this.pumpingEpoch = null;
          this.changed();
          if (epoch === this.epoch && (!this.hearing && (this.recordings.length || this.transcripts.length))) this.pump();
        }
      }
    })();
  }
}

type VadDriver = {
  pause: () => Promise<void>;
  start: () => Promise<void>;
};

export const vadTransitionTimeoutMs = 2_000;

/**
 * Serialize VAD source disconnect/reconnect so pause cannot detach a new source.
 * A driver operation is bounded: a stalled old session cannot hold the queue forever.
 */
export class SerializedVadTransitions {
  private tail = Promise.resolve();
  private _active = false;
  private _flushing = false;
  private epoch = 0;
  private timeoutMs: number;
  private invalid = new WeakSet<VadDriver>();

  constructor(timeoutMs = vadTransitionTimeoutMs) {
    this.timeoutMs = timeoutMs;
  }

  get acceptsCallbacks() {
    return this._active || this._flushing;
  }

  pause(vad: VadDriver) {
    if (this.invalid.has(vad)) return Promise.reject(new Error("VAD transition is invalidated."));
    const epoch = this.epoch;
    this._active = false;
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      await this.withTimeout(vad, vad.pause(), "pause");
    });
  }

  start(vad: VadDriver) {
    if (this.invalid.has(vad)) return Promise.reject(new Error("VAD transition is invalidated."));
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      await this.withTimeout(vad, vad.start(), "start");
      if (epoch === this.epoch) this._active = true;
    });
  }

  flush(vad: VadDriver) {
    if (this.invalid.has(vad)) return Promise.reject(new Error("VAD transition is invalidated."));
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      this._flushing = true;
      try {
        await this.withTimeout(vad, vad.pause(), "pause");
        await this.withTimeout(vad, vad.start(), "start");
        if (epoch === this.epoch) this._active = true;
      } finally {
        if (epoch === this.epoch) this._flushing = false;
      }
    });
  }

  beginSession() {
    this.epoch++;
    this.tail = Promise.resolve();
    this._active = false;
    this._flushing = false;
  }

  deactivate() {
    this.epoch++;
    this.tail = Promise.resolve();
    this._active = false;
    this._flushing = false;
  }

  isInvalid(vad: VadDriver) {
    return this.invalid.has(vad);
  }

  private enqueue(operation: () => Promise<void>) {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private withTimeout(vad: VadDriver, operation: Promise<void>, name: string) {
    return new Promise<void>((resolve, reject) => {
      const timeout = globalThis.setTimeout(() => {
        // A timed-out pause/start can later settle and mutate its old audio
        // graph. Never issue another operation to that detector instance.
        this.invalidate(vad);
        reject(new Error(`VAD ${name} timed out.`));
      }, this.timeoutMs);
      void operation.then(
        () => { globalThis.clearTimeout(timeout); resolve(); },
        (error) => { globalThis.clearTimeout(timeout); reject(error); },
      );
    });
  }

  private invalidate(vad: VadDriver) {
    this.invalid.add(vad);
    this.epoch++;
    this.tail = Promise.resolve();
    this._active = false;
    this._flushing = false;
  }
}

/** Kept pure so stale worklet callbacks can be tested without browser audio. */
export function isCurrentVoiceSession(
  currentEpoch: number,
  callbackEpoch: number,
  currentVad: unknown,
  callbackVad: unknown,
  muted: boolean,
  acceptsCallbacks: boolean,
) {
  return currentEpoch === callbackEpoch
    && currentVad === callbackVad
    && !muted
    && acceptsCallbacks;
}
