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
    // A gain node just for the fade: a barge-in pause (SpeechPipeline.hold()) aborts this like
    // any other cutoff, and must stop the source with a short ramp rather than an instant click.
    const gain = audio.createGain();
    gain.connect(analyser);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    await new Promise<void>((resolve, reject) => {
      const teardown = () => {
        source.disconnect();
        gain.disconnect();
        analyser.disconnect();
      };
      const cancel = () => {
        source.onended = null;
        const now = audio.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + streamFadeSeconds);
        try { source.stop(now + streamFadeSeconds); } catch { /* already stopped */ }
        // Let the fade-out ramp finish playing before disconnecting the node graph.
        setTimeout(teardown, streamFadeSeconds * 1_000 + 20);
        reject(signal.reason);
      };
      source.onended = () => {
        signal.removeEventListener("abort", cancel);
        teardown();
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
// The first chunk of a phrase gets enough lead to ride out network jitter; after an
// underrun (audio ran dry before the next chunk came) the restart lead doubles, up to a cap.
export const streamFirstLeadSeconds = 0.1;
export const streamUnderrunLeadSeconds = 0.02;
export const streamMaxLeadSeconds = 0.5;

// Before starting a phrase at all, wait for this much PCM to be buffered (or the stream to end),
// so ordinary network jitter is absorbed before playback ever starts rather than causing an
// underrun a few hundred milliseconds in.
export const streamJitterBufferSeconds = 0.3;

// Length of the gain ramp applied at the start of a phrase and after an underrun restart (to avoid
// a click from starting mid-waveform), and when a phrase is cut off (to avoid a click from stopping
// mid-waveform).
export const streamFadeSeconds = 0.005;

export type StreamSchedule = { nextTime: number; started: boolean; underrunLead: number; restarted: boolean };

export function freshStreamSchedule(): StreamSchedule {
  return { nextTime: 0, started: false, underrunLead: streamUnderrunLeadSeconds, restarted: false };
}

/** When the next merged chunk of `duration` seconds starts, given the audio clock `now`; advances the schedule. */
export function scheduleStreamChunk(schedule: StreamSchedule, now: number, duration: number): number {
  let startAt: number;
  let restarted: boolean;
  if (!schedule.started) {
    startAt = now + streamFirstLeadSeconds;
    restarted = true;
  } else if (schedule.nextTime < now) {
    // Actually ran dry: restart just ahead of now instead of scheduling in the past, and keep more
    // audio buffered from here on so a slow network doesn't stutter every chunk.
    startAt = now + schedule.underrunLead;
    schedule.underrunLead = Math.min(streamMaxLeadSeconds, schedule.underrunLead * 2);
    restarted = true;
  } else {
    // Still ahead of "now": schedule right after the previous chunk so playback stays contiguous.
    startAt = schedule.nextTime;
    restarted = false;
  }
  schedule.started = true;
  schedule.restarted = restarted;
  schedule.nextTime = startAt + duration;
  return startAt;
}

/** Total duration, in seconds, of PCM chunks still waiting to be scheduled. */
export function bufferedDurationSeconds(chunks: readonly Float32Array[], sampleRate: number): number {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0) / sampleRate;
}

/** Whether enough audio has been buffered to start (or end) a phrase's jitter buffer wait. */
export function shouldReleaseJitterBuffer(bufferedSeconds: number, ended: boolean): boolean {
  return ended || bufferedSeconds >= streamJitterBufferSeconds;
}

/**
 * Whether playback should keep waiting for more audio instead of restarting right away after a real
 * underrun. Restarting the instant a single small chunk arrives just causes another underrun a
 * moment later; holding until at least `schedule.underrunLead` seconds are buffered (or the stream
 * ended) lets the restart actually ride out the jitter that caused the underrun.
 */
export function shouldHoldForUnderrun(
  schedule: StreamSchedule,
  now: number,
  pendingSeconds: number,
  ended: boolean,
): boolean {
  return schedule.started && !ended && schedule.nextTime < now && pendingSeconds < schedule.underrunLead;
}

/**
 * Plays raw 16-bit mono PCM while it is still arriving. Resolves once enough audio has come in (or
 * the stream ended) to ride out ordinary network jitter, so playback can start before the phrase has
 * finished generating without immediately running dry; `completed` settles when the whole phrase has
 * been received.
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
  const completed = (async (): Promise<number> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        const samples = toFloat(value);
        if (!samples.length) continue;
        received += samples.length;
        pending.push(samples);
        // Jitter buffer: don't let the pipeline start playing this phrase until there's enough
        // buffered to ride out ordinary jitter, so playback doesn't start only to underrun moments later.
        if (shouldReleaseJitterBuffer(received / sampleRate, false)) firstAudio();
        notify();
      }
      if (!received) throw new Error("The speech server sent no audio");
      // The whole phrase's actual duration, once known - used to refine a barge-in's estimated
      // cut position (see cut-sentence.ts) if the pause happens after the stream has finished.
      return received / sampleRate;
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
    // One gain node for the whole phrase: ramped up at the start (and after any underrun restart)
    // and ramped down if the phrase is cut off, so restarts and cutoffs don't click.
    const gain = audio.createGain();
    gain.connect(analyser);
    const sources = new Set<AudioBufferSourceNode>();
    const schedule = freshStreamSchedule();
    let started = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const finishIfDone = () => {
          if (ended && !pending.length && !sources.size) resolve();
        };
        const drain = () => {
          if (signal.aborted) return;
          const now = audio.currentTime;
          const pendingSeconds = bufferedDurationSeconds(pending, sampleRate);
          if (pending.length && !shouldHoldForUnderrun(schedule, now, pendingSeconds, ended)) {
            // Merge whatever arrived since the last pass into one buffer, so tiny network chunks don't click.
            const length = pending.reduce((sum, part) => sum + part.length, 0);
            const buffer = audio.createBuffer(1, length, sampleRate);
            const channel = buffer.getChannelData(0);
            let offset = 0;
            for (const part of pending.splice(0)) { channel.set(part, offset); offset += part.length; }
            const source = audio.createBufferSource();
            source.buffer = buffer;
            source.connect(gain);
            const startAt = scheduleStreamChunk(schedule, now, buffer.duration);
            if (schedule.restarted) {
              gain.gain.cancelScheduledValues(startAt);
              gain.gain.setValueAtTime(0, startAt);
              gain.gain.linearRampToValueAtTime(1, startAt + streamFadeSeconds);
            }
            source.start(startAt);
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
          const now = audio.currentTime;
          // Fade out instead of cutting the source(s) off instantly, to avoid a click.
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + streamFadeSeconds);
          for (const source of sources) {
            source.onended = null;
            try { source.stop(now + streamFadeSeconds); } catch { /* already stopped */ }
          }
          sources.clear();
          cancelRead();
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        drain();
      });
      gain.disconnect();
      analyser.disconnect();
    } catch (error) {
      // Let the fade-out ramp finish playing before tearing down the node graph.
      setTimeout(() => {
        try { gain.disconnect(); } catch { /* already disconnected */ }
        try { analyser.disconnect(); } catch { /* already disconnected */ }
      }, streamFadeSeconds * 1000 + 20);
      throw error;
    }
  }) as PreparedSpeech;
  play.completed = completed;
  return play;
}
