import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

export interface SpeechEngine {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<string>;
  // returns a complete WAV file
  synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Buffer>;
  voices(): string[];
  defaultVoice: string; // "af_heart"
  status(): { ready: boolean; downloading: boolean; progress?: number; error?: string };
  warmup?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

const PARAKEET_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
// fp32, not int8: benchmarking on the CPU-only target box (AMD Ryzen 9
// 5900XT, no AVX512-VNNI) showed the int8-quantized Kokoro model is
// *slower* than fp32 (~2.17s vs ~1.37s synthesis for a 9-word sentence,
// real-time factor ~1.08 vs ~0.69) because onnxruntime falls back to
// dequantize-then-compute kernels without VNNI. fp32 also beat the
// English-only kokoro-en-v0_19 fp32 model (~1.86s) while keeping full
// multi-language voice support.
const KOKORO_DIR = "kokoro-multi-lang-v1_0";

interface ModelSpec {
  dirName: string;
  url: string;
  sha256: string;
  sizeBytes: number; // approximate, for weighted progress reporting
  // files that must exist for the model to be considered already installed
  requiredFiles: string[];
}

const PARAKEET_SPEC: ModelSpec = {
  dirName: PARAKEET_DIR,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
  sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
  sizeBytes: 487_170_055,
  requiredFiles: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
};

const KOKORO_SPEC: ModelSpec = {
  dirName: KOKORO_DIR,
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2",
  sha256: "c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298",
  sizeBytes: 349_906_910,
  requiredFiles: ["model.onnx", "voices.bin", "tokens.txt"],
};

// Kokoro v1.0 multi-lang speaker table (index == speaker id), extracted from
// the model's embedded `speaker2id` metadata. af_heart is speaker id 3.
export const KOKORO_VOICES: readonly string[] = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
  "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam",
  "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
  "am_puck", "am_santa", "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora", "em_alex",
  "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara",
  "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro",
  "jm_kumo", "pf_dora", "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni",
  "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi", "zm_yunxia",
  "zm_yunyang", "em_santa",
];

const DEFAULT_VOICE = "af_heart";

// ---------------------------------------------------------------------------
// Thread configuration
// ---------------------------------------------------------------------------

// Kokoro scales well with threads when numThreads is set on the *model* config (measured on a
// 16-core Ryzen: 1 thread 1.38 s, 8 threads 0.35 s for a short sentence); gains flatten past 8.
const CPU_COUNT = os.availableParallelism?.() ?? os.cpus().length;
const DEFAULT_THREADS = Math.min(4, CPU_COUNT);
const DEFAULT_TTS_THREADS = Math.min(8, CPU_COUNT);

function threadsFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sttThreads(): number {
  return threadsFromEnv("MELDIVO_STT_THREADS") ?? DEFAULT_THREADS;
}

function ttsThreads(): number {
  return threadsFromEnv("MELDIVO_TTS_THREADS") ?? DEFAULT_TTS_THREADS;
}

// ---------------------------------------------------------------------------
// WAV parse/encode helpers (pure, no native deps — exported for unit tests)
// ---------------------------------------------------------------------------

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  samples: Float32Array; // interleaved if channels > 1, normalized to [-1, 1]
}

/** Parses a RIFF/WAVE buffer, locating the fmt and data chunks by walking
 * the chunk list rather than assuming a fixed 44-byte header. */
export function parseWav(buffer: Buffer): DecodedWav {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("speech: not a RIFF/WAVE buffer");
  }

  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let data: { start: number; length: number } | undefined;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === "data") {
      data = { start: bodyStart, length: Math.min(chunkSize, buffer.length - bodyStart) };
    }

    // Chunks are word-aligned: a chunk with odd size has one pad byte.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error("speech: WAV missing fmt chunk");
  if (!data) throw new Error("speech: WAV missing data chunk");
  if (fmt.audioFormat !== 1) throw new Error(`speech: unsupported WAV audio format ${fmt.audioFormat} (expected PCM)`);
  if (fmt.bitsPerSample !== 16) throw new Error(`speech: unsupported WAV bit depth ${fmt.bitsPerSample} (expected 16)`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  const sampleCount = Math.floor(data.length / bytesPerSample);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const raw = buffer.readInt16LE(data.start + i * bytesPerSample);
    samples[i] = raw < 0 ? raw / 32_768 : raw / 32_767;
  }

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, samples };
}

