import assert from "node:assert/strict";
import { cpSync, chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createAdapters,
  createClaudeAdapter,
  createOpenCodeAdapter,
  createPiAdapter,
  listAllSessions,
} from "../server/src/harnesses/index.ts";
import { _killAllWarmOpenCodeServersForTests, checkEventContract } from "../server/src/harnesses/opencode.ts";
import http from "node:http";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "harnesses");
const tmpDirs = [];

function makeTmpHome(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  _killAllWarmOpenCodeServersForTests();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes an executable fake CLI script (node with a shebang) into `dir/name`. */
function writeFakeCli(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function readArgsLog(logFile) {
  return JSON.parse(readFileSync(logFile, "utf8"));
}

async function collect(iterable) {
  const out = [];
  for await (const event of iterable) out.push(event);
  return out;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test("claude listSessions: titles, cwd, model, and skip rules", async () => {
  const claudeHome = makeTmpHome("claude-home-");
  cpSync(path.join(FIXTURES, "claude"), path.join(claudeHome, ".claude"), { recursive: true });
  utimesSync(
    path.join(claudeHome, ".claude/projects/-tmp-fixture-a/session-a.jsonl"),
    new Date(1_700_000_200_000),
    new Date(1_700_000_200_000),
  );
  utimesSync(
    path.join(claudeHome, ".claude/projects/-tmp-fixture-a/session-b.jsonl"),
    new Date(1_700_000_100_000),
    new Date(1_700_000_100_000),
  );

  const adapter = createClaudeAdapter({ home: claudeHome, bin: "claude-does-not-exist" });
  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, "session-a-id");
  assert.equal(sessions[0].title, "Fix login bug"); // custom-title wins
  assert.equal(sessions[0].cwd, "/tmp/fixture-a");
  assert.equal(sessions[0].model, "claude-sonnet-5");
  assert.equal(sessions[0].harness, "claude");
  assert.equal(sessions[0].key, "claude:session-a-id");
  assert.equal(sessions[0].open, false);

  assert.equal(sessions[1].id, "session-b-id");
  // isMeta line and <command-...> wrapper line are both skipped as title candidates.
  assert.equal(sessions[1].title, "What does this function do?");
  assert.equal(sessions[1].model, "claude-opus-4");
});

test("claude listSessions: open/busy detection via ~/.claude/sessions status files", async () => {
  const claudeHome = makeTmpHome("claude-open-");
  cpSync(path.join(FIXTURES, "claude"), path.join(claudeHome, ".claude"), { recursive: true });
  const sessionsDir = path.join(claudeHome, ".claude", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    path.join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "session-a-id", cwd: "/tmp/fixture-a", status: "busy" }),
  );

  const adapter = createClaudeAdapter({ home: claudeHome, bin: "claude-does-not-exist" });
  const sessions = await adapter.listSessions();
  const a = sessions.find((s) => s.id === "session-a-id");
  assert.equal(a.open, true);
  assert.equal(a.busy, true);

  const b = sessions.find((s) => s.id === "session-b-id");
  assert.equal(b.open, false);
});

