import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIALOG_METHODS, PiRpcPool, type PiRpcProcess } from "./pi-rpc.js";
import { describeTool } from "./tool-activity.js";
import type { HarnessAdapter, SendTarget, SessionInfo, TurnEvent } from "./types.js";

/** Loaded into every warm pi process: thinking off for the first reply of each turn (see pi-voice-extension.ts). */
const VOICE_EXTENSION = fileURLToPath(new URL(`./pi-voice-extension${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));

interface PiOptions {
  home?: string;
  bin?: string;
}

/** Mirrors Pi's own path-to-directory-name mangling for the sessions tree. */
function cwdToSessionDirName(cwd: string): string {
  const mangled = cwd.replace(/^[/\\]+/, "").replace(/[/\\:]/g, "-");
  return `--${mangled}--`;
}

function parseJsonl(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function isRealUserText(content: unknown): string | undefined {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        const text = (block as { text?: string }).text;
        if (text && text.trim()) return text.trim();
      }
    }
  }
  return undefined;
}

interface ParsedSession {
  id: string;
  cwd: string;
  title: string;
  model?: string;
  updatedAt: number;
}

/** What a session file said so far; pi appends to its files, so only new lines are read next time. */
interface IndexedSession {
  size: number;
  mtimeMs: number;
  offset: number;
  header?: { id: string; cwd: string };
  invalid: boolean;
  sessionInfoName?: string;
  firstUserText?: string;
  model?: string;
}

const sessionIndex = new Map<string, IndexedSession>();

function readRange(file: string, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function indexLines(entry: IndexedSession, lines: Record<string, unknown>[]): void {
  for (const line of lines) {
    if (!entry.header) {
      if (line.type !== "session" || typeof line.cwd !== "string" || typeof line.id !== "string") {
        entry.invalid = true;
        return;
      }
      entry.header = { id: line.id, cwd: line.cwd };
      continue;
    }
    if (line.type === "session_info" && typeof line.name === "string") {
      entry.sessionInfoName = line.name;
    }
    if (line.type === "model_change" && typeof line.provider === "string" && typeof line.modelId === "string") {
      entry.model = `${line.provider}/${line.modelId}`;
    }
    if (entry.firstUserText === undefined && line.type === "message") {
      const message = line.message as Record<string, unknown> | undefined;
      if (message?.role === "user") {
        const text = isRealUserText(message.content);
        if (text) entry.firstUserText = text;
      }
    }
  }
}

function parseSessionFile(file: string): ParsedSession | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    sessionIndex.delete(file);
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  let entry = sessionIndex.get(file);
  // A file that shrank, or changed without growing, was rewritten: read it again from the start.
  if (entry && (stat.size < entry.offset || (stat.size === entry.size && stat.mtimeMs !== entry.mtimeMs))) entry = undefined;
  if (!entry) {
    entry = { size: 0, mtimeMs: 0, offset: 0, invalid: false };
    sessionIndex.set(file, entry);
  }
  if (!entry.invalid && stat.size > entry.offset) {
    let chunk: Buffer;
    try {
      chunk = readRange(file, entry.offset, stat.size);
    } catch {
      return undefined;
    }
    // Only whole lines: a line pi is still writing is read on the next pass.
    const end = chunk.lastIndexOf(0x0a) + 1;
    if (end > 0) {
      indexLines(entry, parseJsonl(chunk.subarray(0, end).toString("utf8")));
      entry.offset += end;
    }
  }
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  if (entry.invalid || !entry.header) return undefined;

  return {
    id: entry.header.id,
    cwd: entry.header.cwd,
    title: entry.sessionInfoName ?? entry.firstUserText ?? "(untitled)",
    model: entry.model,
    updatedAt: stat.mtimeMs,
  };
}

// Headless `pi` processes this server started for voice turns; never mistaken for a terminal.
const spawnedPids = new Set<number>();

// Warm pi processes of every adapter, stopped with this server.
const pools = new Set<PiRpcPool>();
process.once("exit", () => {
  for (const pool of pools) pool.closeAll();
});

/** Stops every warm pi process (tests). */
export function _closePiProcessesForTests(): void {
  for (const pool of pools) pool.closeAll();
}

function readCmdline(pid: string): string[] {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    // A running pi renames its process to "pi" padded with spaces, which drops the path and arguments.
    return raw.split("\0").map((v) => v.trim()).filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

function readCwd(pid: string): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

interface OpenPiProcess {
  cwd: string;
  sessionArg?: string;
}

/** Whether a process command line is a `pi` CLI, including the bare "pi" title a running pi sets. */
export function isPiCommand(args: string[]): boolean {
  const isNode = /node$/.test(args[0] ?? "");
  const scriptArg = isNode ? args[1] : args[0];
  return Boolean(scriptArg && /(^|\/)(pi|pi-coding-agent)$/.test(scriptArg));
}

/** Finds running `pi` interactive/attached processes (not headless one-shot turns we spawned). */
function findOpenPiProcesses(): OpenPiProcess[] {
  const results: OpenPiProcess[] = [];
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return results;
  }
  for (const pid of pids) {
    const args = readCmdline(pid);
    if (args.length === 0) continue;
    if (!isPiCommand(args)) continue;
    if (spawnedPids.has(Number(pid))) continue;
    if (args.includes("--mode")) {
      const modeIdx = args.indexOf("--mode");
      const mode = args[modeIdx + 1];
      if (mode === "json" || mode === "rpc") continue;
    }
    if (args.includes("-p") || args.includes("--print")) continue;
    const cwd = readCwd(pid);
    if (!cwd) continue;
    let sessionArg: string | undefined;
    const sessionIdx = args.indexOf("--session");
    if (sessionIdx >= 0 && args[sessionIdx + 1]) sessionArg = args[sessionIdx + 1];
    results.push({ cwd, sessionArg });
  }
  return results;
}

export function createPiAdapter(options: PiOptions = {}): HarnessAdapter {
  const home = options.home ?? homedir();
  const bin = options.bin ?? "pi";
  const sessionsDir = path.join(home, ".pi", "agent", "sessions");

  let availableCache: { value: boolean; at: number } | undefined;
  const pool = new PiRpcPool(bin, (proc) => {
    const pid = proc.child.pid;
    if (!pid) return;
    spawnedPids.add(pid);
    proc.onExit(() => spawnedPids.delete(pid));
  });
  pools.add(pool);

  async function checkAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  function listSessionFiles(): string[] {
    let dirs: string[];
    try {
      dirs = readdirSync(sessionsDir);
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const dir of dirs) {
      const full = path.join(sessionsDir, dir);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      let entries: string[];
      try {
        entries = readdirSync(full);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) files.push(path.join(full, entry));
      }
    }
    return files;
  }

  return {
    id: "pi",
    label: "Pi",

    async available(): Promise<boolean> {
      const now = Date.now();
      if (availableCache && now - availableCache.at < 60_000) return availableCache.value;
      const value = await checkAvailable();
      availableCache = { value, at: now };
      return value;
    },

    async listSessions(limit?: number): Promise<SessionInfo[]> {
      const files = listSessionFiles();
      const parsed = files
        .map((file) => parseSessionFile(file))
        .filter((v): v is ParsedSession => v !== undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const openProcs = findOpenPiProcesses();
      const openSessionIds = new Set<string>();
      const cwdsWithoutExplicitSession = new Set<string>();
      for (const proc of openProcs) {
        const sessionArg = proc.sessionArg;
        if (sessionArg) {
          const match = parsed.find((s) => s.id === sessionArg || s.id.startsWith(sessionArg));
          if (match) openSessionIds.add(match.id);
        } else {
          cwdsWithoutExplicitSession.add(proc.cwd);
        }
      }
      for (const cwd of cwdsWithoutExplicitSession) {
        const match = parsed.find((s) => s.cwd === cwd);
        if (match) openSessionIds.add(match.id);
      }

      const capped = limit ? parsed.slice(0, limit) : parsed;
      return capped.map((s) => {
        const open = openSessionIds.has(s.id);
        return {
          key: `pi:${s.id}`,
          harness: "pi",
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          updatedAt: s.updatedAt,
          open,
          model: s.model,
        };
      });
    },

    async *send(target: SendTarget, text: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const sessionFile = target.id ? resolveSessionFile(sessionsDir, target.cwd, target.id) : undefined;
      // Reuse the warm process that has this session open; a fork always starts from the original file.
      let proc = target.fork ? undefined : pool.take(target.id, target.cwd, target.model);
      if (proc && proc.changedOnDisk() && !(await proc.reload())) {
        proc.kill();
        proc = undefined;
      }
      if (!proc) {
        const args: string[] = [];
        if (target.id) args.push(target.fork ? "--fork" : "--session", sessionFile ?? target.id);
        if (target.model) args.push("--model", target.model);
        if (existsSync(VOICE_EXTENSION)) args.push("-e", VOICE_EXTENSION);
        proc = pool.spawn(args, target.cwd, target.model);
        const kill = () => proc!.kill();
        signal.addEventListener("abort", kill, { once: true });
        const started = await proc.start();
        signal.removeEventListener("abort", kill);
        if (!started) {
          proc.kill();
          if (!signal.aborted) {
            // A clean exit that never answered means the CLI's protocol changed.
            if (proc.exitCode === 0 && !proc.spoke) {
              yield { type: "notice", message: "pi finished without a reply meldivo could read; this pi version may not be supported yet, so update meldivo" };
            } else {
              yield { type: "error", message: proc.stderrTail.trim() || (proc.exited ? `pi exited with code ${proc.exitCode}` : "pi did not start") };
            }
          }
          yield { type: "done" };
          return;
        }
        pool.register(proc);
      }
      yield* runPrompt(proc, text, target.cwd, signal);
    },
  };
}

/** Runs one prompt on a warm pi process and streams it as turn events until pi settles. */
async function* runPrompt(proc: PiRpcProcess, text: string, cwd: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
  const events: TurnEvent[] = [];
  let wake: (() => void) | undefined;
  let settled = false;
  let stopped = false;
  let sawText = false;
  let lastError: string | undefined;
  const notify = () => wake?.();

  const offRecord = proc.onRecord((record) => {
    const type = record.type;
    if (type === "message_update") {
      const ev = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        sawText = true;
        events.push({ type: "delta", text: ev.delta });
      }
    } else if (type === "tool_execution_start") {
      const name = record.toolName;
      if (typeof name === "string") events.push({ type: "tool", name, ...describeTool(name, record.args, cwd) });
    } else if (type === "message_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant" && message.stopReason === "error") {
        lastError = typeof message.errorMessage === "string" ? message.errorMessage : "The model request failed";
      }
    } else if (type === "extension_ui_request" && DIALOG_METHODS.has(String(record.method))) {
      events.push({ type: "notice", message: "pi asked for a decision that can't be made by voice, so it was declined" });
    } else if (type === "agent_settled") {
      settled = true;
    }
    notify();
  });
  const offExit = proc.onExit(notify);
  const onAbort = () => {
    void proc.abort().finally(() => {
      stopped = true;
      notify();
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (proc.sessionId) yield { type: "session", id: proc.sessionId };
    const response = await proc.command({ type: "prompt", message: text });
    if (response.success !== true) {
      settled = true;
      if (!signal.aborted) {
        yield { type: "error", message: typeof response.error === "string" ? response.error : "pi did not accept the message" };
      }
    }
    while (true) {
      while (events.length > 0) yield events.shift()!;
      if (settled || stopped || proc.exited) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    while (events.length > 0) yield events.shift()!;
    if (!signal.aborted) {
      if (proc.exited && !settled) {
        yield { type: "error", message: proc.stderrTail.trim() || `pi exited with code ${proc.exitCode}` };
      } else if (settled && !sawText && lastError) {
        yield { type: "error", message: lastError };
      } else if (settled && (!sawText || !proc.sessionId)) {
        yield { type: "notice", message: "pi finished without a reply meldivo could read; this pi version may not be supported yet, so update meldivo" };
      }
    }
  } finally {
    offRecord();
    offExit();
    signal.removeEventListener("abort", onAbort);
    if (!proc.exited) {
      // A caller that stopped reading early (e.g. a warm-up that reached for a tool) must not leave pi running.
      if (!settled && !stopped) await proc.abort();
      proc.settle();
    }
    yield { type: "done" };
  }
}

/** Finds the on-disk session file for `id` under `sessionsDir` for the given cwd's session folder. */
function resolveSessionFile(sessionsDir: string, cwd: string, id: string): string | undefined {
  const dirName = cwdToSessionDirName(cwd);
  const dir = path.join(sessionsDir, dirName);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const match = entries.find((e) => e.endsWith(".jsonl") && e.includes(id));
  return match ? path.join(dir, match) : undefined;
}