/** Encodes mono Float32 samples in [-1, 1] into a complete 16-bit PCM WAV buffer. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16); // fmt chunk size
  bytes.writeUInt16LE(1, 20); // PCM
  bytes.writeUInt16LE(1, 22); // mono
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28); // byte rate
  bytes.writeUInt16LE(2, 32); // block align
  bytes.writeUInt16LE(16, 34); // bits per sample
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    bytes.writeInt16LE(Math.round(clamped * (clamped < 0 ? 32_768 : 32_767)), 44 + i * 2);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface EngineState {
  ready: boolean;
  downloading: boolean;
  progress?: number;
  error?: string;
}

// Minimal shape of the sherpa-onnx-node exports we use, kept local so the
// package doesn't need to be installed for type-checking or tests.
interface SherpaModule {
  OfflineRecognizer: {
    createAsync(config: unknown): Promise<{
      createStream(): { acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void };
      decodeAsync(stream: unknown): Promise<{ text: string }>;
    }>;
  };
  OfflineTts: {
    createAsync(config: unknown): Promise<{
      sampleRate: number;
      numSpeakers: number;
      generateAsync(obj: { text: string; sid: number; speed: number }): Promise<{ samples: Float32Array; sampleRate: number }>;
    }>;
  };
}

export function createSherpaEngine(options?: { modelsDir?: string }): SpeechEngine {
  const modelsDir =
    options?.modelsDir ??
    path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "meldivo", "models");

  const state: EngineState = { ready: false, downloading: false };

  let loadPromise: Promise<{
    recognizer: Awaited<ReturnType<SherpaModule["OfflineRecognizer"]["createAsync"]>>;
    tts: Awaited<ReturnType<SherpaModule["OfflineTts"]["createAsync"]>>;
  }> | null = null;

  async function importSherpa(): Promise<SherpaModule> {
    try {
      // sherpa-onnx-node ships no type declarations; the shape we rely on
      // is captured locally in `SherpaModule` and asserted here.
      // @ts-expect-error -- untyped module, resolved dynamically so a
      // missing native binary throws a clear runtime error instead of
      // failing at import time for callers that never need speech.
      const imported = await import("sherpa-onnx-node");
      // sherpa-onnx-node is CJS; Node's cjs-module-lexer can't statically
      // synthesize all of its named exports, so fall back to `.default`
      // (the raw module.exports object) when a named export is missing.
      const mod = (imported.OfflineRecognizer ? imported : imported.default) as unknown as SherpaModule;
      return mod;
    } catch (cause) {
      throw new Error(
        "speech: sherpa-onnx-node is not installed or its native binary is missing for this platform. " +
          "Install the `sherpa-onnx-node` dependency to enable speech.",
        { cause },
      );
    }
  }

  async function ensureModel(spec: ModelSpec, weightStart: number, weightSpan: number): Promise<string> {
    const dest = path.join(modelsDir, spec.dirName);
    const alreadyInstalled = await allFilesExist(dest, spec.requiredFiles);
    if (alreadyInstalled) return dest;

    await mkdir(modelsDir, { recursive: true });
    const tmpRoot = await mkdtemp(path.join(modelsDir, `.dl-${spec.dirName}-`));
    try {
      const archivePath = path.join(tmpRoot, "archive.tar.bz2");
      await downloadWithProgress(spec.url, archivePath, (fraction) => {
        state.progress = weightStart + fraction * weightSpan;
      });
      await verifySha256(archivePath, spec.sha256);

      const extractDir = path.join(tmpRoot, "extract");
      await mkdir(extractDir, { recursive: true });
      await execFileAsync("tar", ["-xjf", archivePath, "-C", extractDir]);

      const extractedRoot = path.join(extractDir, spec.dirName);
      const finalExists = await allFilesExist(extractedRoot, spec.requiredFiles);
      if (!finalExists) throw new Error(`speech: extracted archive for ${spec.dirName} is missing expected files`);

      // Atomic move into place. rename() across the same filesystem (both
      // paths are under modelsDir) is atomic.
      await rename(extractedRoot, dest).catch(async (err: NodeJS.ErrnoException) => {
        // Another concurrent caller may have already installed it.
        if (err.code === "ENOTEMPTY" || err.code === "EEXIST") return;
        throw err;
      });
      return dest;
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function load() {
    if (loadPromise) return loadPromise;
    state.downloading = true;
    state.progress = 0;
    state.error = undefined;
    loadPromise = (async () => {
      try {
        const sherpa = await importSherpa();

        // Weight progress: parakeet is ~79% of total download bytes, kokoro ~21%.
        const total = PARAKEET_SPEC.sizeBytes + KOKORO_SPEC.sizeBytes;
        const parakeetSpan = PARAKEET_SPEC.sizeBytes / total;
        const kokoroSpan = KOKORO_SPEC.sizeBytes / total;

        const parakeetDir = await ensureModel(PARAKEET_SPEC, 0, parakeetSpan);
        const kokoroDir = await ensureModel(KOKORO_SPEC, parakeetSpan, kokoroSpan);

        state.progress = 1;
        state.downloading = false;

        const recognizer = await sherpa.OfflineRecognizer.createAsync({
          featConfig: { sampleRate: 16_000, featureDim: 80 },
          modelConfig: {
            transducer: {
              encoder: path.join(parakeetDir, "encoder.int8.onnx"),
              decoder: path.join(parakeetDir, "decoder.int8.onnx"),
              joiner: path.join(parakeetDir, "joiner.int8.onnx"),
            },
            tokens: path.join(parakeetDir, "tokens.txt"),
            modelType: "nemo_transducer",
            numThreads: sttThreads(),
            provider: "cpu",
            debug: false,
          },
        });

        const tts = await sherpa.OfflineTts.createAsync({
          model: {
            kokoro: {
              model: path.join(kokoroDir, "model.onnx"),
              voices: path.join(kokoroDir, "voices.bin"),
              tokens: path.join(kokoroDir, "tokens.txt"),
              dataDir: path.join(kokoroDir, "espeak-ng-data"),
              lexicon: path.join(kokoroDir, "lexicon-us-en.txt"),
              lang: "en-us",
            },
            // sherpa-onnx reads these from the model config; at the top level they are ignored.
            numThreads: ttsThreads(),
            provider: "cpu",
            debug: false,
          },
          maxNumSentences: 1,
        });

        state.ready = true;

        // Warm up: the first real synthesize/transcribe call after load()
        // should not pay any one-time initialization cost (e.g. onnxruntime
        // kernel selection, espeak-ng data loading). Benchmarking showed
        // this pays off mostly for the download+load latency being moved
        // off the request path (warmup() is invoked at process startup,
        // before any user request), not per-call JIT — but it's cheap
        // insurance either way and costs nothing on the hot path.
        try {
          await tts.generateAsync({ text: "warm up", sid: Math.max(0, KOKORO_VOICES.indexOf(DEFAULT_VOICE)), speed: 1.0 });
        } catch {
          // Non-fatal: a failed warmup synth shouldn't block engine readiness.
        }

        return { recognizer, tts };
      } catch (err) {
        state.downloading = false;
        state.error = err instanceof Error ? err.message : String(err);
        loadPromise = null; // allow retry on next call
        throw err;
      }
    })();
    return loadPromise;
  }

  function rejectIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("speech: aborted", "AbortError");
  }

  return {
    defaultVoice: DEFAULT_VOICE,

    async transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
      rejectIfAborted(signal);
      const { recognizer } = await load();
      rejectIfAborted(signal);
      const decoded = parseWav(wav);
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: decoded.samples, sampleRate: decoded.sampleRate });
      const result = await abortable(recognizer.decodeAsync(stream), signal);
      return result.text;
    },

    async synthesize(text: string, voice: string, signal?: AbortSignal): Promise<Buffer> {
      rejectIfAborted(signal);
      const { tts } = await load();
      rejectIfAborted(signal);
      const sid = KOKORO_VOICES.indexOf(voice);
      if (sid < 0) throw new Error(`speech: unknown voice "${voice}"`);
      const audio = await abortable(tts.generateAsync({ text, sid, speed: 1.0 }), signal);
      return encodeWav(audio.samples, audio.sampleRate);
    },

    voices(): string[] {
      return [...KOKORO_VOICES];
    },

    status() {
      return {
        ready: state.ready,
        downloading: state.downloading,
        progress: state.progress,
        error: state.error,
      };
    },

    async warmup(): Promise<void> {
      await load();
    },
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("speech: aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("speech: aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function allFilesExist(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      await stat(path.join(dir, file));
    } catch {
      return false;
    }
  }
  return true;
}

async function downloadWithProgress(url: string, destPath: string, onProgress: (fraction: number) => void): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`speech: failed to download ${url}: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let received = 0;

  const nodeStream = Readable.fromWeb(response.body as import("stream/web").ReadableStream<Uint8Array>);
  nodeStream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) onProgress(received / total);
  });

  await pipeline(nodeStream, createWriteStream(destPath));
}

async function verifySha256(filePath: string, expected: string): Promise<void> {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(filePath), hash as unknown as NodeJS.WritableStream);
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`speech: checksum mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
  }
}