test("claude send(): maps stream-json events, honors resume/fork/new-session args", async () => {
  const home = makeTmpHome("claude-send-");
  const argsLog = path.join(home, "args.json");
  const cli = writeFakeCli(
    home,
    "fake-claude",
    `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGS_LOG_FILE) fs.writeFileSync(process.env.ARGS_LOG_FILE, JSON.stringify(args));
if (args.includes("--version")) { process.exit(0); }
const sessionId = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "new-session-id";
const lines = [
  { type: "system", session_id: sessionId },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "bash" }] } },
  { type: "result", permission_denials: [], is_error: false },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
  );

  const adapter = createClaudeAdapter({ home, bin: cli });
  process.env.ARGS_LOG_FILE = argsLog;
  try {
    const events = await collect(adapter.send({ id: "abc123", cwd: home, fork: true }, "hi", new AbortController().signal));
    assert.deepEqual(
      events.map((e) => e.type),
      ["session", "delta", "delta", "tool", "done"],
    );
    assert.equal(events[0].id, "abc123");
    assert.equal(events[1].text, "Hello ");
    assert.equal(events[3].name, "bash");

    const loggedArgs = readArgsLog(argsLog);
    assert.ok(loggedArgs.includes("--resume"));
    assert.ok(loggedArgs.includes("--fork-session"));
    assert.ok(loggedArgs.includes("acceptEdits"));

    // New session: no --resume/--fork-session.
    await collect(adapter.send({ id: null, cwd: home, fork: false }, "hi", new AbortController().signal));
    const newArgs = readArgsLog(argsLog);
    assert.ok(!newArgs.includes("--resume"));
    assert.ok(!newArgs.includes("--fork-session"));
  } finally {
    delete process.env.ARGS_LOG_FILE;
  }
});

test("claude send(): surfaces permission_denials as notice and is_error as error", async () => {
  const home = makeTmpHome("claude-send-err-");
  const cli = writeFakeCli(
    home,
    "fake-claude",
    `
const lines = [
  { type: "system", session_id: "s1" },
  { type: "result", permission_denials: [{ tool: "bash" }], is_error: true, result: "boom" },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
  );
  const adapter = createClaudeAdapter({ home, bin: cli });
  const events = await collect(adapter.send({ id: null, cwd: home, fork: false }, "hi", new AbortController().signal));
  const types = events.map((e) => e.type);
  assert.ok(types.includes("notice"));
  assert.ok(types.includes("error"));
  assert.equal(types.at(-1), "done");
});

test("claude and pi send(): a clean exit in an unrecognized output format says so instead of going silent", async () => {
  const home = makeTmpHome("format-changed-");
  const body = `process.stdout.write(JSON.stringify({ type: "renamed_event", text: "hello" }) + "\\n");`;
  for (const adapter of [
    createClaudeAdapter({ home, bin: writeFakeCli(home, "fake-claude-new", body) }),
    createPiAdapter({ home, bin: writeFakeCli(home, "fake-pi-new", body) }),
  ]) {
    const events = await collect(adapter.send({ id: null, cwd: home, fork: false }, "hi", new AbortController().signal));
    assert.deepEqual(events.map((e) => e.type), ["notice", "done"]);
    assert.match(events[0].message, /may not be supported yet/);
  }
});

// ---------------------------------------------------------------------------
// Pi
// ---------------------------------------------------------------------------

test("pi listSessions: session_info name wins, falls back to first user message", async () => {
  const home = makeTmpHome("pi-home-");
  cpSync(path.join(FIXTURES, "pi"), path.join(home, ".pi"), { recursive: true });
  utimesSync(
    path.join(home, ".pi/agent/sessions/--tmp-fixture-a--/2024-01-01T00-00-00-000Z_pi-session-a.jsonl"),
    new Date(1_700_000_100_000),
    new Date(1_700_000_100_000),
  );
  utimesSync(
    path.join(home, ".pi/agent/sessions/--tmp-fixture-b--/2024-01-02T00-00-00-000Z_pi-session-b.jsonl"),
    new Date(1_700_000_200_000),
    new Date(1_700_000_200_000),
  );
  const adapter = createPiAdapter({ home, bin: "pi-does-not-exist" });
  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 2);
  const a = sessions.find((s) => s.id === "pi-session-a");
  assert.equal(a.title, "Refactor parser session");
  assert.equal(a.cwd, "/tmp/fixture-a");
  assert.equal(a.model, "anthropic/claude-sonnet-4-5");
  assert.equal(a.harness, "pi");
  assert.equal(a.key, "pi:pi-session-a");

  const b = sessions.find((s) => s.id === "pi-session-b");
  assert.equal(b.title, "Explain the retry logic");
  assert.equal(b.model, undefined);

  // Most recently modified file sorts first.
  assert.equal(sessions[0].id, "pi-session-b");
});

