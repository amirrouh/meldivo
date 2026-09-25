// Mirrors the fixed contract in server/src/harnesses/types.ts. Duplicated here
// (rather than imported) because the web app and server compile as separate
// TypeScript projects with different tsconfigs.

export type HarnessId = "pi" | "opencode" | "claude";

export interface SessionInfo {
  key: string;
  harness: HarnessId;
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  open: boolean;
  busy?: boolean;
  model?: string;
  /** Set for sessions on another machine: that machine's name in this hub. */
  host?: string;
}

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  available: boolean;
}

export interface HostInfo {
  /** "" for this machine, otherwise the peer's name (its sessions' keys start with `@<id>/`). */
  id: string;
  name: string;
  online: boolean;
  harnesses: HarnessDescriptor[];
}

export interface SessionsResponse {
  machine: string;
  harnesses: HarnessDescriptor[];
  sessions: SessionInfo[];
  hosts?: HostInfo[];
}

/** Splits `@<host>/<key>` into the host prefix (`@<host>/`, or "" for this machine) and the key. */
export function splitHostKey(key: string): { prefix: string; host: string; inner: string } {
  const match = /^@([A-Za-z0-9._-]{1,40})\/(.+)$/.exec(key);
  return match ? { prefix: `@${match[1]}/`, host: match[1]!, inner: match[2]! } : { prefix: "", host: "", inner: key };
}

export type TurnEvent =
  | { type: "session"; id: string }
  | { type: "status"; message: string }
  | { type: "tool"; name: string }
  | { type: "delta"; text: string }
  | { type: "notice"; message: string }
  | { type: "error"; message: string }
  | { type: "done" };

export const harnessOrder: HarnessId[] = ["pi", "opencode", "claude"];

export const harnessLabel: Record<HarnessId, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  claude: "Claude Code",
};
