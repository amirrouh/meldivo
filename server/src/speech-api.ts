import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KOKORO_VOICES, type SpeechEngine } from "./speech.js";

// Speech through a self-hosted (or any OpenAI-compatible) server instead of the on-device
// models. One setting per hub covers every machine and browser that uses it. Each engine type
// knows how its server lists models and voices, so a base URL is all the user has to enter.
// API keys stay in the settings file (mode 0600) and never leave the server or reach the logs.

export type SpeechKind = "tts" | "stt";

export interface EngineInfo {
  id: string;
  label: string;
  /** Models it is known for, shown next to the name. */
  note?: string;
  /** Where its server usually listens, as a placeholder for the URL field. */
  defaultUrl?: string;
  /** False when the server has nothing to pick (a fixed model). */
  hasModels: boolean;
}

export const TTS_ENGINES: EngineInfo[] = [
  { id: "local", label: "On this device", note: "Kokoro, no server needed", hasModels: false },
  { id: "vllm-omni", label: "vLLM-Omni", note: "Fish S2 Pro, Voxtral TTS, Qwen3-TTS, Higgs Audio, Breeze TTS 2, CosyVoice, IndexTTS2", defaultUrl: "http://localhost:8091", hasModels: true },
  { id: "kokoro-fastapi", label: "Kokoro-FastAPI", note: "Kokoro on a GPU", defaultUrl: "http://localhost:8880", hasModels: false },
  { id: "chatterbox", label: "Chatterbox TTS Server", note: "Chatterbox, Turbo, Multilingual", defaultUrl: "http://localhost:8004", hasModels: false },
  { id: "fish-speech", label: "Fish Speech", note: "OpenAudio S1 and Fish S2 native server", defaultUrl: "http://localhost:8080", hasModels: false },
  { id: "orpheus", label: "Orpheus-FastAPI", note: "Orpheus", defaultUrl: "http://localhost:5005", hasModels: false },
  { id: "speaches", label: "Speaches", note: "Kokoro, Piper", defaultUrl: "http://localhost:8000", hasModels: true },
  { id: "openai", label: "Other OpenAI-compatible server", note: "anything serving /v1/audio/speech", hasModels: true },
];

export const STT_ENGINES: EngineInfo[] = [
  { id: "local", label: "On this device", note: "Parakeet, no server needed", hasModels: false },
  { id: "vllm", label: "vLLM", note: "Whisper, Voxtral, Qwen3-ASR, Granite Speech, Cohere Transcribe", defaultUrl: "http://localhost:8000", hasModels: true },
  { id: "speaches", label: "Speaches", note: "faster-whisper, Parakeet", defaultUrl: "http://localhost:8000", hasModels: true },
  { id: "whisper-cpp", label: "whisper.cpp server", note: "Whisper", defaultUrl: "http://localhost:8080", hasModels: false },
  { id: "openai", label: "Other OpenAI-compatible server", note: "anything serving /v1/audio/transcriptions", hasModels: true },
];

// Speaches' registry lists hundreds of community fine-tunes; offer these (when it has them) next to
// whatever is already installed. Order is the default preference.
const SPEACHES_TTS_PICKS = ["speaches-ai/Kokoro-82M-v1.0-ONNX", "speaches-ai/Kokoro-82M-v1.0-ONNX-fp16", "speaches-ai/Kokoro-82M-v1.0-ONNX-int8"];
const SPEACHES_STT_PICKS = [
  "istupakov/parakeet-tdt-0.6b-v3-onnx", // fastest, 25 European languages
  "deepdml/faster-whisper-large-v3-turbo-ct2", // fast and accurate, multilingual
  "Systran/faster-whisper-large-v3", // most accurate Whisper
  "Systran/faster-distil-whisper-small.en", // lightest, English only
];

