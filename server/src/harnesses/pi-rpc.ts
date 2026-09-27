import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { statSync } from "node:fs";

// One long-lived `pi --mode rpc` process per session, so a voice turn skips pi's startup (extensions,
// MCP servers) and re-reading the session: the process keeps it loaded between turns.
// Protocol: JSON records on stdin/stdout, split on "\n" only (see pi's docs/rpc.md).

export type PiRecord = Record<string, unknown>;

const IDLE_MS = 10 * 60_000;
const MAX_PROCESSES = 4;
const ABORT_GRACE_MS = 3_000;
const START_TIMEOUT_MS = 60_000;
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

interface FileStamp {
  size: number;
  mtimeMs: number;
}

function stampOf(file: string | undefined): FileStamp | undefined {
  if (!file) return undefined;
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

export class PiRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly model: string | undefined;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  busy = false;
  exited = false;
  exitCode: number | null = null;
  lastUsed = Date.now();
  stderrTail = "";
  /** Set once the process has answered a command, i.e. it speaks the RPC protocol. */
  spoke = false;
  private stamp: FileStamp | undefined;
  private nextId = 0;
  private buffered = "";
  private pending = new Map<string, (record: PiRecord) => void>();
  private listeners = new Set<(record: PiRecord) => void>();
  private exitListeners = new Set<() => void>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(bin: string, args: string[], cwd: string, model: string | undefined, onExit: (proc: PiRpcProcess) => void) {
    this.cwd = cwd;
    this.model = model;
    this.child = spawn(bin, ["--mode", "rpc", ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4000);
    });
    const finish = (code: number | null) => {
      if (this.exited) return;
      this.exited = true;
      this.exitCode = code;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      for (const resolve of this.pending.values()) resolve({ type: "response", success: false, error: "pi exited" });
      this.pending.clear();
      for (const listener of this.exitListeners) listener();
      onExit(this);
    };
    this.child.on("close", (code) => finish(code));
    this.child.on("error", (err) => {
      this.stderrTail += `\n${String(err)}`;
      finish(-1);
    });
  }

  private read(chunk: Buffer): void {
    this.buffered += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffered.indexOf("\n")) >= 0) {
      const raw = this.buffered.slice(0, idx).replace(/\r$/, "");
      this.buffered = this.buffered.slice(idx + 1);
      if (!raw.trim()) continue;
      let record: PiRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      if (record.type === "response" && typeof record.id === "string" && this.pending.has(record.id)) {
        this.spoke = true;
        const resolve = this.pending.get(record.id)!;
        this.pending.delete(record.id);
        resolve(record);
        continue;
      }
      // Nobody can answer an extension's dialog during a voice turn: decline it, as a headless run would.
      if (record.type === "extension_ui_request" && typeof record.id === "string" && DIALOG_METHODS.has(String(record.method))) {
        this.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
      }
      for (const listener of this.listeners) listener(record);
    }
  }

  /** Sends one command and resolves with its response (a failed response if pi exits first). */
  command(command: PiRecord, timeoutMs = START_TIMEOUT_MS): Promise<PiRecord> {
    if (this.exited) return Promise.resolve({ type: "response", success: false, error: "pi exited" });
    const id = `meldivo-${++this.nextId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ type: "response", success: false, error: "pi did not answer" });
      }, timeoutMs);
      this.pending.set(id, (record) => {
        clearTimeout(timer);
        resolve(record);
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  onRecord(listener: (record: PiRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Reads the session id and file from pi; resolves false if the process doesn't speak RPC. */
  async start(): Promise<boolean> {
    const state = await this.command({ type: "get_state" });
    if (state.success !== true) return false;
    const data = (state.data ?? {}) as PiRecord;
    if (typeof data.sessionId === "string") this.sessionId = data.sessionId;
    if (typeof data.sessionFile === "string") this.sessionFile = data.sessionFile;
    this.stamp = stampOf(this.sessionFile);
    return true;
  }

  /**
   * Whether something else (a pi open in a terminal, say) wrote to the session file since this
   * process last finished a turn; pi keeps the session in memory, so it must reload first.
   */
  changedOnDisk(): boolean {
    const now = stampOf(this.sessionFile);
    if (!now || !this.stamp) return false;
    return now.size !== this.stamp.size || now.mtimeMs !== this.stamp.mtimeMs;
  }

  async reload(): Promise<boolean> {
    if (!this.sessionFile) return false;
    const response = await this.command({ type: "switch_session", sessionPath: this.sessionFile });
    const cancelled = (response.data as PiRecord | undefined)?.cancelled === true;
    if (response.success !== true || cancelled) return false;
    this.stamp = stampOf(this.sessionFile);
    return true;
  }

  /** Marks the end of a turn: remembers the file as this process left it and starts the idle clock. */
  settle(): void {
    this.busy = false;
    this.lastUsed = Date.now();
    this.stamp = stampOf(this.sessionFile);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref();
  }

  claim(): void {
    this.busy = true;
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** Stops the running prompt; the process stays usable. Falls back to killing it. */
  async abort(): Promise<void> {
    if (this.exited) return;
    const response = await this.command({ type: "abort" }, ABORT_GRACE_MS);
    if (response.success !== true) this.kill();
  }

  /** Orderly shutdown: pi exits when its stdin closes. */
  close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => this.kill(), ABORT_GRACE_MS).unref();
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}

/** Keeps at most a few warm pi processes, keyed by the id of the session they have open. */
export class PiRpcPool {
  private bySession = new Map<string, PiRpcProcess>();
  private all = new Set<PiRpcProcess>();

  constructor(
    private readonly bin: string,
    private readonly onSpawn: (proc: PiRpcProcess) => void = () => undefined,
  ) {}

  /** An idle process that already has session `id` open with the same model and folder, if any. */
  take(id: string | null, cwd: string, model: string | undefined): PiRpcProcess | undefined {
    if (!id) return undefined;
    const proc = this.bySession.get(id);
    // A process started without a model runs the session's own model, which is what a turn
    // that names the session's recorded model asks for.
    if (!proc || proc.exited || proc.busy || proc.cwd !== cwd || (proc.model !== undefined && proc.model !== model)) return undefined;
    proc.claim();
    return proc;
  }

  spawn(args: string[], cwd: string, model: string | undefined): PiRpcProcess {
    this.evict();
    const proc = new PiRpcProcess(this.bin, args, cwd, model, (done) => this.forget(done));
    proc.claim();
    this.all.add(proc);
    this.onSpawn(proc);
    return proc;
  }

  /** Files the process under its session id once pi reports it (new sessions and forks get one on start). */
  register(proc: PiRpcProcess): void {
    if (!proc.sessionId || proc.exited) return;
    const existing = this.bySession.get(proc.sessionId);
    if (existing && existing !== proc) {
      // Two processes on one file would diverge; keep the newer one.
      if (existing.busy) return;
      existing.close();
    }
    this.bySession.set(proc.sessionId, proc);
  }

  private forget(proc: PiRpcProcess): void {
    this.all.delete(proc);
    for (const [id, entry] of this.bySession) if (entry === proc) this.bySession.delete(id);
  }

  /** Closes the least recently used idle processes beyond the limit. */
  private evict(): void {
    const idle = [...this.all].filter((proc) => !proc.busy && !proc.exited).sort((a, b) => a.lastUsed - b.lastUsed);
    let excess = this.all.size + 1 - MAX_PROCESSES;
    for (const proc of idle) {
      if (excess <= 0) break;
      proc.close();
      this.forget(proc);
      excess--;
    }
  }

  closeAll(): void {
    for (const proc of this.all) proc.kill();
    this.all.clear();
    this.bySession.clear();
  }
}
