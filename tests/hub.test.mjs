import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../server/src/index.ts";

function fakeSpeechEngine() {
  return {
    async transcribe(wav, _signal) {
      void wav;
      return "hello from fake stt";
    },
    async synthesize(text, voice, _signal) {
      return Buffer.from(`RIFF:${voice}:${text}`);
    },
    voices() {
      return ["voice-a", "voice-b"];
    },
    defaultVoice: "voice-a",
    status() {
      return { ready: true, downloading: false };
    },
  };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

async function readSseEvents(response, minCount, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < minCount && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffered.indexOf("\n\n")) !== -1) {
      const chunk = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const line = chunk.split("\n").find((entry) => entry.startsWith("data:"));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

test("Meldivo hub: auth, room lifecycle, harness chat, and voice endpoints", { timeout: 15_000 }, async (t) => {
  const secret = "s".repeat(32);
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    idleShutdownMs: 0,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  await t.test("rejects room creation without the secret", async () => {
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "harness", harness: "pi" }),
    });
    assert.equal(response.status, 401);
  });

  await t.test("rejects a wrong secret too", async () => {
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meldivo-secret": "wrong" },
      body: JSON.stringify({ mode: "harness", harness: "pi" }),
    });
    assert.equal(response.status, 401);
  });

  let room;
  await t.test("creates a room with the secret", async () => {
    const response = await fetch(`${base}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meldivo-secret": secret },
      body: JSON.stringify({ mode: "harness", harness: "pi", cwd: "/work/project", label: "my session" }),
    });
    assert.equal(response.status, 201);
    room = await response.json();
    assert.equal(room.room.mode, "harness");
    assert.equal(room.room.harness, "pi");
    assert.equal(room.room.cwd, "/work/project");
    assert.ok(room.token && room.token.length >= 32);
    assert.match(room.url, new RegExp(`\\?room=${room.room.id}#token=${room.token}`));
  });

  await t.test("adapter next/events round trip into the /api/chat SSE stream", async () => {
    const chatResponse = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        conversationId: "conv-1",
        message: "what does this function do?",
        roomId: room.room.id,
        roomToken: room.token,
      }),
    });
    assert.equal(chatResponse.status, 200);

    let turn;
    for (let attempt = 0; attempt < 20 && !turn; attempt++) {
      const next = await fetch(`${base}/api/rooms/${room.room.id}/adapter/next`, {
        method: "POST",
        headers: { authorization: `Bearer ${room.token}` },
      });
      if (next.status === 200) turn = await next.json();
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(turn, "the adapter should have received the queued turn");
    assert.equal(turn.message, "what does this function do?");
    assert.equal(turn.harness, "pi");
    assert.equal(turn.cwd, "/work/project");

    const deltaResponse = await fetch(`${base}/api/rooms/${room.room.id}/adapter/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.token}` },
      body: JSON.stringify({ turnId: turn.turnId, type: "delta", text: "It reverses the list." }),
    });
    assert.equal(deltaResponse.status, 202);

    const doneResponse = await fetch(`${base}/api/rooms/${room.room.id}/adapter/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.token}` },
      body: JSON.stringify({ turnId: turn.turnId, type: "done" }),
    });
    assert.equal(doneResponse.status, 202);

    const events = await readSseEvents(chatResponse, 3);
    assert.equal(events[0]?.type, "status");
    assert.ok(events.some((event) => event.type === "delta" && event.text === "It reverses the list."));
    assert.ok(events.some((event) => event.type === "done"));
  });

  await t.test("adapter endpoints reject the wrong room token", async () => {
    const response = await fetch(`${base}/api/rooms/${room.room.id}/adapter/next`, {
      method: "POST",
      headers: { authorization: "Bearer " + "x".repeat(32) },
    });
    assert.equal(response.status, 401);
  });

  await t.test("transcribes audio through the fake speech engine", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const response = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav", authorization: `Bearer ${room.token}` },
      body: wav,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "hello from fake stt" });
  });

  await t.test("rejects transcription without a valid room token", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const response = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
    assert.equal(response.status, 401);
  });

  await t.test("synthesizes speech through the fake speech engine", async () => {
    const response = await fetch(`${base}/api/voice/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.token}` },
      body: JSON.stringify({ text: "hello there" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString(), "RIFF:voice-a:hello there");
  });

  await t.test("lists voices through the fake speech engine", async () => {
    const response = await fetch(`${base}/api/voice/voices`, {
      headers: { authorization: `Bearer ${room.token}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { current: "voice-a", voices: ["voice-a", "voice-b"] });
  });

  await t.test("closes the room with the secret and the room no longer authorizes", async () => {
    const response = await fetch(`${base}/api/rooms/${room.room.id}`, {
      method: "DELETE",
      headers: { "x-meldivo-secret": secret },
    });
    assert.equal(response.status, 204);
    const after = await fetch(`${base}/api/rooms/${room.room.id}`, {
      headers: { authorization: `Bearer ${room.token}` },
    });
    assert.equal(after.status, 401);
  });
});

test("Meldivo remote HTTPS listener: secret-gated, backed by a user-supplied certificate", { timeout: 20_000 }, async (t) => {
  const configHome = mkdtempSync(path.join(tmpdir(), "meldivo-tls-"));
  const tlsDir = path.join(configHome, "meldivo", "tls");
  mkdirSync(tlsDir, { recursive: true });
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", path.join(tlsDir, "key.pem"), "-out", path.join(tlsDir, "cert.pem")],
    { stdio: "ignore" },
  );

  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;
  t.after(() => {
    if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    rmSync(configHome, { recursive: true, force: true });
  });

  const secret = "r".repeat(32);
  const server = await startServer({ port: 0, secret, speech: fakeSpeechEngine(), webDir: "/does/not/exist", idleShutdownMs: 0, httpsPort: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  await t.test("rejects enabling HTTPS without the secret", async () => {
    const response = await fetch(`${base}/api/remote/https`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enable: true }),
    });
    assert.equal(response.status, 401);
  });

  let httpsPort;
  await t.test("enables the HTTPS listener with the secret", async () => {
    const response = await fetch(`${base}/api/remote/https`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meldivo-secret": secret },
      body: JSON.stringify({ enable: true }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(Number.isInteger(payload.port) && payload.port > 0);
    httpsPort = payload.port;
  });

  await t.test("serves /api/health over HTTPS using the certificate", async () => {
    const response = await httpsGet(`https://127.0.0.1:${httpsPort}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);
  });

  await t.test("disables the HTTPS listener with the secret and it stops serving", async () => {
    const response = await fetch(`${base}/api/remote/https`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-meldivo-secret": secret },
      body: JSON.stringify({ enable: false }),
    });
    assert.equal(response.status, 200);
    await assert.rejects(() => httpsGet(`https://127.0.0.1:${httpsPort}/api/health`));
  });
});