test("pi send(): maps message_update text_delta and tool events, honors --fork/--session/new-session", async () => {
  const home = makeTmpHome("pi-send-");
  const argsLog = path.join(home, "args.json");
  const cli = writeFakeCli(
    home,
    "fake-pi",
    `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGS_LOG_FILE) fs.writeFileSync(process.env.ARGS_LOG_FILE, JSON.stringify(args));
const lines = [
  { type: "session", id: "pi-new-id", cwd: process.cwd() },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi " } },
  { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "there" } },
  { type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: {} },
  { type: "agent_settled" },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
  );

  const adapter = createPiAdapter({ home, bin: cli });
  process.env.ARGS_LOG_FILE = argsLog;
  try {
    const events = await collect(adapter.send({ id: null, cwd: home, fork: false }, "hi", new AbortController().signal));
    assert.deepEqual(
      events.map((e) => e.type),
      ["session", "delta", "delta", "tool", "done"],
    );
    assert.equal(events[0].id, "pi-new-id");
    assert.equal(events[1].text, "Hi ");
    assert.equal(events[3].name, "bash");

    const newArgs = readArgsLog(argsLog);
    assert.ok(!newArgs.includes("--session"));
    assert.ok(!newArgs.includes("--fork"));
    assert.ok(newArgs.includes("--mode"));
    assert.ok(newArgs.includes("json"));

    await collect(adapter.send({ id: "pi-session-a", cwd: home, fork: true }, "hi", new AbortController().signal));
    const forkArgs = readArgsLog(argsLog);
    assert.ok(forkArgs.includes("--fork"));
  } finally {
    delete process.env.ARGS_LOG_FILE;
  }
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function createOpenCodeFixtureDb(home) {
  const dbDir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "opencode.db"));
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER,
      model TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO session (id, parent_id, directory, title, time_updated, time_archived, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("ses-1", null, "/tmp/fixture-a", "Fix build script", 1_700_000_200_000, null, JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }));
  insert.run("ses-2", null, "/tmp/fixture-b", "Older session", 1_700_000_100_000, null, JSON.stringify({ id: "gpt-4o", providerID: "openai" }));
  insert.run("ses-3", null, "/tmp/fixture-c", "Archived session", 1_700_000_300_000, 1_700_000_400_000, null);
  insert.run("ses-4", "ses-1", "/tmp/fixture-a", "Child session", 1_700_000_500_000, null, null);
  db.close();
}

test("opencode listSessions: reads session table, skips children and archived", async () => {
  const home = makeTmpHome("opencode-home-");
  createOpenCodeFixtureDb(home);
  const adapter = createOpenCodeAdapter({ home, bin: "opencode-does-not-exist" });
  const sessions = await adapter.listSessions();

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, "ses-1");
  assert.equal(sessions[0].title, "Fix build script");
  assert.equal(sessions[0].cwd, "/tmp/fixture-a");
  assert.equal(sessions[0].model, "anthropic/claude-sonnet-4-5");
  assert.equal(sessions[0].harness, "opencode");
  assert.equal(sessions[0].key, "opencode:ses-1");
  assert.equal(sessions[1].id, "ses-2");
});

// ---------------------------------------------------------------------------
// OpenCode send(): warm `opencode serve` + HTTP/SSE
// ---------------------------------------------------------------------------

/**
 * Writes a fake `opencode` CLI that understands `--version` and `serve`.
 * `serve` starts a real (loopback) HTTP server implementing just enough of
 * the OpenCode server API (basic-auth, /session, /session/:id/fork,
 * /session/:id/prompt_async, /session/:id/permissions/:id, and an
 * `/event` SSE stream) to drive the adapter's warm-server code path.
 *
 * Behavior is driven by env vars read at spawn time:
 * - OPENCODE_TEST_CONFIG: JSON `{ createId, forkId, eventsBySession }` —
 *   `eventsBySession[sessionId]` is an array of SSE event objects replayed
 *   (with a small stagger) to all connected /event subscribers once a
 *   prompt_async lands for that session.
 * - PROMPT_LOG_FILE / PERMISSION_LOG_FILE: optional NDJSON append logs.
 * - SPAWN_LOG_FILE: optional log appended to once per `serve` invocation,
 *   used to assert the adapter only ever spawns one warm process.
 */
function writeFakeOpenCodeServer(dir) {
  return writeFakeCli(
    dir,
    "fake-opencode",
    `
const http = require("http");
const fs = require("fs");
const urlMod = require("url");

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.99.0\\n");
  process.exit(0);
}

if (args[0] !== "serve") {
  process.stderr.write("unsupported subcommand\\n");
  process.exit(1);
}

if (process.env.SPAWN_LOG_FILE) fs.appendFileSync(process.env.SPAWN_LOG_FILE, "spawn\\n");

const password = process.env.OPENCODE_SERVER_PASSWORD || "";
const config = JSON.parse(process.env.OPENCODE_TEST_CONFIG || "{}");
const promptLogFile = process.env.PROMPT_LOG_FILE;
const permissionLogFile = process.env.PERMISSION_LOG_FILE;

const clients = [];

function checkAuth(req, res) {
  const expected = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  if (req.headers["authorization"] !== expected) {
    res.writeHead(401);
    res.end();
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function broadcast(event) {
  const line = "data: " + JSON.stringify(event) + "\\n\\n";
  for (const res of clients) res.write(line);
}

function sendEventsFor(sessionId) {
  const events = (config.eventsBySession && config.eventsBySession[sessionId]) || [];
  let delay = 10;
  for (const evt of events) {
    setTimeout(() => broadcast(evt), delay);
    delay += 15;
  }
}

const server = http.createServer((req, res) => {
  (async () => {
    const parsed = urlMod.parse(req.url, true);
    if (!checkAuth(req, res)) return;

    if (parsed.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("data: " + JSON.stringify({ type: "server.connected", properties: {} }) + "\\n\\n");
      clients.push(res);
      req.on("close", () => {
        const idx = clients.indexOf(res);
        if (idx >= 0) clients.splice(idx, 1);
      });
      return;
    }

    if (parsed.pathname === "/session" && req.method === "POST") {
      await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: config.createId || "ses-new" }));
      return;
    }

    const reply = /^\\/(permission|question)\\/([^/]+)\\/(reply|reject)$/.exec(parsed.pathname);
    if (reply && req.method === "POST") {
      const body = await readBody(req);
      if (permissionLogFile) {
        fs.appendFileSync(permissionLogFile, JSON.stringify({ kind: reply[1], permissionId: reply[2], action: reply[3], body }) + "\\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
      return;
    }

    if (parsed.pathname.indexOf("/session/") === 0) {
      const rest = parsed.pathname.slice("/session/".length);
      const segments = rest.split("/");

      if (segments.length === 2 && segments[1] === "fork" && req.method === "POST") {
        await readBody(req);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: config.forkId || "ses-forked" }));
        return;
      }

      if (segments.length === 2 && segments[1] === "prompt_async" && req.method === "POST") {
        const body = await readBody(req);
        const sessionId = segments[0];
        if (promptLogFile) fs.appendFileSync(promptLogFile, JSON.stringify({ sessionId, body }) + "\\n");
        res.writeHead(204);
        res.end();
        sendEventsFor(sessionId);
        return;
      }

      if (segments.length === 2 && segments[1] === "abort" && req.method === "POST") {
        if (permissionLogFile) fs.appendFileSync(permissionLogFile, JSON.stringify({ kind: "abort", sessionId: segments[0] }) + "\\n");
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
        return;
      }

      if (segments.length === 3 && segments[1] === "permissions" && req.method === "POST") {
        const body = await readBody(req);
        if (permissionLogFile) {
          fs.appendFileSync(permissionLogFile, JSON.stringify({ sessionId: segments[0], permissionId: segments[2], body }) + "\\n");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
    }

    res.writeHead(404);
    res.end();
  })();
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write("opencode server listening on http://127.0.0.1:" + port + "\\n");
});
`,
  );
}

function readNdjson(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("opencode send(): new session streams assistant text, a tool event, and auto-rejects a permission ask", async () => {
  const home = makeTmpHome("opencode-warm-new-");
  const promptLogFile = path.join(home, "prompts.ndjson");
  const permissionLogFile = path.join(home, "permissions.ndjson");

  const config = {
    createId: "ses-warm-new",
    eventsBySession: {
      "ses-warm-new": [
        { type: "message.updated", properties: { sessionID: "ses-warm-new", info: { id: "msg-user", role: "user" } } },
        { type: "message.updated", properties: { sessionID: "ses-warm-new", info: { id: "msg-asst", role: "assistant" } } },
        {
          type: "message.part.updated",
          properties: { part: { id: "prt-text", sessionID: "ses-warm-new", messageID: "msg-asst", type: "text", text: "" } },
        },
        {
          type: "message.part.delta",
          properties: { sessionID: "ses-warm-new", messageID: "msg-asst", partID: "prt-text", field: "text", delta: "Hello there" },
        },
        {
          type: "message.part.updated",
          properties: { part: { id: "prt-tool", sessionID: "ses-warm-new", messageID: "msg-asst", type: "tool", tool: "bash" } },
        },
        {
          type: "permission.updated",
          properties: { id: "perm-1", sessionID: "ses-warm-new", type: "bash", title: "run bash" },
        },
        { type: "session.idle", properties: { sessionID: "ses-warm-new" } },
      ],
    },
  };

  const adapter = createOpenCodeAdapter({ home, bin: writeFakeOpenCodeServer(home) });
  process.env.OPENCODE_TEST_CONFIG = JSON.stringify(config);
  process.env.PROMPT_LOG_FILE = promptLogFile;
  process.env.PERMISSION_LOG_FILE = permissionLogFile;
  try {
    const events = await collect(
      adapter.send({ id: null, cwd: "/tmp/opencode-warm-fixture", model: "anthropic/claude-3-opus", fork: false }, "hi", new AbortController().signal),
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["session", "delta", "tool", "notice", "done"],
    );
    assert.equal(events[0].id, "ses-warm-new");
    assert.equal(events[1].text, "Hello there");
    assert.equal(events[2].name, "bash");
    assert.match(events[3].message, /auto-rejected/);

    const prompts = readNdjson(promptLogFile);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, "ses-warm-new");
    assert.equal(prompts[0].body.parts[0].text, "hi");
    assert.deepEqual(prompts[0].body.model, { providerID: "anthropic", modelID: "claude-3-opus" });

    const permissionCalls = readNdjson(permissionLogFile);
    assert.equal(permissionCalls.length, 1);
    assert.equal(permissionCalls[0].permissionId, "perm-1");
    assert.equal(permissionCalls[0].body.response, "reject");
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
    delete process.env.PROMPT_LOG_FILE;
    delete process.env.PERMISSION_LOG_FILE;
  }
});

test("opencode send(): rejects permission and question prompts from a subagent session (OpenCode 1.x events)", async () => {
  const home = makeTmpHome("opencode-subagent-ask-");
  const permissionLogFile = path.join(home, "permissions.ndjson");
  const config = {
    createId: "ses-parent",
    eventsBySession: {
      "ses-parent": [
        { type: "session.created", properties: { sessionID: "ses-child", info: { id: "ses-child", parentID: "ses-parent" } } },
        { type: "permission.asked", properties: { id: "per-other", sessionID: "ses-unrelated", permission: "bash", patterns: [], metadata: {}, always: [] } },
        { type: "permission.asked", properties: { id: "per-child", sessionID: "ses-child", permission: "external_directory", patterns: ["/tmp/*"], metadata: {}, always: [] } },
        { type: "question.asked", properties: { id: "que-child", sessionID: "ses-child", questions: [] } },
        { type: "session.idle", properties: { sessionID: "ses-parent" } },
      ],
    },
  };

  const adapter = createOpenCodeAdapter({ home, bin: writeFakeOpenCodeServer(home) });
  process.env.OPENCODE_TEST_CONFIG = JSON.stringify(config);
  process.env.PERMISSION_LOG_FILE = permissionLogFile;
  try {
    const events = await collect(
      adapter.send({ id: null, cwd: "/tmp/opencode-subagent-fixture", fork: false }, "hi", new AbortController().signal),
    );
    assert.deepEqual(events.map((e) => e.type), ["session", "notice", "notice", "done"]);
    assert.match(events[1].message, /external_directory.*auto-rejected/);
    await new Promise((r) => setTimeout(r, 100));
    const calls = readNdjson(permissionLogFile);
    assert.deepEqual(
      calls.map((c) => [c.kind, c.permissionId, c.action, c.body.reply]).sort(),
      [["permission", "per-child", "reply", "reject"], ["question", "que-child", "reject", undefined]],
    );
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
    delete process.env.PERMISSION_LOG_FILE;
  }
});

test("opencode send(): cancelling a turn aborts the run in OpenCode, finishing one does not", async () => {
  const home = makeTmpHome("opencode-abort-");
  const logFile = path.join(home, "calls.ndjson");
  const bin = writeFakeOpenCodeServer(home);
  process.env.PERMISSION_LOG_FILE = logFile;
  try {
    // Finishes normally: no abort. (Each adapter starts its own fake server with the current config.)
    process.env.OPENCODE_TEST_CONFIG = JSON.stringify({ createId: "ses-done", eventsBySession: { "ses-done": [{ type: "session.idle", properties: { sessionID: "ses-done" } }] } });
    await collect(createOpenCodeAdapter({ home, bin }).send({ id: null, cwd: "/tmp/opencode-abort-fixture", fork: false }, "hi", new AbortController().signal));
    // Still running when the listener cancels: the run is aborted.
    process.env.OPENCODE_TEST_CONFIG = JSON.stringify({ createId: "ses-slow", eventsBySession: {} });
    const controller = new AbortController();
    const events = [];
    for await (const event of createOpenCodeAdapter({ home, bin }).send({ id: null, cwd: "/tmp/opencode-abort-fixture", fork: false }, "hi", controller.signal)) {
      events.push(event.type);
      if (event.type === "session") controller.abort();
    }
    assert.deepEqual(events, ["session", "done"]);
    assert.deepEqual(readNdjson(logFile).filter((c) => c.kind === "abort").map((c) => c.sessionId), ["ses-slow"]);
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
    delete process.env.PERMISSION_LOG_FILE;
  }
});

test("opencode checkEventContract(): reports events missing from the server's API description", async () => {
  const docs = [
    JSON.stringify({ openapi: "3.1.0", events: ["permission.asked", "session.idle", "session.error", "message.part.delta", "message.part.updated"] }),
    JSON.stringify({ openapi: "3.1.0", events: ["permission.v3.asked", "session.idle", "session.error", "message.part.delta", "message.part.updated"] }),
    "not a spec",
  ];
  let next = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("opencode:pw").toString("base64")) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(docs[next++]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await checkEventContract(base, "pw"), []);
    assert.deepEqual(await checkEventContract(base, "pw"), ["permission.asked or permission.updated"]);
    assert.deepEqual(await checkEventContract(base, "pw"), []);
    assert.deepEqual(await checkEventContract(base, "wrong"), []);
  } finally {
    server.close();
  }
});

test("opencode send(): reuses an existing session id as-is, and hits the fork endpoint when forking", async () => {
  const home = makeTmpHome("opencode-warm-reuse-");
  const config = {
    forkId: "ses-warm-forked",
    eventsBySession: {
      "ses-existing": [{ type: "session.idle", properties: { sessionID: "ses-existing" } }],
      "ses-warm-forked": [{ type: "session.idle", properties: { sessionID: "ses-warm-forked" } }],
    },
  };

  const adapter = createOpenCodeAdapter({ home, bin: writeFakeOpenCodeServer(home) });
  process.env.OPENCODE_TEST_CONFIG = JSON.stringify(config);
  try {
    const reuseEvents = await collect(
      adapter.send({ id: "ses-existing", cwd: "/tmp/opencode-warm-fixture", fork: false }, "hi", new AbortController().signal),
    );
    assert.equal(reuseEvents[0].type, "session");
    assert.equal(reuseEvents[0].id, "ses-existing");

    const forkEvents = await collect(
      adapter.send({ id: "ses-existing", cwd: "/tmp/opencode-warm-fixture", fork: true }, "hi", new AbortController().signal),
    );
    assert.equal(forkEvents[0].type, "session");
    assert.equal(forkEvents[0].id, "ses-warm-forked");
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
  }
});

test("opencode send(): surfaces session.error as an error event", async () => {
  const home = makeTmpHome("opencode-warm-error-");
  const config = {
    createId: "ses-warm-err",
    eventsBySession: {
      "ses-warm-err": [
        {
          type: "session.error",
          properties: { sessionID: "ses-warm-err", error: { name: "UnknownError", data: { message: "boom" } } },
        },
      ],
    },
  };

  const adapter = createOpenCodeAdapter({ home, bin: writeFakeOpenCodeServer(home) });
  process.env.OPENCODE_TEST_CONFIG = JSON.stringify(config);
  try {
    const events = await collect(
      adapter.send({ id: null, cwd: "/tmp/opencode-warm-fixture", fork: false }, "hi", new AbortController().signal),
    );
    assert.deepEqual(
      events.map((e) => e.type),
      ["session", "error", "done"],
    );
    assert.equal(events[1].message, "boom");
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
  }
});

test("opencode send(): reuses one warm `opencode serve` process across turns", async () => {
  const home = makeTmpHome("opencode-warm-reuse-proc-");
  const spawnLogFile = path.join(home, "spawns.log");
  const config = {
    createId: "ses-a",
    eventsBySession: {
      "ses-a": [{ type: "session.idle", properties: { sessionID: "ses-a" } }],
    },
  };

  const adapter = createOpenCodeAdapter({ home, bin: writeFakeOpenCodeServer(home) });
  process.env.OPENCODE_TEST_CONFIG = JSON.stringify(config);
  process.env.SPAWN_LOG_FILE = spawnLogFile;
  try {
    await collect(adapter.send({ id: null, cwd: "/tmp/opencode-warm-fixture", fork: false }, "hi", new AbortController().signal));
    await collect(adapter.send({ id: "ses-a", cwd: "/tmp/opencode-warm-fixture", fork: false }, "hi again", new AbortController().signal));

    const spawns = readFileSync(spawnLogFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(spawns.length, 1);
  } finally {
    delete process.env.OPENCODE_TEST_CONFIG;
    delete process.env.SPAWN_LOG_FILE;
  }
});

// ---------------------------------------------------------------------------
// index.ts: createAdapters / listAllSessions
// ---------------------------------------------------------------------------

test("createAdapters: fallback order is [pi, opencode, claude]", () => {
  const adapters = createAdapters({ home: makeTmpHome("order-") });
  assert.deepEqual(
    adapters.map((a) => a.id),
    ["pi", "opencode", "claude"],
  );
});

test("listAllSessions: merges and sorts by updatedAt across adapters, honoring limit", async () => {
  const home = makeTmpHome("merge-home-");
  cpSync(path.join(FIXTURES, "pi"), path.join(home, ".pi"), { recursive: true });
  cpSync(path.join(FIXTURES, "claude"), path.join(home, ".claude"), { recursive: true });
  createOpenCodeFixtureDb(home);

  const adapters = createAdapters({ home });
  const all = await listAllSessions(adapters);
  assert.ok(all.length >= 5);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1].updatedAt >= all[i].updatedAt);
  }

  const limited = await listAllSessions(adapters, 2);
  assert.equal(limited.length, 2);
});
