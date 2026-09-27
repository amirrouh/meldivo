import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// One long-lived `claude -p --input-format stream-json` process per session, so a voice turn skips
// Claude Code's startup and re-reading the conversation: the process keeps it loaded between turns.
// Each user message written to stdin produces the usual stream-json events, ending with "result".

export type ClaudeRecord = Record<string, unknown>;

const IDLE_MS = 10 * 60_000;
const MAX_PROCESSES = 4;
const INTERRUPT_GRACE_MS = 3_000;

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

/** The transcript Claude Code keeps for session `id`, in whichever project folder it lives. */
function findTranscript(projectsDir: string, id: string): string | undefined {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = path.join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

export class ClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly model: string | undefined;
  sessionId: string | undefined;
  busy = true;
  exited = false;
  exitCode: number | null = null;
  lastUsed = Date.now();
  stderrTail = "";
  private transcript: string | undefined;
  private stamp: FileStamp | undefined;
  private buffered = "";
  private nextRequest = 0;
  private listeners = new Set<(record: ClaudeRecord) => void>();
  private exitListeners = new Set<() => void>();
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(bin: string, args: string[], cwd: string, model: string | undefined, onExit: (proc: ClaudeProcess) => void) {
    this.cwd = cwd;
    this.model = model;
    this.child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
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
      const raw = this.buffered.slice(0, idx).trim();
      this.buffered = this.buffered.slice(idx + 1);
      if (!raw) continue;
      let record: ClaudeRecord;
      try {
        record = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const listener of this.listeners) listener(record);
    }
  }

  onRecord(listener: (record: ClaudeRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  sendUserMessage(text: string): void {
    this.child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
  }

  /** Stops the running reply; the process stays usable. Falls back to killing it. */
  interrupt(): Promise<void> {
    if (this.exited) return Promise.resolve();
    const requestId = `meldivo-${++this.nextRequest}`;
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        offExit();
        resolve();
      };
      const timer = setTimeout(() => {
        this.kill();
        done();
      }, INTERRUPT_GRACE_MS);
      const off = this.onRecord((record) => {
        if (record.type === "result") done();
      });
      const offExit = this.onExit(done);
      this.child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`);
    });
  }

  /** Remembers where the transcript lives once Claude Code reports the session id. */
  learnSession(id: string, projectsDir: string): void {
    if (this.sessionId === id && this.transcript) return;
    this.sessionId = id;
    this.transcript = findTranscript(projectsDir, id);
  }

  /** Whether something else wrote to this session's transcript since this process last finished a turn. */
  changedOnDisk(): boolean {
    const now = stampOf(this.transcript);
    if (!now || !this.stamp) return false;
    return now.size !== this.stamp.size || now.mtimeMs !== this.stamp.mtimeMs;
  }

  claim(): void {
    this.busy = true;
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** Marks the end of a turn: remembers the transcript as this process left it and starts the idle clock. */
  settle(projectsDir: string): void {
    this.busy = false;
    this.lastUsed = Date.now();
    if (!this.transcript && this.sessionId) this.transcript = findTranscript(projectsDir, this.sessionId);
    this.stamp = stampOf(this.transcript);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref();
  }

  /** Orderly shutdown: Claude Code exits when its stdin closes. */
  close(): void {
    if (this.exited) return;
    this.child.stdin.end();
    setTimeout(() => this.kill(), INTERRUPT_GRACE_MS).unref();
  }

  kill(): void {
    if (!this.exited) this.child.kill("SIGTERM");
  }
}

/** Keeps at most a few warm Claude Code processes, keyed by the id of the session they have open. */
export class ClaudePool {
  private bySession = new Map<string, ClaudeProcess>();
  private all = new Set<ClaudeProcess>();

  constructor(private readonly bin: string) {}

  /** An idle process that already has session `id` open with the same model and folder, if any. */
  take(id: string | null, cwd: string, model: string | undefined): ClaudeProcess | undefined {
    if (!id) return undefined;
    const proc = this.bySession.get(id);
    // A process started without a model runs the session's own model, which is what a turn
    // that names the session's recorded model asks for.
    if (!proc || proc.exited || proc.busy || proc.cwd !== cwd || (proc.model !== undefined && proc.model !== model)) return undefined;
    proc.claim();
    return proc;
  }

  spawn(args: string[], cwd: string, model: string | undefined): ClaudeProcess {
    this.evict();
    const proc = new ClaudeProcess(this.bin, args, cwd, model, (done) => this.forget(done));
    this.all.add(proc);
    return proc;
  }

  register(proc: ClaudeProcess): void {
    if (!proc.sessionId || proc.exited) return;
    const existing = this.bySession.get(proc.sessionId);
    if (existing && existing !== proc) {
      if (existing.busy) return;
      existing.close();
    }
    this.bySession.set(proc.sessionId, proc);
  }

  forget(proc: ClaudeProcess): void {
    this.all.delete(proc);
    for (const [id, entry] of this.bySession) if (entry === proc) this.bySession.delete(id);
  }

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
