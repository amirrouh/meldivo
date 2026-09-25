/**
 * Drop-in energy-based fallback for @ricky0123/vad-web's MicVAD.
 *
 * Silero (onnxruntime-web) can fail to initialize on real devices after many
 * reloads/tabs (observed on macOS Safari: "no available backend found...
 * RangeError: Out of memory"). When that happens the page must not keep the
 * user in a silent "listening" state — it falls back to this simple
 * energy/RMS detector, which drives the exact same callback contract
 * (onSpeechStart / onSpeechRealStart / onFrameProcessed / onSpeechEnd /
 * onVADMisfire) so the rest of the app (barge-in guard, echo guard, live
 * transcription, input coordinator) needs no changes.
 *
 * The frame-level decision logic lives in `EnergyFrameProcessor`, which is
 * plain data in/data out and has no dependency on Web Audio - it is unit
 * tested directly. `EnergyVad` is the thin Web Audio wrapper: it captures
 * the mic, resamples to 16 kHz (matching Silero's contract), and feeds
 * fixed-size frames into the processor.
 */

import {
  vadMinSpeechMs,
  vadNegativeSpeechThreshold,
  vadPositiveSpeechThreshold,
  vadPreSpeechPadMs,
  vadRedemptionMs,
} from "./vad-config";

// Match Silero v5's frame contract: 512 samples @ 16 kHz == 32 ms/frame.
export const energyFrameSamples = 512;
export const energySampleRate = 16_000;
const defaultMaxSpeechMs = 20_000;

export interface EnergyFrameProcessorOptions {
  frameSamples?: number;
  sampleRate?: number;
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechMs?: number;
  redemptionMs?: number;
  preSpeechPadMs?: number;
  maxSpeechMs?: number;
  /** Trailing window (in frames) used to estimate the ambient noise floor. */
  noiseFloorWindowFrames?: number;
  /** Percentile (0..1) of the trailing RMS window used as the floor estimate. */
  noiseFloorPercentile?: number;
  /** dB above the floor before a frame starts counting as "maybe speech". */
  noiseFloorMarginDb?: number;
  /** dB range mapped to a 0..1 probability, starting at floor + margin. */
  noiseFloorRangeDb?: number;
  /** Absolute RMS floor so pure digital silence never falsely triggers. */
  minFloorRms?: number;
  submitUserSpeechOnPause?: boolean;
}

type ResolvedOptions = Required<EnergyFrameProcessorOptions>;

const defaultOptions: ResolvedOptions = {
  frameSamples: energyFrameSamples,
  sampleRate: energySampleRate,
  positiveSpeechThreshold: vadPositiveSpeechThreshold,
  negativeSpeechThreshold: vadNegativeSpeechThreshold,
  minSpeechMs: vadMinSpeechMs,
  redemptionMs: vadRedemptionMs,
  preSpeechPadMs: vadPreSpeechPadMs,
  maxSpeechMs: defaultMaxSpeechMs,
  noiseFloorWindowFrames: 100, // ~3.2s of trailing silence at 32ms/frame.
  noiseFloorPercentile: 0.3,
  noiseFloorMarginDb: 6,
  noiseFloorRangeDb: 24,
  minFloorRms: 0.0015,
  submitUserSpeechOnPause: false,
};

export type EnergyVadEvent =
  | { type: "speech-start" }
  | { type: "speech-real-start" }
  | { type: "misfire" }
  | { type: "speech-end"; samples: Float32Array };

export interface EnergyFrameResult {
  probability: number;
  events: EnergyVadEvent[];
}

function computeRms(frame: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < frame.length; index++) sum += frame[index] * frame[index];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

function toDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-8));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function concatFrames(frames: Float32Array[]): Float32Array {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

/**
 * Pure frame-by-frame speech detector: RMS energy against an adaptively
 * tracked noise floor, with hysteresis (separate positive/negative
 * thresholds), minimum speech duration, redemption (grace period before
 * confirming speech end), pre-speech padding and a max-segment safety cap.
 * No Web Audio, no timers - contains no wall-clock state, so it is
 * straightforward to unit test with synthetic frames.
 */
export class EnergyFrameProcessor {
  private options: ResolvedOptions;
  private msPerFrame: number;
  private minSpeechFrames = 1;
  private redemptionFrames = 1;
  private preSpeechPadFrames = 0;
  private maxSpeechFrames = 1;

  private state: "silence" | "maybe" | "speech" = "silence";
  private ring: Float32Array[] = [];
  private recorded: Float32Array[] = [];
  private activeFrames = 0;
  private silenceFrames = 0;
  private noiseFloorSamples: number[] = [];
  private active = true;

  constructor(options: EnergyFrameProcessorOptions = {}) {
    this.options = { ...defaultOptions, ...options };
    this.msPerFrame = (this.options.frameSamples / this.options.sampleRate) * 1000;
    this.recalculateFrameCounts();
  }

  private recalculateFrameCounts() {
    this.minSpeechFrames = Math.max(1, Math.ceil(this.options.minSpeechMs / this.msPerFrame));
    this.redemptionFrames = Math.max(1, Math.ceil(this.options.redemptionMs / this.msPerFrame));
    this.preSpeechPadFrames = Math.max(0, Math.ceil(this.options.preSpeechPadMs / this.msPerFrame));
    this.maxSpeechFrames = Math.max(this.minSpeechFrames, Math.ceil(this.options.maxSpeechMs / this.msPerFrame));
  }

  setOptions(update: Partial<EnergyFrameProcessorOptions>) {
    this.options = { ...this.options, ...update };
    this.recalculateFrameCounts();
  }

  /** Noise-floor estimate for tests/inspection: trailing-window percentile of silence RMS. */
  get noiseFloor(): number {
    return this.estimateNoiseFloor();
  }

  get speaking(): boolean {
    return this.state === "speech";
  }

  reset() {
    this.state = "silence";
    this.ring = [];
    this.recorded = [];
    this.activeFrames = 0;
    this.silenceFrames = 0;
  }

  resume() {
    this.active = true;
  }

  /** Mirrors MicVAD's pause contract: either flush the in-progress segment or discard it. */
  pause(): EnergyVadEvent[] {
    this.active = false;
    if (this.options.submitUserSpeechOnPause) return this.endSegment();
    this.reset();
    return [];
  }

  /** Force-conclude whatever segment is in progress (used by pause() and max-length safety). */
  endSegment(): EnergyVadEvent[] {
    const events: EnergyVadEvent[] = [];
    if (this.state === "speech") {
      events.push({ type: "speech-end", samples: concatFrames(this.recorded) });
    } else if (this.state === "maybe") {
      events.push({ type: "misfire" });
    }
    this.reset();
    return events;
  }

  process(frame: Float32Array): EnergyFrameResult {
    if (!this.active) return { probability: 0, events: [] };

    const rms = computeRms(frame);
    if (this.state === "silence") this.pushNoiseFloorSample(rms);
    const floor = this.estimateNoiseFloor();
    const probability = clamp01(
      (toDb(rms) - toDb(floor) - this.options.noiseFloorMarginDb) / this.options.noiseFloorRangeDb,
    );
    const events: EnergyVadEvent[] = [];

    if (this.state === "silence") {
      this.pushRing(frame);
      if (probability >= this.options.positiveSpeechThreshold) {
        this.state = "maybe";
        this.recorded = [...this.ring];
        this.activeFrames = 1;
        this.silenceFrames = 0;
        events.push({ type: "speech-start" });
      }
      return { probability, events };
    }

    this.recorded.push(frame);
    const stillActive = probability >= this.options.negativeSpeechThreshold;
    if (stillActive) {
      this.silenceFrames = 0;
      this.activeFrames++;
      if (this.state === "maybe" && this.activeFrames >= this.minSpeechFrames) {
        this.state = "speech";
        events.push({ type: "speech-real-start" });
      }
    } else {
      this.silenceFrames++;
    }

    const forcedEnd = this.recorded.length >= this.maxSpeechFrames;
    const redeemedEnd = this.silenceFrames >= this.redemptionFrames;
    if (forcedEnd || redeemedEnd) {
      events.push(...this.endSegment());
    }
    return { probability, events };
  }

  private pushRing(frame: Float32Array) {
    this.ring.push(frame);
    if (this.ring.length > this.preSpeechPadFrames) this.ring.shift();
  }

  private pushNoiseFloorSample(rms: number) {
    this.noiseFloorSamples.push(rms);
    if (this.noiseFloorSamples.length > this.options.noiseFloorWindowFrames) this.noiseFloorSamples.shift();
  }

  private estimateNoiseFloor(): number {
    if (this.noiseFloorSamples.length === 0) return this.options.minFloorRms;
    const sorted = [...this.noiseFloorSamples].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * this.options.noiseFloorPercentile));
    return Math.max(this.options.minFloorRms, sorted[index]);
  }
}

/**
 * Box-average downsampler, ported from vad-web's own Resampler so the
 * fallback produces the same 16 kHz / fixed-size frame contract. Pure and
 * stateless aside from a small carry-over buffer, so it is unit testable
 * without Web Audio.
 */
