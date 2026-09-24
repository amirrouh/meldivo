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
