import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSherpaEngine, encodeWav, parseWav } from "../server/src/speech.ts";

const fixture = fileURLToPath(new URL("./fixtures/jfk.wav", import.meta.url));

test("parseWav reads the browser's 16-bit mono PCM header (samplesWav format)", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWav(samples, 16_000);
  const decoded = parseWav(wav);
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.bitsPerSample, 16);
  assert.equal(decoded.samples.length, samples.length);
});

test("encodeWav -> parseWav round trip preserves samples within 16-bit precision", () => {
  const original = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.8);
  const wav = encodeWav(original, 22_050);
  const decoded = parseWav(wav);
  assert.equal(decoded.sampleRate, 22_050);
  assert.equal(decoded.samples.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(decoded.samples[i] - original[i]) < 1e-3, `sample ${i} drifted too far`);
  }
});

test("encodeWav produces a well-formed RIFF/WAVE header", () => {
  const samples = new Float32Array(10).fill(0.1);
  const wav = encodeWav(samples, 24_000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 24_000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), samples.length * 2);
  assert.equal(wav.length, 44 + samples.length * 2);
});

test("parseWav rejects non-PCM and non-16-bit input", () => {
  const wav = encodeWav(new Float32Array(4), 16_000);
  const badFormat = Buffer.from(wav);
  badFormat.writeUInt16LE(3, 20); // claim IEEE float format
  assert.throws(() => parseWav(badFormat), /unsupported WAV audio format/);

  const badDepth = Buffer.from(wav);
  badDepth.writeUInt16LE(8, 34); // claim 8-bit depth
  assert.throws(() => parseWav(badDepth), /unsupported WAV bit depth/);
});

test("parseWav rejects buffers that aren't RIFF/WAVE", () => {
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /not a RIFF\/WAVE buffer/);
});

test("parseWav skips extra chunks (e.g. LIST) before locating fmt/data", () => {
  const samples = new Float32Array([0.25, -0.25, 0.5]);
  const base = encodeWav(samples, 16_000);
  const listChunk = Buffer.concat([
    Buffer.from("LIST", "ascii"),
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(4, 0);
      return b;
    })(),
    Buffer.from("INFO", "ascii"),
  ]);
  // Reassemble: RIFF header + extra LIST chunk + original fmt/data chunks.
  const withList = Buffer.concat([base.subarray(0, 12), listChunk, base.subarray(12)]);
  withList.writeUInt32LE(withList.length - 8, 4); // fix RIFF size
  const decoded = parseWav(withList);
  assert.equal(decoded.sampleRate, 16_000);
  assert.equal(decoded.samples.length, samples.length);
});

test("jfk.wav fixture parses as 16-bit mono PCM", async () => {
  const buffer = await readFile(fixture);
  const decoded = parseWav(buffer);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.bitsPerSample, 16);
  assert.ok(decoded.sampleRate > 0);
  assert.ok(decoded.samples.length > 0);
});

test("voices() lists the Kokoro multi-lang speaker table with af_heart as the default", () => {
  const engine = createSherpaEngine({ modelsDir: "/tmp/meldivo-speech-test-unused" });
  const voices = engine.voices();
  assert.ok(Array.isArray(voices));
  assert.ok(voices.length >= 50);
  assert.ok(voices.includes("af_heart"));
  assert.equal(engine.defaultVoice, "af_heart");
  // voices() must return a fresh copy, not a live reference.
  voices.push("not_a_real_voice");
  assert.ok(!engine.voices().includes("not_a_real_voice"));
});

test("status() starts idle (not downloading, not ready) before any use", () => {
  const engine = createSherpaEngine({ modelsDir: "/tmp/meldivo-speech-test-unused" });
  const status = engine.status();
  assert.equal(status.ready, false);
  assert.equal(status.downloading, false);
  assert.equal(status.error, undefined);
});

test("transcribe rejects immediately when given an already-aborted signal", async () => {
  const engine = createSherpaEngine({ modelsDir: "/tmp/meldivo-speech-test-unused" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => engine.transcribe(Buffer.alloc(0), controller.signal),
    (err) => err.name === "AbortError",
  );
  // No download/load should have been triggered by an already-aborted call.
  assert.equal(engine.status().downloading, false);
});

test("synthesize rejects immediately when given an already-aborted signal", async () => {
  const engine = createSherpaEngine({ modelsDir: "/tmp/meldivo-speech-test-unused" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => engine.synthesize("hello", "af_heart", controller.signal),
    (err) => err.name === "AbortError",
  );
  assert.equal(engine.status().downloading, false);
});