export class BoxResampler {
  private inputBuffer: number[] = [];
  constructor(
    private readonly nativeSampleRate: number,
    private readonly targetSampleRate: number,
    private readonly targetFrameSize: number,
  ) {}

  process(chunk: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    for (const sample of chunk) {
      this.inputBuffer.push(sample);
      while (this.hasEnoughDataForFrame()) frames.push(this.generateOutputFrame());
    }
    return frames;
  }

  private hasEnoughDataForFrame(): boolean {
    return (this.inputBuffer.length * this.targetSampleRate) / this.nativeSampleRate >= this.targetFrameSize;
  }

  private generateOutputFrame(): Float32Array {
    const outputFrame = new Float32Array(this.targetFrameSize);
    let outputIndex = 0;
    let inputIndex = 0;
    while (outputIndex < this.targetFrameSize) {
      let sum = 0;
      let count = 0;
      const limit = Math.min(
        this.inputBuffer.length,
        ((outputIndex + 1) * this.nativeSampleRate) / this.targetSampleRate,
      );
      while (inputIndex < limit) {
        const value = this.inputBuffer[inputIndex];
        if (value !== undefined) {
          sum += value;
          count++;
        }
        inputIndex++;
      }
      outputFrame[outputIndex] = count > 0 ? sum / count : 0;
      outputIndex++;
    }
    this.inputBuffer = this.inputBuffer.slice(inputIndex);
    return outputFrame;
  }
}

// Self-contained AudioWorkletProcessor source (a separate JS global scope -
// it cannot import BoxResampler, so the same box-average algorithm is
// duplicated inline here).
const workletSource = `
class EnergyVadWorkletProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions.targetSampleRate;
    this.targetFrameSize = options.processorOptions.targetFrameSize;
    this.inputBuffer = [];
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.inputBuffer.push(channel[i]);
      while ((this.inputBuffer.length * this.targetSampleRate) / sampleRate >= this.targetFrameSize) {
        const frame = new Float32Array(this.targetFrameSize);
        let outputIndex = 0;
        let inputIndex = 0;
        while (outputIndex < this.targetFrameSize) {
          let sum = 0;
          let count = 0;
          const limit = Math.min(this.inputBuffer.length, ((outputIndex + 1) * sampleRate) / this.targetSampleRate);
          while (inputIndex < limit) {
            const value = this.inputBuffer[inputIndex];
            if (value !== undefined) { sum += value; count++; }
            inputIndex++;
          }
          frame[outputIndex] = count > 0 ? sum / count : 0;
          outputIndex++;
        }
        this.inputBuffer = this.inputBuffer.slice(inputIndex);
        this.port.postMessage(frame);
      }
    }
    return true;
  }
}
registerProcessor("energy-vad-worklet-processor", EnergyVadWorkletProcessor);
`;

export interface EnergyVadOptions {
  audioContext: AudioContext;
  getStream: () => Promise<MediaStream>;
  pauseStream?: (stream: MediaStream) => Promise<void>;
  resumeStream?: (stream: MediaStream) => Promise<MediaStream>;
  positiveSpeechThreshold?: number;
  negativeSpeechThreshold?: number;
  minSpeechMs?: number;
  preSpeechPadMs?: number;
  redemptionMs?: number;
  maxSpeechMs?: number;
  submitUserSpeechOnPause?: boolean;
  onSpeechStart: () => void;
  onSpeechRealStart: () => void;
  onVADMisfire: () => void;
  onFrameProcessed: (probabilities: { isSpeech: number; notSpeech: number }, frame: Float32Array) => void;
  onSpeechEnd: (samples: Float32Array) => void;
}

type InitState = "uninitialized" | "initializing" | "initialized" | "destroyed" | "errored";

/**
 * Web Audio wrapper around EnergyFrameProcessor. Mirrors MicVAD's
 * lifecycle/API surface closely enough to be a drop-in replacement for the
 * subset of MicVAD used by the app: start(), pause(), destroy(),
 * setOptions(), plus the same callback contract.
 */
export class EnergyVad {
  private readonly options: EnergyVadOptions;
  private readonly processor: EnergyFrameProcessor;
  private initState: InitState = "uninitialized";
  private stream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private workletModuleUrl: string | null = null;
  listening = false;

  private constructor(options: EnergyVadOptions) {
    this.options = options;
    this.processor = new EnergyFrameProcessor({
      positiveSpeechThreshold: options.positiveSpeechThreshold,
      negativeSpeechThreshold: options.negativeSpeechThreshold,
      minSpeechMs: options.minSpeechMs,
      preSpeechPadMs: options.preSpeechPadMs,
      redemptionMs: options.redemptionMs,
      maxSpeechMs: options.maxSpeechMs,
      submitUserSpeechOnPause: options.submitUserSpeechOnPause ?? false,
    });
  }