// Model ids that give away which direction a model serves, so a server of the wrong kind is caught.
const TTS_MODEL = /tts|kokoro|piper|orpheus|chatterbox|cosyvoice|higgs|s2-pro|openaudio|breeze|vibevoice|zonos|dia\b|csm/i;
const STT_MODEL = /whisper|asr|parakeet|canary|granite-speech|transcri|stt|voxtral-mini|speech-to-text/i;

const ORPHEUS_VOICES = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"];
const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];

export interface EngineSetting {
  engine: string;
  url?: string;
  apiKey?: string;
  model?: string;
  /** TTS only: the speaker every reply uses unless a browser picked its own. */
  voice?: string;
}

export interface SpeechSettings {
  tts: EngineSetting;
  stt: EngineSetting;
}

export interface ModelOption {
  id: string;
  /** False for a Speaches model that downloads when first used. */
  installed?: boolean;
}

export interface Discovery {
  models: ModelOption[];
  voices: string[];
  /** Model the server itself suggests (or the only one it serves). */
  model?: string;
  voice?: string;
}

const DISCOVER_TIMEOUT_MS = 8_000;
const SPEECH_TIMEOUT_MS = 90_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const VOICE_ID = /^[A-Za-z0-9._-]{1,100}$/;

export function engineList(kind: SpeechKind): EngineInfo[] {
  return kind === "tts" ? TTS_ENGINES : STT_ENGINES;
}

function knownEngine(kind: SpeechKind, id: unknown): string | undefined {
  return typeof id === "string" && engineList(kind).some((engine) => engine.id === id) ? id : undefined;
}

/** Accepts "host:port", "http://host:port", or a URL ending in /v1, and returns the server root. */
export function normalizeBaseUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) return undefined;
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
}

function str(value: unknown, max = 300): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}

/** Validates one engine setting from a request or the settings file; undefined when unusable. */
export function readEngineSetting(kind: SpeechKind, value: unknown): EngineSetting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const engine = knownEngine(kind, raw.engine);
  if (!engine) return undefined;
  if (engine === "local") {
    const voice = kind === "tts" ? str(raw.voice, 100) : undefined;
    return { engine, ...(voice && VOICE_ID.test(voice) ? { voice } : {}) };
  }
  const url = normalizeBaseUrl(raw.url);
  if (!url) return undefined;
  const apiKey = str(raw.apiKey, 1000);
  const model = str(raw.model);
  const voice = kind === "tts" ? str(raw.voice, 100) : undefined;
  return { engine, url, ...(apiKey ? { apiKey } : {}), ...(model ? { model } : {}), ...(voice && VOICE_ID.test(voice) ? { voice } : {}) };
}

// ---------------------------------------------------------------------------
// Settings file
// ---------------------------------------------------------------------------

export class SpeechSettingsStore {
  private settings: SpeechSettings;
  private readonly file: string;

  constructor(configDir: string) {
    this.file = path.join(configDir, "speech.json");
    this.settings = this.read();
  }

  private read(): SpeechSettings {
    const fallback: SpeechSettings = { tts: { engine: "local" }, stt: { engine: "local" } };
    if (!existsSync(this.file)) return fallback;
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return {
        tts: readEngineSetting("tts", value.tts) ?? fallback.tts,
        stt: readEngineSetting("stt", value.stt) ?? fallback.stt,
      };
    } catch {
      return fallback;
    }
  }

  get(): SpeechSettings {
    return this.settings;
  }

  set(next: SpeechSettings): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
    this.settings = next;
  }
}

/** What the browser may see: everything except the API key itself. */
export function publicSetting(setting: EngineSetting): Omit<EngineSetting, "apiKey"> & { hasKey: boolean } {
  const { apiKey, ...rest } = setting;
  return { ...rest, hasKey: Boolean(apiKey) };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function headers(setting: EngineSetting, extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...(setting.apiKey ? { Authorization: `Bearer ${setting.apiKey}` } : {}) };
}

