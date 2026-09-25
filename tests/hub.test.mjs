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

// A fake adapter driven by a queue of canned `send()` generators, so each
// test can script exactly what a turn does without a real CLI.
function fakeAdapter(id, label, { available = true, sessions = [] } = {}) {
  const sendQueue = [];
  return {
    id,
    label,
    sessions,
    calls: [],
    async available() {
      return available;
    },
    async listSessions(limit) {
      void limit;
      return sessions;
    },
    queueSend(genFactory) {
      sendQueue.push(genFactory);
    },
    async *send(target, text, signal) {
      this.calls.push({ target, text });
      const factory = sendQueue.shift();
      if (!factory) {
        yield { type: "error", message: `${label}: no scripted response` };
        return;
      }
      yield* factory(target, text, signal);
    },
  };
}

async function* okTurn(sessionId, deltas) {
  yield { type: "session", id: sessionId };
  for (const text of deltas) yield { type: "delta", text };
  yield { type: "done" };
}

async function* erroringTurn(message) {
  yield { type: "error", message };
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false, headers }, (res) => {
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

// Like readSseEvents, but waits for the turn's terminal event ("done" or
// "error") rather than a fixed count, since callers that depend on
// server-side bookkeeping finishing (the busy-lock, a saved fork id) before
// making their next request need to know the turn is actually over.
async function readSseUntilDone(response, timeoutMs = 5_000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const events = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
    if (events.some((event) => event.type === "done" || event.type === "error")) break;
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

function tmpStateDir() {
  return mkdtempSync(path.join(tmpdir(), "meldivo-state-"));
}

test("Meldivo hub: auth and /api/sessions shape", async (t) => {
  const secret = "s".repeat(32);
  const pi = fakeAdapter("pi", "Pi");
  const opencode = fakeAdapter("opencode", "OpenCode");
  const claude = fakeAdapter("claude", "Claude Code", {
    sessions: [{ key: "claude:abc", harness: "claude", id: "abc", title: "Fix bug", cwd: "/work", updatedAt: 1, open: false }],
  });
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [pi, opencode, claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  await t.test("nothing is served without the secret: API is 404, pages get the bare lock screen", async () => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 404);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 401);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const html = await page.text();
    assert.match(html, /\/api\/unlock/);
    assert.doesNotMatch(html, /meldivo|Meldivo/);
  });

  await t.test("health works with the secret", async () => {
    const response = await fetch(`${base}/api/health`, { headers: { "x-meldivo-token": secret } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal((await response.json()).ok, true);
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
  });

  await t.test("unlock exchanges the key for an HttpOnly session cookie", async () => {
    const wrong = await fetch(`${base}/api/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const right = await fetch(`${base}/api/unlock`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: secret }),
    });
    assert.equal(right.status, 204);
    const cookie = right.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, new RegExp(secret));
    const sessions = await fetch(`${base}/api/sessions`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(sessions.status, 200);
    const forged = await fetch(`${base}/api/sessions`, { headers: { cookie: "meldivo_session=forged" } });
    assert.equal(forged.status, 404);
  });

  await t.test("every other route requires the secret", async () => {
    const response = await fetch(`${base}/api/sessions`);
    assert.equal(response.status, 404);
  });

  await t.test("rejects a wrong secret too", async () => {
    const response = await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(response.status, 404);
  });

  await t.test("lists sessions and harness availability", async () => {
    const response = await fetch(`${base}/api/sessions`, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(typeof body.machine, "string");
    assert.deepEqual(
      body.harnesses.map((h) => h.id),
      ["pi", "opencode", "claude"],
    );
    assert.ok(body.harnesses.every((h) => h.available === true));
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].key, "claude:abc");
  });

  await t.test("accepts the secret as X-Meldivo-Token for proxies that strip Authorization", async () => {
    const ok = await fetch(`${base}/api/sessions`, { headers: { "x-meldivo-token": secret, authorization: "Basic dTpw" } });
    assert.equal(ok.status, 200);
    const wrong = await fetch(`${base}/api/sessions`, { headers: { "x-meldivo-token": "wrong" } });
    assert.equal(wrong.status, 404);
  });
});

test("Meldivo hub: chat over an existing closed session continues it directly", async (t) => {
  const secret = "s".repeat(32);
  const claude = fakeAdapter("claude", "Claude Code", {
    sessions: [{ key: "claude:abc", harness: "claude", id: "abc", title: "Fix bug", cwd: "/work", updatedAt: 1, open: false, model: "sonnet" }],
  });
  claude.queueSend(() => okTurn("abc", ["Sure, ", "looking now."]));
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const response = await fetch(`${base}/api/sessions/claude:abc/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "what does this do?" }),
  });
  assert.equal(response.status, 200);
  const events = await readSseEvents(response, 3);
  assert.ok(events.some((e) => e.type === "delta" && e.text === "Sure, "));
  assert.ok(events.some((e) => e.type === "done"));
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].target.id, "abc");
  assert.equal(claude.calls[0].target.fork, false);
  assert.equal(claude.calls[0].target.cwd, "/work");
  assert.equal(claude.calls[0].target.model, "sonnet");
});

