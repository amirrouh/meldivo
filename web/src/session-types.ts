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
}

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  available: boolean;
}

export interface SessionsResponse {
  machine: string;
  harnesses: HarnessDescriptor[];
  sessions: SessionInfo[];
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