  static async new(options: EnergyVadOptions): Promise<EnergyVad> {
    return new EnergyVad(options);
  }

  private handleFrame = (frame: Float32Array) => {
    const result = this.processor.process(frame);
    this.options.onFrameProcessed({ isSpeech: result.probability, notSpeech: 1 - result.probability }, frame);
    for (const event of result.events) this.dispatch(event);
  };

  private dispatch(event: EnergyVadEvent) {
    switch (event.type) {
      case "speech-start":
        this.options.onSpeechStart();
        return;
      case "speech-real-start":
        this.options.onSpeechRealStart();
        return;
      case "misfire":
        this.options.onVADMisfire();
        return;
      case "speech-end":
        this.options.onSpeechEnd(event.samples);
        return;
    }
  }

  private async attachAudioGraph() {
    const context = this.options.audioContext;
    const stream = this.stream;
    if (!stream) throw new Error("Energy VAD has no active microphone stream.");
    this.sourceNode = new MediaStreamAudioSourceNode(context, { mediaStream: stream });
    if (this.canUseAudioWorklet(context)) {
      try {
        await this.attachAsWorklet(context);
        this.sourceNode.connect(this.workletNode!);
        return;
      } catch {
        // Fall through to ScriptProcessor below.
        this.workletNode = null;
      }
    }
    this.attachAsScriptProcessor(context);
    this.sourceNode.connect(this.scriptNode!);
  }

  private canUseAudioWorklet(context: AudioContext): boolean {
    return "audioWorklet" in context && typeof AudioWorkletNode === "function";
  }

  private async attachAsWorklet(context: AudioContext) {
    if (!this.workletModuleUrl) {
      const blob = new Blob([workletSource], { type: "application/javascript" });
      this.workletModuleUrl = URL.createObjectURL(blob);
    }
    await context.audioWorklet.addModule(this.workletModuleUrl);
    this.workletNode = new AudioWorkletNode(context, "energy-vad-worklet-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: { targetSampleRate: energySampleRate, targetFrameSize: energyFrameSamples },
    });
    this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.handleFrame(event.data);
    };
  }

  private attachAsScriptProcessor(context: AudioContext) {
    const resampler = new BoxResampler(context.sampleRate, energySampleRate, energyFrameSamples);
    const bufferSize = 4096;
    const node = context.createScriptProcessor(bufferSize, 1, 1);
    let busy = false;
    node.onaudioprocess = (event: AudioProcessingEvent) => {
      if (busy) return;
      busy = true;
      try {
        const input = event.inputBuffer.getChannelData(0);
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);
        for (const frame of resampler.process(input)) this.handleFrame(frame);
      } finally {
        busy = false;
      }
    };
    // A ScriptProcessorNode only runs while connected to a destination; the
    // output is explicitly silenced above so nothing audible passes through.
    node.connect(context.destination);
    this.scriptNode = node;
  }

  private detachAudioGraph() {
    this.sourceNode?.disconnect();
    this.sourceNode = null;
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.scriptNode) {
      this.scriptNode.onaudioprocess = null;
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
  }

  start = async (): Promise<void> => {
    switch (this.initState) {
      case "uninitialized": {
        this.initState = "initializing";
        this.processor.resume();
        try {
          this.stream = await this.options.getStream();
          await this.attachAudioGraph();
          this.listening = true;
          this.initState = "initialized";
        } catch (error) {
          this.initState = "errored";
          throw error;
        }
        return;
      }
      case "initialized": {
        if (this.listening) return;
        this.processor.resume();
        this.stream = this.options.resumeStream ? await this.options.resumeStream(this.stream!) : this.stream;
        await this.attachAudioGraph();
        this.listening = true;
        return;
      }
      default:
        return;
    }
  };

  pause = async (): Promise<void> => {
    if (!this.listening) return;
    this.listening = false;
    const events = this.processor.pause();
    for (const event of events) this.dispatch(event);
    if (this.stream && this.options.pauseStream) await this.options.pauseStream(this.stream);
    this.detachAudioGraph();
  };

  destroy = async (): Promise<void> => {
    if (this.initState === "destroyed") return;
    if (this.listening) await this.pause();
    this.initState = "destroyed";
    if (this.workletModuleUrl) {
      URL.revokeObjectURL(this.workletModuleUrl);
      this.workletModuleUrl = null;
    }
  };

  setOptions = (update: Partial<EnergyFrameProcessorOptions>): void => {
    this.processor.setOptions(update);
  };
}
