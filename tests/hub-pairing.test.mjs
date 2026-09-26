import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../server/src/index.ts";
import { joinHub } from "../server/src/machine-client.ts";
import { voicePrompt } from "../server/src/harnesses/voice-turn.ts";

// A hub and two machines on localhost, set up the way a user would: the hub issues one-time
// codes, each machine joins with one and then connects out to the hub on its own.

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), "meldivo-config-"));

const fakeSpeech = {
  async transcribe() { return ""; },
  async synthesize() { return Buffer.alloc(0); },
  voices: () => ["voice-a"],
  defaultVoice: "voice-a",
  status: () => ({ ready: true, downloading: false }),
};

function tmp(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function fakeAdapter(id, label, sessions = []) {
  const queue = [];
  return {
    id, label, calls: [],
    async available() { return true; },
    async listSessions() { return sessions; },
    queueSend(factory) { queue.push(factory); },
    async *send(target, text, signal) {
      this.calls.push({ target, text });
      const factory = queue.shift();
      if (!factory) { yield { type: "error", message: "no scripted response" }; return; }
      yield* factory(target, text, signal);
    },
  };
}

async function* slowTurn(id, _target, _text, signal) {
  yield { type: "session", id };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5_000);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); });
  });
  yield { type: "done" };
}

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
      const line = buffered.slice(0, boundary).split("\n").find((entry) => entry.startsWith("data:"));
      buffered = buffered.slice(boundary + 2);
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
    if (events.some((event) => event.type === "done" || event.type === "error")) break;
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

