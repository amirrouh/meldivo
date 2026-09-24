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
};

export const speculativeSttGraceMs = 350;

/** Reuse a current Whisper hypothesis when it covers the final spoken frame. */
export class LiveTranscription {
  private preRoll: Float32Array[] = [];
  private current: Segment | null = null;
  private segments = new Set<Segment>();
  private ended = new WeakMap<Float32Array, Segment>();
  private request: (samples: Float32Array, signal: AbortSignal) => Promise<string>;
  private preview: (text: string) => void;

  constructor(
    request: (samples: Float32Array, signal: AbortSignal) => Promise<string>,
    preview: (text: string) => void,
  ) {
    this.request = request;
    this.preview = preview;
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
    if (probability >= 0.35) {
      segment.revision++;
      segment.quiet = 0;
    } else {
      segment.quiet++;
    }

    // Refresh at a pause or about every two seconds of 32 ms Silero frames.
    if (
      segment.confirmed &&
      !segment.pending &&
      segment.requested !== segment.revision &&
      (segment.quiet >= 6 || segment.frames.length - segment.lastRequest >= 63)
    ) {
      this.speculate(segment);
    }
  }

  begin() {
    const segment: Segment = {
      frames: this.preRoll,
      revision: 1,
      quiet: 0,
      confirmed: false,
      requested: -1,
      lastRequest: 0,
      controller: new AbortController(),
    };
    this.preRoll = [];
    this.current = segment;
    this.segments.add(segment);
    this.preview("");
  }

  confirm() {
    if (this.current) this.current.confirmed = true;
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

  private speculate(segment: Segment) {
    const revision = segment.revision;
    segment.requested = revision;
    segment.lastRequest = segment.frames.length;
    segment.pending = this.request(this.samples(segment), segment.controller.signal)
      .then((text) => {
        if (segment.controller.signal.aborted) return;
        segment.result = { revision, text };
        if (this.current === segment) this.preview(text);
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
