import { spawn, type ChildProcessByStdio } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { HarnessAdapter, SendTarget, SessionInfo, TurnEvent } from "./types.js";

interface OpenCodeOptions {
  home?: string;
  bin?: string;
  /**
   * Test-only escape hatch: point at an already-running fake opencode server
   * instead of spawning a real `opencode serve` child. When set, the warm
   * server manager is bypassed entirely.
   */
  testServer?: { baseUrl: string; password: string };
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

/**
 * Test-only escape hatch: synchronously kills every warm `opencode serve`
 * child spawned so far by any adapter in this process. Production code
 * relies on the `process.on("exit")` handler instead; tests call this so
 * `node --test` doesn't hang waiting for the child's stdio pipes to close.
 */
export function _killAllWarmOpenCodeServersForTests(): void {
  for (const child of warmChildrenToKill) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
  }
  warmChildrenToKill.clear();
}

// ---------------------------------------------------------------------------
// Warm `opencode serve` process
//
// `opencode run` pays the full CLI-startup cost (loading plugins, MCP
// servers, providers) on every single voice turn, which is where most of
// the ~37s first-reply latency comes from. Instead we keep one `opencode
// serve` child alive for the process lifetime and talk to it over HTTP,
// creating/forking sessions and streaming replies over its `/event` SSE
// endpoint. The child is started lazily on first use, restarted if it dies,
// and killed when this process exits.
// ---------------------------------------------------------------------------

interface WarmServer {
  child: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  password: string;
  baseUrl: string;
}

const READY_RE = /listening on http:\/\/[^:]+:(\d+)/i;
const SERVER_START_TIMEOUT_MS = 20_000;

const warmChildrenToKill = new Set<ChildProcessByStdio<null, Readable, Readable>>();
let exitHandlerRegistered = false;

function registerExitHandlerOnce(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const child of warmChildrenToKill) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
  });
}

function authHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/** Lazily starts (or reuses) a warm `opencode serve` process for this adapter instance. */
function createWarmServerManager(bin: string) {
  let current: WarmServer | undefined;
  let starting: Promise<WarmServer> | undefined;

  function spawnServer(): Promise<WarmServer> {
    const password = randomBytes(24).toString("hex");
    const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: tmpdir(),
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessByStdio<null, Readable, Readable>;
    warmChildrenToKill.add(child);
    registerExitHandlerOnce();

    return new Promise<WarmServer>((resolve, reject) => {
      let settled = false;
      let stdoutTail = "";
      let stderrTail = "";

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(new Error(`opencode serve did not start within ${SERVER_START_TIMEOUT_MS}ms: ${stdoutTail}${stderrTail}`));
      }, SERVER_START_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdoutTail = (stdoutTail + text).slice(-2000);
        if (settled) return;
        const match = READY_RE.exec(text);
        if (match) {
          settled = true;
          clearTimeout(timer);
          const port = Number(match[1]);
          resolve({ child, port, password, baseUrl: `http://127.0.0.1:${port}` });
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", () => {
        warmChildrenToKill.delete(child);
        if (current?.child === child) current = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`opencode serve exited before it was ready: ${stdoutTail}${stderrTail}`));
        }
      });
    });
  }

  return {
    async ensure(): Promise<WarmServer> {
      if (current && current.child.exitCode === null) return current;
      if (!starting) {
        starting = spawnServer()
          .then((server) => {
            current = server;
            return server;
          })
          .finally(() => {
            starting = undefined;
          });
      }
      return starting;
    },
  };
}