test("Meldivo hub: chat over an open session forks on the first turn, then continues the fork", async (t) => {
  const secret = "s".repeat(32);
  const claude = fakeAdapter("claude", "Claude Code", {
    sessions: [{ key: "claude:abc", harness: "claude", id: "abc", title: "Fix bug", cwd: "/work", updatedAt: 1, open: true }],
  });
  claude.queueSend(() => okTurn("fork-1", ["first "]));
  claude.queueSend(() => okTurn("fork-1", ["second "]));
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const first = await fetch(`${base}/api/sessions/claude:abc/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "hi" }),
  });
  await readSseUntilDone(first);
  assert.equal(claude.calls[0].target.id, "abc");
  assert.equal(claude.calls[0].target.fork, true);

  const second = await fetch(`${base}/api/sessions/claude:abc/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "again" }),
  });
  await readSseEvents(second, 2);
  assert.equal(claude.calls[1].target.id, "fork-1");
  assert.equal(claude.calls[1].target.fork, false);
});

test("Meldivo hub: new:<harness> creates then continues a session by conversationId", async (t) => {
  const secret = "s".repeat(32);
  const claude = fakeAdapter("claude", "Claude Code");
  claude.queueSend(() => okTurn("new-session-1", ["hello"]));
  claude.queueSend(() => okTurn("new-session-1", ["again"]));
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const first = await fetch(`${base}/api/sessions/new:claude/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "start", conversationId: "conv-1" }),
  });
  await readSseUntilDone(first);
  assert.equal(claude.calls[0].target.id, null);
  assert.equal(claude.calls[0].target.fork, false);

  const second = await fetch(`${base}/api/sessions/new:claude/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "continue", conversationId: "conv-1" }),
  });
  await readSseEvents(second, 2);
  assert.equal(claude.calls[1].target.id, "new-session-1");
});

