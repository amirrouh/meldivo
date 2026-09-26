import type { PreparedSpeech } from "./speech-pipeline";

export function prepareAudioBuffer(
  buffer: AudioBuffer,
  audio: AudioContext,
  destination: AudioNode,
  onStarted: (analyser: AnalyserNode) => void,
): PreparedSpeech {
  return async (signal) => {
    signal.throwIfAborted();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 128;
    analyser.connect(destination);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        source.onended = null;
        try { source.stop(); } catch { /* already stopped */ }
        source.disconnect();
        analyser.disconnect();
        reject(signal.reason);
      };
      source.onended = () => {
        signal.removeEventListener("abort", cancel);
        source.disconnect();
        analyser.disconnect();
        resolve();
      };
      signal.addEventListener("abort", cancel, { once: true });
      source.start();
      onStarted(analyser);
      if (signal.aborted) cancel();
    });
  };
}

// How far ahead of "now" streamed audio is scheduled, to absorb network jitter between chunks.
const STREAM_LEAD_SECONDS = 0.1;

/**
 * Plays raw 16-bit mono PCM while it is still arriving. Resolves once the first audio has come
 * in, so playback can start before the phrase has finished generating; `completed` settles when
 * the whole phrase has been received.
 */
export async function prepareAudioStream(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  audio: AudioContext,
  destination: AudioNode,
  onStarted: (analyser: AnalyserNode) => void,
  fetchSignal: AbortSignal,
): Promise<PreparedSpeech> {
  const reader = body.getReader();
  const pending: Float32Array[] = [];
  let carry: number | null = null;
  let ended = false;
  let received = 0;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  const cancelRead = () => { void reader.cancel().catch(() => undefined); };
  fetchSignal.addEventListener("abort", cancelRead, { once: true });

  const toFloat = (chunk: Uint8Array): Float32Array => {
    let bytes = chunk;
    if (carry !== null) {
      bytes = new Uint8Array(chunk.length + 1);
      bytes[0] = carry;
      bytes.set(chunk, 1);
      carry = null;
    }
    if (bytes.length % 2) {
      carry = bytes[bytes.length - 1]!;
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Float32Array(bytes.length / 2);
    for (let i = 0; i < out.length; i++) {
      const value = view.getInt16(i * 2, true);
      out[i] = value < 0 ? value / 32_768 : value / 32_767;
    }
    return out;
  };

  let firstAudio!: () => void;
  let firstFailed!: (error: unknown) => void;
  const first = new Promise<void>((resolve, reject) => { firstAudio = resolve; firstFailed = reject; });
  const completed = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const samples = toFloat(value);
        if (!samples.length) continue;
        received += samples.length;
        pending.push(samples);
        firstAudio();
        notify();
      }
      if (!received) throw new Error("The speech server sent no audio");
    } finally {
      ended = true;
      fetchSignal.removeEventListener("abort", cancelRead);
      notify();
    }
  })();
  completed.catch((error) => firstFailed(error));
  completed.then(() => firstAudio(), () => undefined);
  await first;

  const play = (async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 128;
    analyser.connect(destination);
    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = 0;
    let started = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const finishIfDone = () => {
          if (ended && !pending.length && !sources.size) resolve();
        };
        const drain = () => {
          if (signal.aborted) return;
          if (pending.length) {
            // Merge whatever arrived since the last pass into one buffer, so tiny network chunks don't click.
            const length = pending.reduce((sum, part) => sum + part.length, 0);
            const buffer = audio.createBuffer(1, length, sampleRate);
            const channel = buffer.getChannelData(0);
            let offset = 0;
            for (const part of pending.splice(0)) { channel.set(part, offset); offset += part.length; }
            const source = audio.createBufferSource();
            source.buffer = buffer;
            source.connect(analyser);
            // After an underrun, restart just ahead of now instead of scheduling in the past.
            nextTime = Math.max(nextTime, audio.currentTime + (started ? 0.02 : STREAM_LEAD_SECONDS));
            source.start(nextTime);
            nextTime += buffer.duration;
            sources.add(source);
            source.onended = () => {
              sources.delete(source);
              source.disconnect();
              finishIfDone();
            };
            if (!started) {
              started = true;
              onStarted(analyser);
            }
          }
          finishIfDone();
          if (!ended || pending.length) wake = drain;
        };
        const cancel = () => {
          wake = null;
          for (const source of sources) {
            source.onended = null;
            try { source.stop(); } catch { /* already stopped */ }
            source.disconnect();
          }
          sources.clear();
          cancelRead();
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        drain();
      });
    } finally {
      analyser.disconnect();
    }
  }) as PreparedSpeech;
  play.completed = completed;
  return play;
}