export function createOpenCodeAdapter(options: OpenCodeOptions = {}): HarnessAdapter {
  const home = options.home ?? homedir();
  const bin = options.bin ?? "opencode";
  const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
  const warmServer: { ensure(): Promise<{ baseUrl: string; password: string }> } = options.testServer
    ? { ensure: async () => options.testServer! }
    : createWarmServerManager(bin);

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

    async warmup(): Promise<void> {
      if (await this.available()) await warmServer.ensure();
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

      let server: { baseUrl: string; password: string };
      try {
        server = await warmServer.ensure();
      } catch (err) {
        yield { type: "error", message: `failed to start opencode server: ${err instanceof Error ? err.message : String(err)}` };
        yield { type: "done" };
        return;
      }

      yield* sendViaWarmServer(server, target, text, signal);
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

function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx < 0) return { providerID: model, modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/**
 * Runs one voice turn against a warm `opencode serve` process over HTTP:
 * creates or forks the target session as needed, subscribes to `/event`
 * SSE, sends the prompt via `prompt_async`, and streams back TurnEvents
 * until `session.idle` (or an error/abort) for that session.
 */
async function* sendViaWarmServer(
  server: { baseUrl: string; password: string },
  target: SendTarget,
  text: string,
  signal: AbortSignal,
): AsyncIterable<TurnEvent> {
  const { baseUrl, password } = server;
  const authHeaderValue = authHeader(password);
  const headers = { authorization: authHeaderValue };
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const dirQuery = `directory=${encodeURIComponent(target.cwd)}`;

  const events: TurnEvent[] = [];
  let resolveNext: (() => void) | undefined;
  let done = false;
  let errored: string | undefined;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });

  function push(event: TurnEvent) {
    events.push(event);
    resolveNext?.();
  }

  let sessionId: string;
  try {
    if (target.id && target.fork) {
      const res = await fetch(`${baseUrl}/session/${target.id}/fork?${dirQuery}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`failed to fork session (${res.status})`);
      const data = (await res.json()) as { id: string };
      sessionId = data.id;
    } else if (target.id) {
      sessionId = target.id;
    } else {
      const res = await fetch(`${baseUrl}/session?${dirQuery}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`failed to create session (${res.status})`);
      const data = (await res.json()) as { id: string };
      sessionId = data.id;
    }
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
    yield { type: "done" };
    return;
  }

  push({ type: "session", id: sessionId });

  const roleByMessageId = new Map<string, string>();
  const partTypeByPartId = new Map<string, string>();
  const toolEventsEmitted = new Set<string>();

  const streamPromise = (async () => {
    try {
      const res = await fetch(`${baseUrl}/event?${dirQuery}`, { headers, signal: controller.signal });
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
      if (!controller.signal.aborted) errored = err instanceof Error ? err.message : String(err);
    } finally {
      done = true;
      resolveNext?.();
    }
  })();

  function handleSseEvent(payload: Record<string, unknown>) {
    const type = payload.type;
    const props = payload.properties as Record<string, unknown> | undefined;
    if (!props) return;

    if (type === "message.updated") {
      const info = props.info as Record<string, unknown> | undefined;
      if (info && typeof info.id === "string" && typeof info.role === "string") {
        roleByMessageId.set(info.id, info.role);
      }
      return;
    }

    if (type === "message.part.updated") {
      const part = props.part as Record<string, unknown> | undefined;
      if (!part || part.sessionID !== sessionId) return;
      if (typeof part.id === "string" && typeof part.type === "string") {
        partTypeByPartId.set(part.id, part.type);
      }
      if (part.type === "tool" && typeof part.id === "string" && !toolEventsEmitted.has(part.id)) {
        const name = (part as Record<string, unknown>).tool;
        if (typeof name === "string") {
          toolEventsEmitted.add(part.id);
          push({ type: "tool", name });
        }
      }
      return;
    }

    if (type === "message.part.delta") {
      if (props.sessionID !== sessionId) return;
      const partID = props.partID;
      const messageID = props.messageID;
      const field = props.field;
      const delta = props.delta;
      if (field !== "text" || typeof delta !== "string" || typeof partID !== "string") return;
      if (partTypeByPartId.get(partID) !== "text") return;
      if (typeof messageID === "string" && roleByMessageId.get(messageID) !== "assistant") return;
      if (delta) push({ type: "delta", text: delta });
      return;
    }

    if (type === "permission.updated") {
      if (props.sessionID !== sessionId) return;
      const permissionId = props.id;
      if (typeof permissionId !== "string") return;
      const title = typeof props.title === "string" ? props.title : "a tool";
      push({ type: "notice", message: `a permission request (${title}) was auto-rejected because no one could approve it` });
      fetch(`${baseUrl}/session/${sessionId}/permissions/${permissionId}?${dirQuery}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ response: "reject" }),
        signal: controller.signal,
      }).catch(() => {
        // best effort; the session will otherwise stay blocked on this permission
      });
      return;
    }

    if (type === "session.error") {
      const errSessionId = props.sessionID;
      if (errSessionId !== undefined && errSessionId !== sessionId) return;
      const error = props.error as { data?: { message?: unknown } } | undefined;
      const message = typeof error?.data?.message === "string" ? error.data.message : "opencode reported an error";
      push({ type: "error", message });
      done = true;
      resolveNext?.();
      return;
    }

    if (type === "session.idle") {
      if (props.sessionID === sessionId) done = true;
      resolveNext?.();
    }
  }

  try {
    const res = await fetch(`${baseUrl}/session/${sessionId}/prompt_async?${dirQuery}`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(target.model ? { model: splitModel(target.model) } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      push({ type: "error", message: `failed to send prompt (${res.status})` });
      done = true;
    }
  } catch (err) {
    push({ type: "error", message: err instanceof Error ? err.message : String(err) });
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
    while (events.length > 0) {
      yield events.shift()!;
    }
    if (errored) yield { type: "error", message: errored };
  } finally {
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    await streamPromise;
    yield { type: "done" };
  }
}