test("Meldivo hub: quick falls back to the next available harness on error", async (t) => {
  const secret = "s".repeat(32);
  const pi = fakeAdapter("pi", "Pi", { available: false });
  const opencode = fakeAdapter("opencode", "OpenCode");
  opencode.queueSend(() => erroringTurn("OpenCode is not logged in"));
  const claude = fakeAdapter("claude", "Claude Code");
  claude.queueSend(() => okTurn("quick-1", ["all good"]));
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [pi, opencode, claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const response = await fetch(`${base}/api/sessions/quick/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "hi", conversationId: "conv-quick" }),
  });
  assert.equal(response.status, 200);
  const events = await readSseEvents(response, 3);
  assert.ok(events.some((e) => e.type === "status" && /unavailable, using/i.test(e.message)));
  assert.ok(events.some((e) => e.type === "delta" && e.text === "all good"));
  assert.equal(opencode.calls.length, 1);
  assert.equal(claude.calls.length, 1);
});

test("Meldivo hub: cancel aborts a running turn, and one turn at a time per key", async (t) => {
  const secret = "s".repeat(32);
  const claude = fakeAdapter("claude", "Claude Code");
  claude.queueSend(async function* (target, text, signal) {
    yield { type: "session", id: "s1" };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    yield { type: "done" };
  });
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const chatPromise = fetch(`${base}/api/sessions/new:claude/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "hi", conversationId: "conv-cancel" }),
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const busy = await fetch(`${base}/api/sessions/new:claude/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "again" }),
  });
  assert.equal(busy.status, 409);

  const cancel = await fetch(`${base}/api/sessions/new:claude/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(cancel.status, 204);

  const response = await chatPromise;
  assert.equal(response.status, 200);
  await response.body?.cancel().catch(() => undefined);
});

test("Meldivo hub: cancel finds a new:<harness> turn by its resolved <harness>:<id> key too", async (t) => {
  // Regression test: the browser client learns "<harness>:<id>" from the
  // turn's "session" SSE event and switches to it immediately (including for
  // a barge-in cancel sent mid-turn), well before the turn ends. Before this
  // fix, /cancel only recognized the original "new:<harness>" request key, so
  // a cancel sent with the resolved key 404'd and the turn kept running.
  const secret = "s".repeat(32);
  const claude = fakeAdapter("claude", "Claude Code");
  claude.queueSend(async function* (target, text, signal) {
    yield { type: "session", id: "s1" };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
    yield { type: "done" };
  });
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), claude],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const chatPromise = fetch(`${base}/api/sessions/new:claude/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ message: "hi", conversationId: "conv-alias-cancel" }),
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancel = await fetch(`${base}/api/sessions/claude:s1/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(cancel.status, 204);

  const response = await chatPromise;
  assert.equal(response.status, 200);
  // Wait for the turn to actually finish (not just for the streaming headers,
  // which arrive before the abort even propagates) so the route's cleanup has
  // run before checking that the alias was cleared.
  await readSseUntilDone(response);

  // The alias is cleaned up with the turn: a later request reusing the same id is not "busy".
  const again = await fetch(`${base}/api/sessions/claude:s1/cancel`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(again.status, 404);
});

test("Meldivo hub: voice endpoints", async (t) => {
  const secret = "s".repeat(32);
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), fakeAdapter("claude", "Claude Code")],
    stateDir: tmpStateDir(),
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  await t.test("rejects transcription without the secret", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const response = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
    assert.equal(response.status, 404);
  });

  await t.test("transcribes audio through the fake speech engine", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40)]);
    const response = await fetch(`${base}/api/voice/transcribe`, {
      method: "POST",
      headers: { "content-type": "audio/wav", authorization: `Bearer ${secret}` },
      body: wav,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "hello from fake stt" });
  });

  await t.test("synthesizes speech through the fake speech engine", async () => {
    const response = await fetch(`${base}/api/voice/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ text: "hello there" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "audio/wav");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString(), "RIFF:voice-a:hello there");
  });

  await t.test("lists voices through the fake speech engine", async () => {
    const response = await fetch(`${base}/api/voice/voices`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { current: "voice-a", voices: ["voice-a", "voice-b"] });
  });

  await t.test("voice lease claim/heartbeat/release round trip", async () => {
    const claim = await fetch(`${base}/api/voice/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(claim.status, 201);
    const lease = await claim.json();

    const heartbeat = await fetch(`${base}/api/voice/lease/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ token: lease.token }),
    });
    assert.equal(heartbeat.status, 200);

    // A reloaded page (or another device) takes over; the old holder loses on its next heartbeat.
    const takeover = await fetch(`${base}/api/voice/lease`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(takeover.status, 201);
    const newLease = await takeover.json();
    assert.notEqual(newLease.token, lease.token);
    const stale = await fetch(`${base}/api/voice/lease/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ token: lease.token }),
    });
    assert.equal(stale.status, 409);

    const release = await fetch(`${base}/api/voice/lease`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ token: newLease.token }),
    });
    assert.equal(release.status, 204);
  });
});

test("Meldivo remote: 404 without secret, and the certificate path serves HTTPS via a user-supplied cert", async (t) => {
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
  const server = await startServer({
    port: 0,
    secret,
    speech: fakeSpeechEngine(),
    webDir: "/does/not/exist",
    adapters: [fakeAdapter("pi", "Pi"), fakeAdapter("opencode", "OpenCode"), fakeAdapter("claude", "Claude Code")],
    stateDir: tmpStateDir(),
    httpsPort: 0,
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  await t.test("rejects GET /api/remote without the secret", async () => {
    const response = await fetch(`${base}/api/remote`);
    assert.equal(response.status, 404);
  });

  let httpsPort;
  await t.test("enables the certificate option and reports it as active", async () => {
    const response = await fetch(`${base}/api/remote`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id: "certificate" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.url, /^https:\/\//);
    httpsPort = new URL(body.url).port;

    const status = await fetch(`${base}/api/remote`, { headers: { authorization: `Bearer ${secret}` } });
    const statusBody = await status.json();
    assert.equal(statusBody.active.id, "certificate");
  });

  await t.test("serves /api/health over HTTPS using the certificate", async () => {
    const response = await httpsGet(`https://127.0.0.1:${httpsPort}/api/health`, { "x-meldivo-token": secret });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).ok, true);
  });

  await t.test("turns remote access off", async () => {
    const response = await fetch(`${base}/api/remote`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(response.status, 204);
    await assert.rejects(() => httpsGet(`https://127.0.0.1:${httpsPort}/api/health`));
  });
});