async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = (await response.text()).slice(0, 2000);
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const error = body.error as Record<string, unknown> | string | undefined;
      const detailField = body.detail as Record<string, unknown> | string | undefined;
      detail = (typeof error === "string" ? error : str(error?.message, 300))
        ?? (typeof detailField === "string" ? detailField : str((detailField as Record<string, unknown> | undefined)?.message, 300))
        ?? str(body.message, 300) ?? "";
    } catch {
      detail = /<html/i.test(text) ? "" : text.trim().slice(0, 200);
    }
  } catch {
    // body unreadable; the status is enough
  }
  if (response.status === 401 || response.status === 403) return "The server refused the API key";
  return `The speech server answered ${response.status}${detail ? `: ${detail}` : ""}`;
}

function connectionError(error: unknown, url: string): Error {
  if (error instanceof DOMException && error.name === "TimeoutError") return new Error("The speech server took too long to answer");
  if (error instanceof DOMException && error.name === "AbortError") return error as Error;
  const cause = (error as { cause?: { code?: string } })?.cause?.code;
  const host = (() => { try { return new URL(url).host; } catch { return "the server"; } })();
  if (cause === "ECONNREFUSED") return new Error(`Nothing is listening at ${host}`);
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return new Error(`Could not find ${host}`);
  return new Error(`Could not reach ${host}`);
}

async function request(setting: EngineSetting, pathName: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const url = `${setting.url}${pathName}`;
  try {
    return await fetch(url, {
      ...init,
      redirect: "error",
      headers: headers(setting, (init.headers as Record<string, string> | undefined) ?? {}),
      signal: timeoutSignal(init.timeoutMs ?? DISCOVER_TIMEOUT_MS, init.signal ?? undefined),
    });
  } catch (error) {
    throw connectionError(error, url);
  }
}

async function getJson(setting: EngineSetting, pathName: string): Promise<unknown> {
  const response = await request(setting, pathName, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(await describeFailure(response));
  return response.json();
}

async function tryJson(setting: EngineSetting, pathName: string): Promise<unknown | undefined> {
  try {
    return await getJson(setting, pathName);
  } catch {
    return undefined;
  }
}

/** Reads a voice list in any of the shapes servers use: strings, {id}/{name} objects, reference ids. */
export function voiceNames(body: unknown): string[] {
  const out: string[] = [];
  const add = (items: unknown) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const name = typeof item === "string" ? item
        : item && typeof item === "object"
          ? str((item as Record<string, unknown>).id, 100) ?? str((item as Record<string, unknown>).name, 100) ?? str((item as Record<string, unknown>).filename, 100) ?? str((item as Record<string, unknown>).voice_id, 100)
          : undefined;
      if (name && VOICE_ID.test(name) && !out.includes(name)) out.push(name);
    }
  };
  if (Array.isArray(body)) add(body);
  else if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    add(record.voices);
    add(record.uploaded_voices);
    add(record.reference_ids);
    add(record.data);
  }
  return out;
}

