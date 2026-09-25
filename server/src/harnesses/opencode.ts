import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessAdapter, SendTarget, SessionInfo, TurnEvent } from "./types.js";

interface OpenCodeOptions {
  home?: string;
  bin?: string;
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_updated: number;
  time_archived: number | null;
  model: string | null;
}

function parseModel(raw: string | null): string | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as { id?: string; providerID?: string };
    if (obj.id && obj.providerID) return `${obj.providerID}/${obj.id}`;
  } catch {
    // ignore malformed model json
  }
  return undefined;
}

function readCmdline(pid: string): string[] {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter((v) => v.length > 0);
  } catch {
    return [];
  }
}

interface OpenOpenCodeProcess {
  cwd: string;
  sessionArg?: string;
  port?: number;
}

function findOpenOpenCodeProcesses(): OpenOpenCodeProcess[] {
  const results: OpenOpenCodeProcess[] = [];
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
    if (!scriptArg || !/\/(opencode|opencode\.exe)$/.test(scriptArg)) continue;
    const sub = args[isNode ? 2 : 1];
    if (sub === "run" || sub === "serve" || sub === "db" || sub === "session") continue;
    let cwd: string | undefined;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (!cwd) continue;
    let sessionArg: string | undefined;
    const sIdx = args.findIndex((a) => a === "-s" || a === "--session");
    if (sIdx >= 0 && args[sIdx + 1]) sessionArg = args[sIdx + 1];
    let port: number | undefined;
    const pIdx = args.findIndex((a) => a === "--port");
    if (pIdx >= 0 && args[pIdx + 1] && /^\d+$/.test(args[pIdx + 1]!)) port = Number(args[pIdx + 1]);
    results.push({ cwd, sessionArg, port });
  }
  return results;
}

const globalLivePorts = new Map<string, number>();

/** Returns the local HTTP port for `sessionId` if a live opencode process currently has it open, else undefined. */
export function openCodeLivePort(sessionId: string): number | undefined {
  return globalLivePorts.get(sessionId);
}

export function createOpenCodeAdapter(options: OpenCodeOptions = {}): HarnessAdapter {
  const home = options.home ?? homedir();
  const bin = options.bin ?? "opencode";
  const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");

  let availableCache: { value: boolean; at: number } | undefined;

  async function checkAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(bin, ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    });
  }

  function openDb(): DatabaseSync | undefined {
    try {
      return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return undefined;
    }
  }

  return {
    id: "opencode",
    label: "OpenCode",

    async available(): Promise<boolean> {
      const now = Date.now();
      if (availableCache && now - availableCache.at < 60_000) return availableCache.value;
      const value = await checkAvailable();
      availableCache = { value, at: now };
      return value;
    },

    async listSessions(limit?: number): Promise<SessionInfo[]> {
      const db = openDb();
      if (!db) return [];
      let rows: SessionRow[];
      try {
        rows = db
          .prepare(
            "SELECT id, parent_id, directory, title, time_updated, time_archived, model FROM session WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC" +
              (limit ? " LIMIT ?" : ""),
          )
          .all(...(limit ? [limit] : [])) as unknown as SessionRow[];
      } finally {
        db.close();
      }

      const procs = findOpenOpenCodeProcesses();
      const openBySessionArg = new Map<string, OpenOpenCodeProcess>();
      const cwdsWithoutExplicitSession = new Set<string>();
      for (const proc of procs) {
        if (proc.sessionArg) openBySessionArg.set(proc.sessionArg, proc);
        else cwdsWithoutExplicitSession.add(proc.cwd);
      }

      globalLivePorts.clear();
      const openIds = new Set<string>();
      for (const [sessionId, proc] of openBySessionArg) {
        openIds.add(sessionId);
        if (proc.port) globalLivePorts.set(sessionId, proc.port);
      }
      for (const cwd of cwdsWithoutExplicitSession) {
        const match = rows.find((r) => r.directory === cwd);
        if (match) openIds.add(match.id);
      }

      return rows.map((r) => ({
        key: `opencode:${r.id}`,
        harness: "opencode",
        id: r.id,
        title: r.title,
        cwd: r.directory,
        updatedAt: r.time_updated,
        open: openIds.has(r.id),
        model: parseModel(r.model),
      }));
    },

    async *send(target: SendTarget, text: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
      const port = target.id ? globalLivePorts.get(target.id) : undefined;
      if (port && !target.fork) {
        yield* sendViaHttp(port, target, text, signal);
        return;
      }

      const args: string[] = ["run"];
      if (target.id) {
        args.push("-s", target.id);
        if (target.fork) args.push("--fork");
      }
      args.push("--format", "json");
      if (target.model) args.push("-m", target.model);
      args.push(text);

      const child = spawn(bin, args, {
        cwd: target.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });

      let stderrTail = "";
      let sawAutoReject = false;
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderrTail = (stderrTail + text).slice(-4000);
        if (/permission requested.*auto-rejecting/i.test(text)) sawAutoReject = true;
      });

      let buffered = "";
      const events: TurnEvent[] = [];
      let resolveNext: (() => void) | undefined;
      let ended = false;
      let exitCode: number | null = null;
      let sessionEmitted = false;

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (/permission requested.*auto-rejecting/i.test(text)) sawAutoReject = true;
        buffered += text;
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
        const part = obj.part as Record<string, unknown> | undefined;
        if (!sessionEmitted) {
          const sid = part?.sessionID;
          if (typeof sid === "string") {
            sessionEmitted = true;
            events.push({ type: "session", id: sid });
          }
        }
        if (type === "text" && part && typeof part.text === "string") {
          events.push({ type: "delta", text: part.text });
        } else if (type === "tool_use" && part) {
          const name = (part as Record<string, unknown>).tool ?? (part as Record<string, unknown>).name;
          if (typeof name === "string") events.push({ type: "tool", name });
        } else if (type === "error") {
          const message = typeof obj.message === "string" ? obj.message : "opencode reported an error";
          events.push({ type: "error", message });
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
        if (sawAutoReject) {
          yield { type: "notice", message: "a tool permission request was auto-rejected" };
        }
        if (exitCode !== 0 && exitCode !== null) {
          yield { type: "error", message: stderrTail.trim() || `opencode exited with code ${exitCode}` };
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        yield { type: "done" };
      }
    },
  };
}

