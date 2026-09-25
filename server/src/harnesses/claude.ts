import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { HarnessAdapter, SendTarget, SessionInfo, TurnEvent } from "./types.js";

const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 32 * 1024;

interface ClaudeOptions {
  home?: string;
  bin?: string;
}

/** True if `pid` refers to a currently-running process. */
function pidAlive(pid: number): boolean {
  if (process.platform === "darwin") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  return existsSync(`/proc/${pid}`);
}

function isRealUserText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
        text = (block as { text?: string }).text;
        if (text) break;
      }
    }
  }
  if (!text) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("<command-") ||
    trimmed.startsWith("<local-command") ||
    trimmed.startsWith("<system-reminder>")
  ) {
    return undefined;
  }
  return trimmed;
}

/** Reads the last `maxBytes` of a file as text (or the whole file if smaller). */
function readTail(file: string, maxBytes: number): string {
  const size = statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(file, "r");
  try {
    const len = size - start;
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readHead(file: string, maxBytes: number): string {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // partial line at a chunk boundary; skip
    }
  }
  return out;
}

function parseSessionFile(file: string): Omit<SessionInfo, "open" | "busy" | "key" | "harness"> | undefined {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  const head = readHead(file, HEAD_BYTES);
  const tail = stat.size > HEAD_BYTES ? readTail(file, TAIL_BYTES) : head;

  const headLines = parseLines(head);
  const tailLines = stat.size > HEAD_BYTES ? parseLines(tail) : headLines;

  let cwd: string | undefined;
  let id: string | undefined;
  let firstUserText: string | undefined;
  for (const raw of headLines) {
    const line = raw as Record<string, unknown>;
    if (!cwd && typeof line.cwd === "string") cwd = line.cwd;
    if (!id && typeof line.sessionId === "string") id = line.sessionId;
    if (
      firstUserText === undefined &&
      line.type === "user" &&
      line.isMeta !== true &&
      line.message &&
      typeof line.message === "object"
    ) {
      const text = isRealUserText((line.message as Record<string, unknown>).content);
      if (text) firstUserText = text;
    }
  }
  // In case cwd/id weren't in the head (unlikely for the header/first turn), scan tail too.
  if (!cwd || !id) {
    for (const raw of tailLines) {
      const line = raw as Record<string, unknown>;
      if (!cwd && typeof line.cwd === "string") cwd = line.cwd;
      if (!id && typeof line.sessionId === "string") id = line.sessionId;
    }
  }

  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let model: string | undefined;
  for (const raw of tailLines) {
    const line = raw as Record<string, unknown>;
    if (line.type === "custom-title" && typeof line.customTitle === "string") {
      customTitle = line.customTitle;
    }
    if (line.type === "ai-title" && typeof line.aiTitle === "string") {
      aiTitle = line.aiTitle;
    }
    if (line.type === "assistant" && line.message && typeof line.message === "object") {
      const m = (line.message as Record<string, unknown>).model;
      if (typeof m === "string") model = m;
    }
  }

  if (!id) {
    id = path.basename(file, ".jsonl");
  }
  if (!cwd) return undefined;

  const title = customTitle ?? aiTitle ?? firstUserText ?? "(untitled)";

  return {
    id,
    title,
    cwd,
    updatedAt: stat.mtimeMs,
    model,
  };
}

interface OpenSessionEntry {
  sessionId: string;
  busy: boolean;
}

function readOpenSessions(home: string): Map<string, OpenSessionEntry> {
  const dir = path.join(home, ".claude", "sessions");
  const result = new Map<string, OpenSessionEntry>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const pidStr = entry.split(".")[0];
    const pid = Number(pidStr);
    if (!Number.isFinite(pid)) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as {
        pid?: number;
        sessionId?: string;
        status?: string;
      };
      if (!data.sessionId) continue;
      if (!pidAlive(pid)) continue;
      result.set(data.sessionId, { sessionId: data.sessionId, busy: data.status === "busy" });
    } catch {
      // ignore malformed/racy status files
    }
  }
  return result;
}

