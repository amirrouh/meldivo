import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessAdapter, SendTarget, SessionInfo, TurnEvent } from "./types.js";

/** Loaded into every turn's pi process: thinking off for the first reply (see pi-voice-extension.ts). */
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

function parseSessionFile(file: string): ParsedSession | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const lines = parseJsonl(text);
  if (lines.length === 0) return undefined;

  const header = lines[0];
  if (header?.type !== "session" || typeof header.cwd !== "string" || typeof header.id !== "string") {
    return undefined;
  }

  let sessionInfoName: string | undefined;
  let firstUserText: string | undefined;
  let model: string | undefined;

  for (const line of lines) {
    if (line.type === "session_info" && typeof line.name === "string") {
      sessionInfoName = line.name;
    }
    if (line.type === "model_change" && typeof line.provider === "string" && typeof line.modelId === "string") {
      model = `${line.provider}/${line.modelId}`;
    }
    if (firstUserText === undefined && line.type === "message") {
      const message = line.message as Record<string, unknown> | undefined;
      if (message?.role === "user") {
        const text = isRealUserText(message.content);
        if (text) firstUserText = text;
      }
    }
  }

  return {
    id: header.id,
    cwd: header.cwd,
    title: sessionInfoName ?? firstUserText ?? "(untitled)",
    model,
    updatedAt: stat.mtimeMs,
  };
}

function readCmdline(pid: string): string[] {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter((v) => v.length > 0);
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
    const isNode = /node$/.test(args[0] ?? "");
    const scriptArg = isNode ? args[1] : args[0];
    if (!scriptArg || !/\/(pi|pi-coding-agent)$/.test(scriptArg)) continue;
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
      const args: string[] = ["--mode", "json"];
      let sessionFile: string | undefined;
      if (target.id) {
        sessionFile = resolveSessionFile(sessionsDir, target.cwd, target.id);
        if (target.fork) {
          args.push("--fork", sessionFile ?? target.id);
        } else {
          args.push("--session", sessionFile ?? target.id);
        }
      }
      if (target.model) args.push("--model", target.model);
      if (existsSync(VOICE_EXTENSION)) args.push("-e", VOICE_EXTENSION);
      args.push(text);

      const child = spawn(bin, args, {
        cwd: target.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });

      let buffered = "";
      const events: TurnEvent[] = [];
      let resolveNext: (() => void) | undefined;
      let ended = false;
      let exitCode: number | null = null;
      // A clean exit with no session id or no reply text means the CLI's output format changed.
      let sawSession = false;
      let sawText = false;

      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let idx: number;
        while ((idx = buffered.indexOf("\n")) >= 0) {
          const raw = buffered.slice(0, idx).replace(/\r$/, "");
          buffered = buffered.slice(idx + 1);
          if (!raw.trim()) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(raw);
          } catch {
            continue;
          }
          handleEvent(obj);
        }
      });

      function handleEvent(obj: Record<string, unknown>) {
        const type = obj.type;
        if (type === "session" && typeof obj.id === "string") {
          sawSession = true;
          events.push({ type: "session", id: obj.id });
        } else if (type === "message_update") {
          const ev = obj.assistantMessageEvent as Record<string, unknown> | undefined;
          if (ev?.type === "text_delta" && typeof ev.delta === "string") {
            sawText = true;
            events.push({ type: "delta", text: ev.delta });
          }
        } else if (type === "tool_execution_start") {
          const name = obj.toolName;
          if (typeof name === "string") events.push({ type: "tool", name });
        }
        resolveNext?.();
      }

      const exitPromise = new Promise<void>((resolve) => {
        child.on("close", (code) => {
          exitCode = code;
          ended = true;
          resolveNext?.();
          resolve();
        });
        child.on("error", (err) => {
          stderrTail += `\n${String(err)}`;
          exitCode = -1;
          ended = true;
          resolveNext?.();
          resolve();
        });
      });

      try {
        while (true) {
          while (events.length > 0) {
            yield events.shift()!;
          }
          if (ended) break;
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        await exitPromise;
        while (events.length > 0) {
          yield events.shift()!;
        }
        if (exitCode !== 0 && exitCode !== null) {
          yield { type: "error", message: stderrTail.trim() || `pi exited with code ${exitCode}` };
        }
        if (exitCode === 0 && (!sawSession || !sawText)) {
          yield { type: "notice", message: "pi finished without a reply meldivo could read; this pi version may not be supported yet, so update meldivo" };
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        yield { type: "done" };
      }
    },
  };
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