async function* sendViaHttp(
  port: number,
  target: SendTarget,
  text: string,
  signal: AbortSignal,
): AsyncIterable<TurnEvent> {
  const sessionId = target.id!;
  const base = `http://127.0.0.1:${port}`;
  const events: TurnEvent[] = [{ type: "session", id: sessionId }];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let errored: string | undefined;

  const partMessage = new Map<string, string>();

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  const streamPromise = (async () => {
    try {
      const res = await fetch(`${base}/event`, { signal: controller.signal });
      if (!res.ok || !res.body) {
        errored = `failed to connect to opencode event stream (${res.status})`;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buffered += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffered.indexOf("\n\n")) >= 0) {
          const chunk = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          handleSseEvent(payload);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) errored = String(err);
    } finally {
      done = true;
      resolveNext?.();
    }
  })();

  function handleSseEvent(payload: Record<string, unknown>) {
    const type = payload.type;
    const props = payload.properties as Record<string, unknown> | undefined;
    if (type === "message.part.updated" || type === "message.part.delta") {
      const part = props?.part as Record<string, unknown> | undefined;
      if (part?.sessionID !== sessionId) return;
      if (part.type === "text" && typeof part.text === "string" && typeof part.id === "string") {
        const prev = partMessage.get(part.id) ?? "";
        const full = part.text;
        const delta = full.startsWith(prev) ? full.slice(prev.length) : full;
        if (delta) events.push({ type: "delta", text: delta });
        partMessage.set(part.id, full);
      }
    } else if (type === "session.idle") {
      const info = props?.info as Record<string, unknown> | undefined;
      const idleSessionId = props?.sessionID ?? info?.id;
      if (idleSessionId === sessionId) {
        done = true;
      }
    }
    resolveNext?.();
  }

  try {
    const res = await fetch(`${base}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      events.push({ type: "error", message: `failed to send prompt (${res.status})` });
      done = true;
    }
  } catch (err) {
    events.push({ type: "error", message: String(err) });
    done = true;
  }

  try {
    while (true) {
      while (events.length > 0) {
        yield events.shift()!;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
    if (errored) yield { type: "error", message: errored };
  } finally {
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    await streamPromise;
    yield { type: "done" };
  }
}