export function createClaudeAdapter(options: ClaudeOptions = {}): HarnessAdapter {
  const home = options.home ?? homedir();
  const bin = options.bin ?? "claude";
  const projectsDir = path.join(home, ".claude", "projects");

  let availableCache: { value: boolean; at: number } | undefined;

  async function checkAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  return {
    id: "claude",
    label: "Claude Code",

    async available(): Promise<boolean> {
      const now = Date.now();
      if (availableCache && now - availableCache.at < 60_000) return availableCache.value;
      const value = await checkAvailable();
      availableCache = { value, at: now };
      return value;
    },

    async listSessions(limit?: number): Promise<SessionInfo[]> {
      let projectDirs: string[];
      try {
        projectDirs = readdirSync(projectsDir);
      } catch {
        return [];
      }

      const files: string[] = [];
      for (const projectDir of projectDirs) {
        const full = path.join(projectsDir, projectDir);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        let sessionFiles: string[];
        try {
          sessionFiles = readdirSync(full);
        } catch {
          continue;
        }
        for (const sf of sessionFiles) {
          if (sf.endsWith(".jsonl")) files.push(path.join(full, sf));
        }
      }

      const withMtime = files
        .map((file) => {
          try {
            return { file, mtimeMs: statSync(file).mtimeMs };
          } catch {
            return undefined;
          }
        })
        .filter((v): v is { file: string; mtimeMs: number } => v !== undefined)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const capped = limit ? withMtime.slice(0, limit) : withMtime;
      const openSessions = readOpenSessions(home);

      const sessions: SessionInfo[] = [];
      for (const { file } of capped) {
        const parsed = parseSessionFile(file);
        if (!parsed) continue;
        const openEntry = openSessions.get(parsed.id);
        sessions.push({
          key: `claude:${parsed.id}`,
          harness: "claude",
          id: parsed.id,
          title: parsed.title,
          cwd: parsed.cwd,
          updatedAt: parsed.updatedAt,
          open: openEntry !== undefined,
          busy: openEntry?.busy,
          model: parsed.model,
        });
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return limit ? sessions.slice(0, limit) : sessions;
    },

    async *send(target: SendTarget, text: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const args: string[] = ["-p"];
      if (target.id) {
        args.push("--resume", target.id);
        if (target.fork) args.push("--fork-session");
      }
      args.push(
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
      );
      if (target.model) args.push("--model", target.model);
      args.push(text);

      const child = spawn(bin, args, {
        cwd: target.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", onAbort, { once: true });

      let stderrTail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
      });

      const rl = createInterface({ input: child.stdout });
      const events: TurnEvent[] = [];
      let resolveNext: (() => void) | undefined;
      let ended = false;
      let exitCode: number | null = null;
      let sessionEmitted = false;

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(trimmed);
        } catch {
          return;
        }
        const type = obj.type;
        if (type === "system" && typeof obj.session_id === "string") {
          if (!sessionEmitted) {
            sessionEmitted = true;
            events.push({ type: "session", id: obj.session_id });
          }
        } else if (type === "stream_event") {
          const event = obj.event as Record<string, unknown> | undefined;
          if (event?.type === "content_block_delta") {
            const delta = event.delta as Record<string, unknown> | undefined;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              events.push({ type: "delta", text: delta.text });
            }
          }
        } else if (type === "assistant") {
          const message = obj.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") {
                const name = (block as Record<string, unknown>).name;
                if (typeof name === "string") events.push({ type: "tool", name });
              }
            }
          }
        } else if (type === "result") {
          const denials = obj.permission_denials;
          if (Array.isArray(denials) && denials.length > 0) {
            events.push({ type: "notice", message: "a tool call was denied because no one could approve it" });
          }
          if (obj.is_error) {
            const msg = typeof obj.result === "string" ? obj.result : "claude reported an error";
            events.push({ type: "error", message: msg });
          }
        }
        resolveNext?.();
      });

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
          yield { type: "error", message: stderrTail.trim() || `claude exited with code ${exitCode}` };
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        rl.close();
        yield { type: "done" };
      }
    },
  };
}
