import { shouldEndpointEarly } from "./endpointing";
import { vadPositiveSpeechThreshold } from "./vad-config";

type Segment = {
  frames: Float32Array[];
  revision: number;
  quiet: number;
  confirmed: boolean;
  requested: number;
  lastRequest: number;
  controller: AbortController;
  pending?: Promise<void>;
  result?: { revision: number; text: string };
  endpointed: boolean;
  /** Began while a reply was already playing: the first speculation is worth rushing (see fastSpeculationFrames). */
  overActiveTurn: boolean;
  /** Frame count at the moment confirm() was called, or null before that. */
  confirmedAt: number | null;
};

export const speculativeSttGraceMs = 350;

/**
 * When a segment starts over an active reply, the first speculative request does not wait
 * for the usual quiet-frame or two-second timeout: a barge-in decision needs a preview far
 * sooner, so it goes out this many frames (~0.65 s of 32 ms Silero frames) after confirm.
 */
export const fastSpeculationFrames = 20;

/** Reuse a current Whisper hypothesis when it covers the final spoken frame. */
export class LiveTranscription {
  private preRoll: Float32Array[] = [];
  private current: Segment | null = null;
  private segments = new Set<Segment>();
  private ended = new WeakMap<Float32Array, Segment>();
  private request: (samples: Float32Array, signal: AbortSignal) => Promise<string>;
  private preview: (text: string) => void;
  private endpoint: () => void;
  /**
   * A frame at or above this probability is new speech and invalidates the current hypothesis.
   * It must match the level at which the detector itself extends speech: Silero's positive
   * threshold, or the energy fallback's negative threshold (which keeps its segment alive).
   */
  speechThreshold = vadPositiveSpeechThreshold;

  constructor(
    request: (samples: Float32Array, signal: AbortSignal) => Promise<string>,
    preview: (text: string) => void,
    endpoint: () => void = () => {},
  ) {
    this.request = request;
    this.preview = preview;
    this.endpoint = endpoint;
  }

  frame(probability: number, samples: Float32Array) {
    const frame = samples.slice();
    const segment = this.current;
    if (!segment) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 14) this.preRoll.shift();
      return;
    }

    segment.frames.push(frame);
    if (probability >= this.speechThreshold) {
      segment.revision++;
      segment.quiet = 0;
    } else {
      segment.quiet++;
    }

    // The very first speculation of a segment that began over an active reply is rushed:
    // a barge-in decision cannot wait out the normal quiet/timeout schedule.
    const dueForFastFirstSpeculation = (
      segment.confirmed && segment.overActiveTurn && segment.requested === -1 && segment.confirmedAt !== null
      && segment.frames.length - segment.confirmedAt >= fastSpeculationFrames
    );
    // Refresh at a pause or about every two seconds of 32 ms Silero frames.
    if (
      segment.confirmed &&
      !segment.pending &&
      segment.requested !== segment.revision &&
      (dueForFastFirstSpeculation || segment.quiet >= 6 || segment.frames.length - segment.lastRequest >= 63)
    ) {
      this.speculate(segment);
    }
    this.checkEndpoint(segment);
  }

  begin(overActiveTurn = false) {
    const segment: Segment = {
      frames: this.preRoll,
      revision: 1,
      quiet: 0,
      confirmed: false,
      requested: -1,
      lastRequest: 0,
      controller: new AbortController(),
      endpointed: false,
      overActiveTurn,
      confirmedAt: null,
    };
    this.preRoll = [];
    this.current = segment;
    this.segments.add(segment);
    this.preview("");
  }

  confirm() {
    if (this.current) {
      this.current.confirmed = true;
      this.current.confirmedAt = this.current.frames.length;
    }
  }

  end(samples: Float32Array) {
    if (this.current) this.ended.set(samples, this.current);
    this.current = null;
    this.preRoll = [];
  }

  async finish(samples: Float32Array, signal: AbortSignal): Promise<string> {
    const segment = this.ended.get(samples);
    this.ended.delete(samples);
    if (!segment) return this.request(samples, signal);

    const cancel = () => segment.controller.abort(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      const pending = segment.pending;
      if (pending && !await settlesWithin(pending, speculativeSttGraceMs, signal)) {
        // A local STT worker may retain a disconnected preview indefinitely.
        // Do not make the final user turn hostage to that request.
        segment.controller.abort(new DOMException("Speculative transcription timed out.", "AbortError"));
      }
      signal.throwIfAborted();
      if (segment.result?.revision === segment.revision && segment.result.text.trim()) {
        return segment.result.text;
      }
      return await this.request(samples, signal);
    } finally {
      signal.removeEventListener("abort", cancel);
      this.segments.delete(segment);
    }
  }

  discard() {
    if (this.current) {
      this.current.controller.abort();
      this.segments.delete(this.current);
    }
    this.current = null;
    this.preRoll = [];
    this.preview("");
  }

  reset() {
    for (const segment of this.segments) segment.controller.abort();
    this.segments.clear();
    this.ended = new WeakMap();
    this.discard();
  }

  private samples(segment: Segment) {
    const samples = new Float32Array(segment.frames.reduce((sum, frame) => sum + frame.length, 0));
    let offset = 0;
    for (const frame of segment.frames) {
      samples.set(frame, offset);
      offset += frame.length;
    }
    return samples;
  }

  // Asks the caller, once per segment, to end the utterance now: the current hypothesis is a
  // finished sentence covering all speech so far, and the user has paused long enough.
  private checkEndpoint(segment: Segment) {
    if (segment.endpointed || this.current !== segment || !segment.confirmed) return;
    if (!shouldEndpointEarly({
      text: segment.result?.text,
      resultRevision: segment.result?.revision,
      revision: segment.revision,
      quietFrames: segment.quiet,
    })) return;
    segment.endpointed = true;
    this.endpoint();
  }

  private speculate(segment: Segment) {
    const revision = segment.revision;
    segment.requested = revision;
    segment.lastRequest = segment.frames.length;
    segment.pending = this.request(this.samples(segment), segment.controller.signal)
      .then((text) => {
        if (segment.controller.signal.aborted) return;
        segment.result = { revision, text };
        if (this.current === segment) {
          this.preview(text);
          this.checkEndpoint(segment);
        }
      })
      .catch(() => {
        // The authoritative request at speech end retries a failed preview.
      })
      .finally(() => {
        segment.pending = undefined;
      });
  }
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timeout = globalThis.setTimeout(done, timeoutMs);
    const aborted = () => { cleanup(); reject(signal.reason); };
    const settled = () => { cleanup(); resolve(true); };
    function done() { cleanup(); resolve(false); }
    function cleanup() {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
    }
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(settled, settled);
  });
}
