import type { SessionInfo, TurnEvent } from "./harnesses/types.js";

// Wire protocol between a hub and the machines connected to it. A machine opens one outbound
// WebSocket to the hub (see machine-client.ts), authenticating with a header on the upgrade
// request itself (never in the URL, so never in proxy logs);
// the hub then proves its identity by signing the machine's nonce with its pinned key. The hub
// can only ask a machine to run or cancel a text turn in one of its own sessions, or, if the
// machine offered it when joining, to transcribe or synthesize speech: there is deliberately
// no message for commands, files, or configuration.

export const PROTOCOL_VERSION = 1;
/** WebSocket path on the hub that machines connect to. */
export const CONNECT_PATH = "/api/hub/connect";
/** HTTP path on the hub that exchanges a one-time join code for a machine credential. */
export const JOIN_PATH = "/api/hub/join";
/** WebSocket subprotocol naming the protocol version. */
export const SUBPROTOCOL = "meldivo-v1";
/** Upgrade-request header carrying the machine credential. */
export const CREDENTIAL_HEADER = "x-meldivo-machine";

export interface HarnessStatus {
  id: string;
  label: string;
  available: boolean;
}

export type MachineMessage =
  | { type: "hello"; nonce: string; version: string; harnesses: HarnessStatus[]; speech?: boolean }
  | { type: "sessions"; harnesses: HarnessStatus[]; sessions: SessionInfo[] }
  | { type: "turn-event"; turnId: string; event: TurnEvent }
  | { type: "speech-result"; requestId: string; text?: string; audio?: string; error?: string }
  | { type: "ping" }
  | { type: "pong" };

export type HubMessage =
  | { type: "hello-ack"; name: string; signature: string }
  | { type: "chat"; turnId: string; key: string; message: string; conversationId?: string; cwd?: string }
  | { type: "cancel"; turnId: string }
  | { type: "speech"; requestId: string; op: "transcribe"; audio: string }
  | { type: "speech"; requestId: string; op: "synthesize"; text: string; voice: string }
  | { type: "ping" }
  | { type: "pong" };

/** What the machine signs over: binds the hub's answer to this connection's nonce and name. */
export function helloSignedData(nonce: string, name: string): Buffer {
  return Buffer.from(`meldivo-hub-hello-v1\n${nonce}\n${name}`);
}

/** What the join answer is authenticated with: proves the responder knew the join code. */
export function joinProofData(publicKey: string, name: string): string {
  return `meldivo-hub-join-v1\n${publicKey}\n${name}`;
}

export const MACHINE_NAME = /^[A-Za-z0-9._-]{1,40}$/;
const MACHINE_KEY = /^@([A-Za-z0-9._-]{1,40})\/(.+)$/;

/** Hub-wide key of a session on a connected machine. */
export function machineKey(name: string, key: string): string {
  return `@${name}/${key}`;
}

export function parseMachineKey(key: string): { name: string; inner: string } | undefined {
  const match = MACHINE_KEY.exec(key);
  return match ? { name: match[1]!, inner: match[2]! } : undefined;
}

export function parseMessage<T>(data: unknown): T | undefined {
  try {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
    const value = JSON.parse(text) as { type?: unknown };
    return value && typeof value.type === "string" ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}
