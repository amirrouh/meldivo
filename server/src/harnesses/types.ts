export type HarnessId = "pi" | "opencode" | "claude";

/** A coding-agent session found on this machine. */
export interface SessionInfo {
  /** Stable hub key: `${harness}:${id}`. */
  key: string;
  harness: HarnessId;
  id: string;
  title: string;
  cwd: string;
  /** Last activity, epoch milliseconds. */
  updatedAt: number;
  /** True while a running harness process has this session open. */
  open: boolean;
  /** True while that process is mid-turn, when the harness reports it. */
  busy?: boolean;
  /** Model the session last used, in the harness's own notation. */
  model?: string;
}

/** Streamed result of one voice turn. */
export type TurnEvent =
  | { type: "session"; id: string } // id of the session the turn actually ran in (differs after a fork or for a new session)
  | { type: "status"; message: string }
  | { type: "tool"; name: string }
  | { type: "delta"; text: string }
  | { type: "notice"; message: string } // e.g. a tool call was denied because no one could approve it
  | { type: "error"; message: string }
  | { type: "done" };

export interface SendTarget {
  /** Existing session id, or null to start a new session in `cwd`. */
  id: string | null;
  cwd: string;
  model?: string;
  /** Fork the session instead of writing into it (used when it is open in a terminal). */
  fork: boolean;
}

export interface HarnessAdapter {
  id: HarnessId;
  label: string;
  /** Whether the harness CLI is installed and runnable. */
  available(): Promise<boolean>;
  /** Top-level sessions, most recently updated first. */
  listSessions(limit?: number): Promise<SessionInfo[]>;
  /** Run one user turn headlessly with the harness's own model and credentials. */
  send(target: SendTarget, text: string, signal: AbortSignal): AsyncIterable<TurnEvent>;
}