function modelIds(body: unknown): { id: string; voices?: string[] }[] {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>).data ?? (body as Record<string, unknown>).models : undefined;
  if (!Array.isArray(data)) return [];
  const out: { id: string; voices?: string[] }[] = [];
  for (const item of data) {
    const id = typeof item === "string" ? item : str((item as Record<string, unknown> | null)?.id);
    if (!id) continue;
    const voices = item && typeof item === "object" && Array.isArray((item as Record<string, unknown>).voices) ? voiceNames((item as Record<string, unknown>).voices) : undefined;
    out.push({ id, ...(voices ? { voices } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery: models and voices for an engine at a URL
// ---------------------------------------------------------------------------

export async function discover(kind: SpeechKind, setting: EngineSetting): Promise<Discovery> {
  if (setting.engine === "local") {
    return kind === "tts" ? { models: [], voices: [...KOKORO_VOICES], voice: "af_heart" } : { models: [], voices: [] };
  }
  return kind === "tts" ? discoverTts(setting) : discoverStt(setting);
}

async function discoverTts(setting: EngineSetting): Promise<Discovery> {
  switch (setting.engine) {
    case "kokoro-fastapi": {
      const body = await getJson(setting, "/v1/audio/voices");
      const record = body as Record<string, unknown>;
      return { models: [{ id: "kokoro" }], model: "kokoro", voices: voiceNames(body), voice: str(record?.default_voice, 100) ?? "af_heart" };
    }
    case "speaches": {
      const { installed, registry, models } = await speachesModels(setting, "text-to-speech", SPEACHES_TTS_PICKS);
      const model = setting.model && models.some((m) => m.id === setting.model) ? setting.model : installed[0]?.id ?? models[0]?.id;
      const chosen = [...installed, ...registry].find((m) => m.id === model);
      const voices = chosen?.voices?.length ? chosen.voices : voiceNames(await tryJson(setting, `/v1/audio/voices${model ? `?model_id=${encodeURIComponent(model)}` : ""}`));
      return { models, model, voices, voice: voices.includes("af_heart") ? "af_heart" : voices[0] };
    }
    case "vllm-omni": {
      const models = modelIds(await getJson(setting, "/v1/models")).map((m) => ({ id: m.id }));
      if (models.length && models.every((m) => STT_MODEL.test(m.id) && !TTS_MODEL.test(m.id))) {
        throw new Error("This server only has speech-to-text models; use it under Speech to text");
      }
      const voices = voiceNames(await getJson(setting, "/v1/audio/voices"));
      return { models, model: models[0]?.id, voices, voice: voices[0] };
    }
    case "chatterbox": {
      let voices = voiceNames(await tryJson(setting, "/v1/audio/voices"));
      if (!voices.length) voices = voiceNames(await tryJson(setting, "/get_predefined_voices"));
      if (!voices.length) await getJson(setting, "/api/model-info"); // surface "unreachable" instead of "no voices"
      return { models: [{ id: "chatterbox" }], model: "chatterbox", voices, voice: voices[0] };
    }
    case "orpheus": {
      // No voice list endpoint: probe the server, then offer Orpheus's built-in English voices.
      const response = await request(setting, "/", { headers: { Accept: "text/html,application/json" } });
      if (response.status >= 500) throw new Error(await describeFailure(response));
      await response.body?.cancel();
      return { models: [{ id: "orpheus" }], model: "orpheus", voices: ORPHEUS_VOICES, voice: "tara" };
    }
    case "fish-speech": {
      const body = await getJson(setting, "/v1/references/list");
      return { models: [], voices: ["default", ...voiceNames(body).filter((v) => v !== "default")], voice: "default" };
    }
    default: {
      const all = modelIds(await getJson(setting, "/v1/models")).map((m) => ({ id: m.id }));
      const models = all.filter((m) => TTS_MODEL.test(m.id) || !STT_MODEL.test(m.id));
      if (all.length && !models.length) throw new Error("This server only has speech-to-text models; use it under Speech to text");
      const listed = voiceNames(await tryJson(setting, "/v1/audio/voices"));
      const voices = listed.length ? listed : OPENAI_VOICES;
      const model = (models.find((m) => TTS_MODEL.test(m.id)) ?? models[0])?.id;
      return { models, model, voices, voice: voices[0] };
    }
  }
}

async function speachesModels(setting: EngineSetting, task: string, picks: string[]) {
  const installed = modelIds(await getJson(setting, `/v1/models?task=${task}`));
  const available = modelIds(await tryJson(setting, `/v1/registry?task=${task}`));
  const registry = picks
    .map((id) => available.find((m) => m.id === id))
    .filter((m): m is { id: string; voices?: string[] } => Boolean(m) && !installed.some((i) => i.id === m!.id));
  const models: ModelOption[] = [...installed.map((m) => ({ id: m.id })), ...registry.map((m) => ({ id: m.id, installed: false }))];
  return { installed, registry, models };
}

async function discoverStt(setting: EngineSetting): Promise<Discovery> {
  switch (setting.engine) {
    case "whisper-cpp": {
      const response = await request(setting, "/health");
      if (!response.ok && response.status !== 404) throw new Error(await describeFailure(response));
      await response.body?.cancel();
      return { models: [], voices: [] };
    }
    case "speaches": {
      const { installed, models } = await speachesModels(setting, "automatic-speech-recognition", SPEACHES_STT_PICKS);
      return { models, model: installed[0]?.id ?? models[0]?.id, voices: [] };
    }
    default: {
      const all = modelIds(await getJson(setting, "/v1/models")).map((m) => ({ id: m.id }));
      const models = all.filter((m) => !TTS_MODEL.test(m.id) || STT_MODEL.test(m.id));
      if (!models.length) {
        throw new Error(all.length ? "This server only has text-to-speech models; use it under Text to speech" : "This server lists no models");
      }
      return { models, model: (models.find((m) => STT_MODEL.test(m.id)) ?? models[0])?.id, voices: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Synthesis and transcription
// ---------------------------------------------------------------------------

async function readAudio(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_AUDIO_BYTES) throw new Error("The speech server sent too much audio");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("The speech server sent too much audio");
  if (!bytes.length) throw new Error("The speech server sent no audio");
  return fixStreamingWav(bytes);
}

/** Streaming servers write placeholder sizes into the WAV header; browsers such as Safari reject those. */
export function fixStreamingWav(bytes: Buffer): Buffer {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return bytes;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") {
      const actual = bytes.length - offset - 8;
      if (size > actual || size === 0) {
        const copy = Buffer.from(bytes);
        copy.writeUInt32LE(actual, offset + 4);
        copy.writeUInt32LE(copy.length - 8, 4);
        return copy;
      }
      return bytes;
    }
    offset += 8 + size + (size % 2);
  }
  return bytes;
}

async function installSpeachesModel(setting: EngineSetting, model: string, signal?: AbortSignal): Promise<void> {
  const response = await request(setting, `/v1/models/${model.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", timeoutMs: 15 * 60_000, signal });
  if (!response.ok && response.status !== 409) throw new Error(await describeFailure(response));
  await response.body?.cancel();
}

/** Starts downloading a Speaches model the user picked, so the first reply doesn't wait for it. */
export function prepareSetting(setting: EngineSetting): void {
  if (setting.engine === "speaches" && setting.model) void installSpeachesModel(setting, setting.model).catch(() => undefined);
}

async function withSpeachesInstall(setting: EngineSetting, run: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  const response = await run();
  if (setting.engine !== "speaches" || response.status !== 404 || !setting.model) return response;
  const detail = await response.clone().text().catch(() => "");
  if (!/not installed|not found locally|download/i.test(detail)) return response;
  await installSpeachesModel(setting, setting.model, signal);
  return run();
}

export async function synthesizeWith(setting: EngineSetting, text: string, voice: string | undefined, signal?: AbortSignal): Promise<Buffer> {
  if (setting.engine === "fish-speech") {
    const response = await request(setting, "/v1/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/wav" },
      body: JSON.stringify({ text, format: "wav", ...(voice && voice !== "default" ? { reference_id: voice } : {}) }),
      timeoutMs: SPEECH_TIMEOUT_MS,
      signal,
    });
    if (!response.ok) throw new Error(await describeFailure(response));
    return readAudio(response);
  }
  const model = setting.model ?? (setting.engine === "kokoro-fastapi" ? "kokoro" : setting.engine === "chatterbox" ? "chatterbox" : setting.engine === "orpheus" ? "orpheus" : "tts-1");
  const body = JSON.stringify({ model, input: text, ...(voice ? { voice } : {}), response_format: "wav" });
  const response = await withSpeachesInstall(setting, () => request(setting, "/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/wav" },
    body,
    timeoutMs: SPEECH_TIMEOUT_MS,
    signal,
  }), signal);
  if (!response.ok) throw new Error(await describeFailure(response));
  return readAudio(response);
}

export async function transcribeWith(setting: EngineSetting, wav: Buffer, signal?: AbortSignal): Promise<string> {
  const form = () => {
    const data = new FormData();
    data.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "speech.wav");
    data.append("response_format", "json");
    data.append("temperature", "0");
    if (setting.engine !== "whisper-cpp" && setting.model) data.append("model", setting.model);
    return data;
  };
  const pathName = setting.engine === "whisper-cpp" ? "/inference" : "/v1/audio/transcriptions";
  const response = await withSpeachesInstall(setting, () => request(setting, pathName, { method: "POST", body: form(), timeoutMs: SPEECH_TIMEOUT_MS, signal }), signal);
  if (!response.ok) throw new Error(await describeFailure(response));
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return (await response.text()).trim();
  const body = await response.json() as Record<string, unknown>;
  return typeof body.text === "string" ? body.text.trim() : "";
}

// ---------------------------------------------------------------------------
// The engine the rest of the server uses
// ---------------------------------------------------------------------------

export interface ConfigurableSpeech extends SpeechEngine {
  /** Current voice list, refreshed from the TTS server when one is configured. */
  listVoices(): Promise<string[]>;
  /** Whether either direction still uses the on-device models. */
  usesLocal(): boolean;
}

/** Routes each direction to its configured server, or to `local` when it is set to on-device. */
export function withSpeechSettings(local: SpeechEngine, store: SpeechSettingsStore): ConfigurableSpeech {
  let cachedFor = "";
  let cachedVoices: string[] = [];
  let lastError: string | undefined;
  const key = (setting: EngineSetting) => `${setting.engine}|${setting.url}|${setting.model}`;

  const refreshVoices = async (): Promise<string[]> => {
    const tts = store.get().tts;
    if (tts.engine === "local") return local.voices();
    if (cachedFor !== key(tts)) {
      cachedVoices = (await discover("tts", tts)).voices;
      cachedFor = key(tts);
    }
    return cachedVoices;
  };

  const track = async <T>(work: Promise<T>): Promise<T> => {
    try {
      const value = await work;
      lastError = undefined;
      return value;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  return {
    get defaultVoice() {
      const tts = store.get().tts;
      return tts.voice ?? (tts.engine === "local" ? local.defaultVoice : cachedVoices[0] ?? local.defaultVoice);
    },
    voices: () => (store.get().tts.engine === "local" ? local.voices() : cachedVoices),
    listVoices: () => refreshVoices(),
    usesLocal: () => store.get().tts.engine === "local" || store.get().stt.engine === "local",
    status: () => {
      const { tts, stt } = store.get();
      if (tts.engine === "local" || stt.engine === "local") {
        const base = local.status();
        return lastError && !base.error ? { ...base, error: lastError } : base;
      }
      return { ready: true, downloading: false, ...(lastError ? { error: lastError } : {}) };
    },
    warmup: async () => {
      if (store.get().tts.engine === "local" || store.get().stt.engine === "local") await local.warmup?.();
      if (store.get().tts.engine !== "local") await refreshVoices().catch(() => undefined);
    },
    transcribe: (wav, signal) => {
      const stt = store.get().stt;
      return stt.engine === "local" ? local.transcribe(wav, signal) : track(transcribeWith(stt, wav, signal));
    },
    synthesize: async (text, voice, signal) => {
      const tts = store.get().tts;
      if (tts.engine === "local") {
        const localVoice = local.voices().includes(voice) ? voice : tts.voice && local.voices().includes(tts.voice) ? tts.voice : local.defaultVoice;
        return local.synthesize(text, localVoice, signal);
      }
      // A browser may still remember a speaker from another engine; fall back to the hub's choice.
      const voices = await refreshVoices().catch(() => cachedVoices);
      const chosen = voices.includes(voice) ? voice : tts.voice ?? voices[0];
      return track(synthesizeWith(tts, text, chosen, signal));
    },
  };
}