async function eventually(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("hub mode: machines join with a one-time code, list their sessions, and run relayed turns", async (t) => {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args.join(" ")); };
  console.error = (...args) => { logs.push(args.join(" ")); };
  t.after(() => { console.log = originalLog; console.error = originalError; });

  const hubSecret = "h".repeat(40);
  const hubConfig = tmp("meldivo-hub-");
  const hub = await startServer({
    port: 0, secret: hubSecret, speech: fakeSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
    adapters: [], hub: true, configDir: hubConfig, hubLink: null,
  });
  t.after(() => hub.close());
  const base = `http://127.0.0.1:${hub.port}`;
  const auth = { "content-type": "application/json", "x-meldivo-token": hubSecret };
  const newCode = async () => (await (await fetch(`${base}/api/hub/codes`, { method: "POST", headers: auth })).json()).code;

  const claude = fakeAdapter("claude", "Claude Code", [
    { key: "claude:abc", harness: "claude", id: "abc", title: "Work on A", cwd: "/work", updatedAt: 5, open: false },
  ]);
  const pi = fakeAdapter("pi", "Pi");
  const machines = [];
  async function startMachine(name, adapters, codeOverride) {
    const link = await joinHub(base, codeOverride ?? await newCode(), name);
    const server = await startServer({
      port: 0, secret: "m".repeat(40), speech: fakeSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
      adapters, configDir: tmp("meldivo-machine-"), hubLink: link, version: "test",
    });
    machines.push(server);
    t.after(() => server.close());
    return { link, server };
  }

  const sessions = async () => (await fetch(`${base}/api/sessions`, { headers: auth })).json();

  await t.test("wrong, reused, and missing codes get the plain 404", async () => {
    await assert.rejects(joinHub(base, "AAAA-BBBB-CCCC", "x"), /did not accept/);
    const code = await newCode();
    await joinHub(base, code, "once");
    await assert.rejects(joinHub(base, code, "twice"), /did not accept/);
    const raw = await fetch(`${base}/api/hub/join`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(raw.status, 404);
    assert.match(await raw.text(), /404 Not Found/);
    const removed = await fetch(`${base}/api/hub/machines/once`, { method: "DELETE", headers: auth });
    assert.equal(removed.status, 204);
  });

  const alpha = await startMachine("alpha", [pi, fakeAdapter("opencode", "OpenCode"), claude]);
  const beta = await startMachine("alpha", [fakeAdapter("pi", "Pi")]);

  await t.test("both machines appear with their sessions under @<machine>/ keys", async () => {
    assert.equal(beta.link.name, "alpha-2");
    const body = await eventually(async () => {
      const value = await sessions();
      return value.hosts.filter((host) => host.online).length === 3 && value.sessions.length === 1 ? value : undefined;
    });
    assert.deepEqual(body.hosts.map((host) => host.id), ["", "alpha", "alpha-2"]);
    assert.equal(body.sessions[0].key, "@alpha/claude:abc");
    assert.equal(body.sessions[0].host, "alpha");
  });

  await t.test("the hub stores only a hash of each machine's credential, owner-only", async () => {
    const file = path.join(hubConfig, "machines.json");
    const stored = readFileSync(file, "utf8");
    assert.doesNotMatch(stored, new RegExp(alpha.link.credential));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(hubConfig, "hub-key.pem")).mode & 0o777, 0o600);
  });

  await t.test("a turn is relayed to the machine and its events stream back", async () => {
    claude.queueSend(async function* () {
      yield { type: "session", id: "abc" };
      yield { type: "delta", text: "Hello from alpha." };
      yield { type: "done" };
    });
    const response = await fetch(`${base}/api/sessions/${encodeURIComponent("@alpha/claude:abc")}/chat`, {
      method: "POST", headers: auth, body: JSON.stringify({ message: "secret plans for tuesday", conversationId: "c1" }),
    });
    const events = await readSseUntilDone(response);
    assert.deepEqual(events.map((event) => event.type), ["session", "delta", "done"]);
    // The machine that runs the turn adds the voice note once; the hub relays the text untouched.
    assert.equal(claude.calls.at(-1).text, voicePrompt("secret plans for tuesday"));
  });

  await t.test("cancel reaches a machine's new chat by its resolved key", async () => {
    pi.queueSend((target, text, signal) => slowTurn("p1", target, text, signal));
    const chat = fetch(`${base}/api/sessions/${encodeURIComponent("@alpha/new:pi")}/chat`, {
      method: "POST", headers: auth, body: JSON.stringify({ message: "hi", conversationId: "c2" }),
    });
    const response = await chat;
    await eventually(async () => {
      const cancel = await fetch(`${base}/api/sessions/${encodeURIComponent("@alpha/pi:p1")}/cancel`, { method: "POST", headers: auth });
      return cancel.status === 204;
    });
    await readSseUntilDone(response);
  });

  await t.test("the hub may not use quick or another machine's keys through a machine", async () => {
    for (const key of ["@alpha/quick", "@alpha/@alpha-2/new:pi", "@nobody/new:pi"]) {
      const response = await fetch(`${base}/api/sessions/${encodeURIComponent(key)}/chat`, {
        method: "POST", headers: auth, body: JSON.stringify({ message: "hi" }),
      });
      const events = await readSseUntilDone(response);
      assert.equal(events.at(-1).type, "error", key);
    }
  });

  await t.test("a removed machine is dropped at once and cannot reconnect", async () => {
    const removed = await fetch(`${base}/api/hub/machines/alpha-2`, { method: "DELETE", headers: auth });
    assert.equal(removed.status, 204);
    const body = await sessions();
    assert.deepEqual(body.hosts.map((host) => host.id), ["", "alpha"]);
    const ws = await import("ws");
    const refused = await new Promise((resolve) => {
      const socket = new ws.default(`ws://127.0.0.1:${hub.port}/api/hub/connect`, "meldivo-v1", { headers: { "x-meldivo-machine": beta.link.credential } });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      socket.on("open", () => resolve("open"));
      socket.on("error", () => undefined);
    });
    assert.equal(refused, 404);
  });

  await t.test("a machine refuses a hub that cannot prove the pinned identity", async () => {
    const otherHubConfig = tmp("meldivo-hub-");
    const impostor = await startServer({
      port: 0, secret: hubSecret, speech: fakeSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
      adapters: [], hub: true, configDir: otherHubConfig, hubLink: null,
    });
    // The impostor knows the credential (worst case) but not the real hub's signing key.
    const { writeFileSync } = await import("node:fs");
    const { createHash } = await import("node:crypto");
    writeFileSync(path.join(otherHubConfig, "machines.json"), JSON.stringify([{ name: "alpha", credentialHash: createHash("sha256").update(alpha.link.credential).digest("hex"), joinedAt: 1 }]));
    await impostor.close();
    const impostor2 = await startServer({
      port: 0, secret: hubSecret, speech: fakeSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
      adapters: [], hub: true, configDir: otherHubConfig, hubLink: null,
    });
    t.after(() => impostor2.close());
    const victim = await startServer({
      port: 0, secret: "v".repeat(40), speech: fakeSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
      adapters: [claude], configDir: tmp("meldivo-machine-"), hubLink: { ...alpha.link, url: `http://127.0.0.1:${impostor2.port}` },
    });
    t.after(() => victim.close());
    await eventually(() => logs.some((line) => line.includes("hub_identity_mismatch")));
    const body = await (await fetch(`http://127.0.0.1:${impostor2.port}/api/sessions`, { headers: auth })).json();
    assert.equal(body.sessions.length, 0);
  });

  await t.test("a machine joined with --speech does the hub's speech", async () => {
    const before = await (await fetch(`${base}/api/voice/speech`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hello" }) })).arrayBuffer();
    assert.equal(before.byteLength, 0); // the hub's own (fake) engine
    const fastSpeech = {
      ...fakeSpeech,
      async transcribe() { return " words from the fast machine "; },
      async synthesize(text, voice) { return Buffer.from(`RIFF:${voice}:${text}`); },
    };
    const link = await joinHub(base, await newCode(), "fast");
    const server = await startServer({
      port: 0, secret: "f".repeat(40), speech: fastSpeech, webDir: "/does/not/exist", stateDir: tmp("meldivo-state-"),
      adapters: [], configDir: tmp("meldivo-machine-"), hubLink: { ...link, speech: true },
    });
    t.after(() => server.close());
    const audio = await eventually(async () => {
      const response = await fetch(`${base}/api/voice/speech`, { method: "POST", headers: auth, body: JSON.stringify({ text: "hello", voice: "voice-a" }) });
      const body = Buffer.from(await response.arrayBuffer()).toString();
      return body.startsWith("RIFF") ? body : undefined;
    });
    assert.equal(audio, "RIFF:voice-a:hello");
    const wav = Buffer.alloc(64);
    wav.write("RIFF", 0, "ascii");
    const transcribed = await fetch(`${base}/api/voice/transcribe`, { method: "POST", headers: { ...auth, "content-type": "audio/wav" }, body: wav });
    assert.deepEqual(await transcribed.json(), { text: "words from the fast machine" });
  });

  await t.test("logs never contain credentials, codes, or what was said", async () => {
    const all = logs.join("\n");
    assert.doesNotMatch(all, new RegExp(alpha.link.credential));
    assert.doesNotMatch(all, /secret plans for tuesday/);
    assert.doesNotMatch(all, new RegExp(hubSecret));
  });
});
