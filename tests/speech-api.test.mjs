import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startServer } from "../server/src/index.ts";
import { discover, fixStreamingWav, normalizeBaseUrl, synthesizeWith, transcribeWith, voiceNames } from "../server/src/speech-api.ts";

function wav(bytes = 8, dataSize = bytes) {
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(dataSize === 0xffffffff ? 0xffffffff : 36 + bytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24);
  buffer.writeUInt32LE(48000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

/** A speech server answering like Kokoro-FastAPI, vLLM-Omni, Speaches, Fish Speech, and whisper.cpp. */
async function fakeSpeechServer(t, { key } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (key && req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "bad key" } }));
      }
      const json = (value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      const url = new URL(req.url, "http://x");
      if (url.pathname === "/v1/models" && url.searchParams.get("task") === "text-to-speech") {
        return json({ data: [{ id: "speaches-ai/Kokoro-82M-v1.0-ONNX", voices: [{ name: "af_heart" }, { name: "am_adam" }] }] });
      }
      if (url.pathname === "/v1/models" && url.searchParams.get("task") === "automatic-speech-recognition") {
        return json({ data: [{ id: "Systran/faster-whisper-small" }] });
      }
      if (url.pathname === "/v1/registry") return json({ data: [{ id: "istupakov/parakeet-tdt-0.6b-v3-onnx" }] });
      if (url.pathname === "/v1/models") return json({ object: "list", data: [{ id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" }] });
      if (url.pathname === "/v1/audio/voices") return json({ voices: ["vivian", "ryan"], uploaded_voices: [{ name: "my_voice" }] });
      if (url.pathname === "/v1/references/list") return json({ success: true, reference_ids: ["narrator"] });
      if (url.pathname === "/v1/audio/speech" || url.pathname === "/v1/tts") {
        res.writeHead(200, { "Content-Type": "audio/wav" });
        return res.end(wav(8, 0xffffffff));
      }
      if (url.pathname === "/v1/audio/transcriptions" || url.pathname === "/inference") return json({ text: " hello there " });
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

test("normalizeBaseUrl accepts bare hosts and /v1 URLs, and rejects other schemes", () => {
  assert.equal(normalizeBaseUrl("speech-box:8000"), "http://speech-box:8000");
  assert.equal(normalizeBaseUrl("https://tts.example.com/v1/"), "https://tts.example.com");
  assert.equal(normalizeBaseUrl("http://localhost:8091/"), "http://localhost:8091");
  assert.equal(normalizeBaseUrl("file:///etc/passwd"), undefined);
  assert.equal(normalizeBaseUrl("http://user:pass@host"), undefined);
  assert.equal(normalizeBaseUrl(""), undefined);
});

test("voiceNames reads every voice-list shape", () => {
  assert.deepEqual(voiceNames({ voices: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(voiceNames({ voices: [{ id: "af_heart", name: "Heart" }] }), ["af_heart"]);
  assert.deepEqual(voiceNames({ status: "ok", voices: ["Emily.wav"] }), ["Emily.wav"]);
  assert.deepEqual(voiceNames({ reference_ids: ["x"] }), ["x"]);
  assert.deepEqual(voiceNames({ voices: ["ok", "bad voice/../"] }), ["ok"]);
});

test("fixStreamingWav repairs placeholder sizes", () => {
  const fixed = fixStreamingWav(wav(8, 0xffffffff));
  assert.equal(fixed.readUInt32LE(40), 8);
  assert.equal(fixed.readUInt32LE(4), fixed.length - 8);
  const good = wav(8);
  assert.equal(fixStreamingWav(good), good);
});

test("discover loads models and speakers per engine", async (t) => {
  const { url } = await fakeSpeechServer(t);
  const omni = await discover("tts", { engine: "vllm-omni", url });
  assert.deepEqual(omni.models, [{ id: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice" }]);
  assert.deepEqual(omni.voices, ["vivian", "ryan", "my_voice"]);
  const speaches = await discover("tts", { engine: "speaches", url });
  assert.equal(speaches.model, "speaches-ai/Kokoro-82M-v1.0-ONNX");
  assert.deepEqual(speaches.voices, ["af_heart", "am_adam"]);
  assert.equal(speaches.voice, "af_heart");
  const fish = await discover("tts", { engine: "fish-speech", url });
  assert.deepEqual(fish.voices, ["default", "narrator"]);
  const stt = await discover("stt", { engine: "speaches", url });
  assert.deepEqual(stt.models, [{ id: "Systran/faster-whisper-small" }, { id: "istupakov/parakeet-tdt-0.6b-v3-onnx", installed: false }]);
  assert.equal(stt.model, "Systran/faster-whisper-small");
  const local = await discover("tts", { engine: "local" });
  assert.ok(local.voices.includes("af_heart"));
});

test("synthesize and transcribe speak each server's API and send the key", async (t) => {
  const { url, seen } = await fakeSpeechServer(t, { key: "k-123" });
  const audio = await synthesizeWith({ engine: "vllm-omni", url, apiKey: "k-123", model: "m" }, "Hello", "vivian");
  assert.equal(audio.readUInt32LE(40), 8);
  const sent = JSON.parse(seen.at(-1).body.toString());
  assert.deepEqual(sent, { model: "m", input: "Hello", voice: "vivian", response_format: "wav" });
  assert.equal(seen.at(-1).auth, "Bearer k-123");

  await synthesizeWith({ engine: "fish-speech", url, apiKey: "k-123" }, "Hi", "narrator");
  assert.equal(seen.at(-1).url, "/v1/tts");
  assert.equal(JSON.parse(seen.at(-1).body.toString()).reference_id, "narrator");

  assert.equal(await transcribeWith({ engine: "vllm", url, apiKey: "k-123", model: "whisper" }, wav()), "hello there");
  assert.match(seen.at(-1).body.toString("latin1"), /name="model"\r\n\r\nwhisper/);
  assert.equal(await transcribeWith({ engine: "whisper-cpp", url, apiKey: "k-123" }, wav()), "hello there");
  assert.equal(seen.at(-1).url, "/inference");

  await assert.rejects(synthesizeWith({ engine: "openai", url, apiKey: "wrong" }, "Hi", "alloy"), /refused the API key/);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(discover("tts", { engine: "vllm-omni", url: `http://127.0.0.1:${closedPort}` }), /Nothing is listening/);
});

test("hub speech settings: saved per hub, key kept on the server, used for voice turns", async (t) => {
  const speechServer = await fakeSpeechServer(t, { key: "secret-key-1" });
  const configDir = mkdtempSync(path.join(tmpdir(), "meldivo-config-"));
  const localCalls = [];
  const local = {
    async transcribe() { localCalls.push("stt"); return "local"; },
    async synthesize(text, voice) { localCalls.push(`tts:${voice}`); return Buffer.from("RIFFlocal"); },
    voices: () => ["af_heart"],
    defaultVoice: "af_heart",
    status: () => ({ ready: true, downloading: false }),
  };
  const secret = "t".repeat(32);
  const server = await startServer({ port: 0, secret, speech: local, webDir: "/does/not/exist", adapters: [], configDir, stateDir: mkdtempSync(path.join(tmpdir(), "meldivo-state-")), hubLink: null });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const call = (pathName, init = {}) => fetch(`${base}${pathName}`, { ...init, headers: { "x-meldivo-token": secret, "Content-Type": "application/json", ...init.headers } });

  const initial = await (await call("/api/speech/settings")).json();
  assert.equal(initial.tts.setting.engine, "local");
  assert.ok(initial.tts.engines.some((engine) => engine.id === "vllm-omni"));

  const tts = { engine: "vllm-omni", url: speechServer.url, apiKey: "secret-key-1", model: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", voice: "ryan" };
  const stt = { engine: "whisper-cpp", url: `${speechServer.url}/v1`, apiKey: "secret-key-1" };
  const saved = await call("/api/speech/settings", { method: "PUT", body: JSON.stringify({ tts, stt }) });
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.doesNotMatch(savedText, /secret-key-1/);
  assert.equal(JSON.parse(savedText).tts.setting.hasKey, true);
  assert.equal(statSync(path.join(configDir, "speech.json")).mode & 0o777, 0o600);
  assert.match(readFileSync(path.join(configDir, "speech.json"), "utf8"), /secret-key-1/);

  // The browser never sees the key, so discovery without one reuses the saved key for the same server.
  const found = await (await call("/api/speech/discover", { method: "POST", body: JSON.stringify({ kind: "tts", setting: { engine: "vllm-omni", url: speechServer.url } }) })).json();
  assert.deepEqual(found.voices, ["vivian", "ryan", "my_voice"]);

  const voices = await (await call("/api/voice/voices")).json();
  assert.deepEqual(voices, { current: "ryan", voices: ["vivian", "ryan", "my_voice"] });

  // A voice another engine used falls back to the hub's speaker.
  const spoken = await call("/api/voice/speech", { method: "POST", body: JSON.stringify({ text: "Hello", voice: "af_heart" }) });
  assert.equal(spoken.status, 200);
  assert.equal(JSON.parse(speechServer.seen.at(-1).body.toString()).voice, "ryan");

  const heard = await call("/api/voice/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() });
  assert.deepEqual(await heard.json(), { text: "hello there" });
  assert.equal(speechServer.seen.at(-1).url, "/inference");
  assert.deepEqual(localCalls, []);

  const preview = await call("/api/speech/preview", { method: "POST", body: JSON.stringify({ setting: { engine: "local" }, voice: "af_heart" }) });
  assert.equal(preview.status, 200);
  assert.deepEqual(localCalls, ["tts:af_heart"]);

  const bad = await call("/api/speech/settings", { method: "PUT", body: JSON.stringify({ tts: { engine: "vllm-omni", url: "ftp://x" }, stt }) });
  assert.equal(bad.status, 400);
});
