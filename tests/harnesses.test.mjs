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

const FIXTURES = path.join(import.meta.dirname, "fixtures", "harnesses");
const tmpDirs = [];

function makeTmpHome(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
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

test("opencode send(): maps text/tool_use events, honors -s/--fork/new-session", async () => {
  const home = makeTmpHome("opencode-send-");
  createOpenCodeFixtureDb(home);
  const argsLog = path.join(home, "args.json");
  const cli = writeFakeCli(
    home,
    "fake-opencode",
    `
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.ARGS_LOG_FILE) fs.writeFileSync(process.env.ARGS_LOG_FILE, JSON.stringify(args));
const lines = [
  { type: "step_start", part: { sessionID: "ses-new" } },
  { type: "text", part: { sessionID: "ses-new", text: "Hello there" } },
  { type: "tool_use", part: { sessionID: "ses-new", tool: "bash" } },
  { type: "step_finish", part: { sessionID: "ses-new" } },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + "\\n");
`,
  );

  const adapter = createOpenCodeAdapter({ home, bin: cli });
  process.env.ARGS_LOG_FILE = argsLog;
  try {
    const events = await collect(adapter.send({ id: null, cwd: home, fork: false }, "hi", new AbortController().signal));
    assert.deepEqual(
      events.map((e) => e.type),
      ["session", "delta", "tool", "done"],
    );
    assert.equal(events[0].id, "ses-new");
    assert.equal(events[1].text, "Hello there");
    assert.equal(events[2].name, "bash");

    const newArgs = readArgsLog(argsLog);
    assert.ok(!newArgs.includes("-s"));
    assert.ok(!newArgs.includes("--fork"));
    assert.ok(newArgs.includes("run"));

    await collect(adapter.send({ id: "ses-1", cwd: home, fork: true }, "hi", new AbortController().signal));
    const forkArgs = readArgsLog(argsLog);
    assert.ok(forkArgs.includes("-s"));
    assert.ok(forkArgs.includes("--fork"));
  } finally {
    delete process.env.ARGS_LOG_FILE;
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
