/**
 * Loads the Silero detector's code and assets before the user taps the orb, so
 * starting voice only has to wait for the microphone. Everything here is a
 * best-effort warm-up: a failure is silent and start() simply loads it again.
 */

// Served from /voice-assets/ by web/scripts/copy-vad-assets.mjs; MicVAD resolves the model and
// worklet from `baseAssetPath` and onnxruntime-web the wasm files from `onnxWASMBasePath`.
export const voiceAssetBase = "/voice-assets/";
export const voiceAssetFiles = [
  "silero_vad_v5.onnx",
  "vad.worklet.bundle.min.js",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
] as const;

type VadModule = typeof import("@ricky0123/vad-web");

let vadModule: Promise<VadModule> | null = null;

/** The vad-web module, imported once per page; a failed import is retried on the next call. */
export function loadVadModule(): Promise<VadModule> {
  vadModule ??= import("@ricky0123/vad-web").catch((error: unknown) => {
    vadModule = null;
    throw error;
  });
  return vadModule;
}

let preloaded = false;

/** Starts the module import and fills the HTTP cache with the detector's assets, at low priority. */
export function preloadVoiceDetector(): void {
  if (preloaded) return;
  preloaded = true;
  void loadVadModule().catch(() => undefined);
  for (const file of voiceAssetFiles) {
    // `priority` is a hint that older browsers ignore; the body is read so the response is cached whole.
    void fetch(`${voiceAssetBase}${file}`, { priority: "low" } as RequestInit)
      .then((response) => (response.ok ? response.arrayBuffer() : undefined))
      .catch(() => undefined);
  }
}
