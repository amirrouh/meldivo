import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Which existing session (harness + id) a voice conversation ended up continuing. */
export interface ConversationRecord {
  harness: string;
  id: string;
}

interface SessionStateData {
  /** conversationId -> the session a `new:<harness>`/`quick` turn created. */
  conversations: Record<string, ConversationRecord>;
  /** hub session key (`<harness>:<id>`) -> the fork created for its first voice turn. */
  voiceFork: Record<string, string>;
}

function emptyState(): SessionStateData {
  return { conversations: {}, voiceFork: {} };
}

/**
 * Small on-disk store for the continuation state that lets voice turns land
 * back in the same session across requests: which session a `new`/`quick`
 * conversation created, and which fork a currently-open session's voice
 * turns are writing into. Mutations are serialized through a queue so
 * concurrent turns cannot interleave writes to the file.
 */
export class SessionStateStore {
  private data: SessionStateData = emptyState();
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get filePath(): string {
    return path.join(this.dir, "sessions.json");
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionStateData>;
      this.data = {
        conversations: parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {},
        voiceFork: parsed.voiceFork && typeof parsed.voiceFork === "object" ? parsed.voiceFork : {},
      };
    } catch {
      this.data = emptyState();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(this.dir, `.sessions.json.tmp-${process.pid}-${Date.now()}`);
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(tmpPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.data.conversations[conversationId];
    });
  }

  async setConversation(conversationId: string, record: ConversationRecord): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      this.data.conversations[conversationId] = record;
      await this.persist();
    });
  }

  async getFork(key: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return this.data.voiceFork[key];
    });
  }

  async setFork(key: string, forkId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureLoaded();
      this.data.voiceFork[key] = forkId;
      await this.persist();
    });
  }

  /** All currently-tracked fork session ids, used to hide forks from the session list. */
  async allForkIds(): Promise<Set<string>> {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      return new Set(Object.values(this.data.voiceFork));
    });
  }
}

export function defaultStateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(base, "meldivo");
}
