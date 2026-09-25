import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionInfo } from "./harnesses/types.js";

// Other machines' hubs that this hub shows alongside its own sessions, so one link reaches
// every machine. Peers are listed in ~/.config/meldivo/peers.json (owner-only; it holds their
// keys) and are reached over a private network (e.g. a VPN address set with MELDIVO_HOST on
// the peer). Speech stays on this hub: only the text of each turn goes to the peer.

export interface Peer {
  /** Short name shown in the hub and used in session keys (`@<name>/<key>`). */
  name: string;
  /** Base URL of the peer hub, e.g. http://<vpn-ip>:4100. */
  url: string;
  /** The peer hub's secret. */
  token: string;
}

export interface PeerHarness {
  id: string;
  label: string;
  available: boolean;
}

export interface PeerSnapshot {
  name: string;
  online: boolean;
  machine?: string;
  harnesses: PeerHarness[];
  sessions: (SessionInfo & { host: string })[];
}

const PEER_NAME = /^[A-Za-z0-9._-]{1,40}$/;
const PEER_KEY = /^@([A-Za-z0-9._-]{1,40})\/(.+)$/;
const PEER_TIMEOUT_MS = 2_500;

export function defaultPeersPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo", "peers.json");
}

/** Reads the peers file; a missing or malformed file means no peers. */
export function loadPeers(file = defaultPeersPath()): Peer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { peers?: unknown })?.peers) ? (raw as { peers: unknown[] }).peers : [];
  const peers: Peer[] = [];
  for (const entry of list) {
    const peer = entry as Partial<Peer>;
    if (typeof peer.name !== "string" || !PEER_NAME.test(peer.name)) continue;
    if (typeof peer.url !== "string" || !/^https?:\/\//.test(peer.url)) continue;
    if (typeof peer.token !== "string" || !peer.token) continue;
    if (peers.some((existing) => existing.name === peer.name)) continue;
    peers.push({ name: peer.name, url: peer.url.replace(/\/+$/, ""), token: peer.token });
  }
  return peers;
}

export function peerKey(name: string, key: string): string {
  return `@${name}/${key}`;
}

export function parsePeerKey(key: string): { name: string; inner: string } | undefined {
  const match = PEER_KEY.exec(key);
  return match ? { name: match[1]!, inner: match[2]! } : undefined;
}

function peerFetch(peer: Peer, route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${peer.url}${route}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), "X-Meldivo-Token": peer.token },
    redirect: "error",
  });
}

export async function fetchPeerSnapshot(peer: Peer): Promise<PeerSnapshot> {
  const offline: PeerSnapshot = { name: peer.name, online: false, harnesses: [], sessions: [] };
  try {
    const response = await peerFetch(peer, "/api/sessions", { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
    if (!response.ok) return offline;
    const body = await response.json() as { machine?: unknown; harnesses?: unknown; sessions?: unknown };
    const harnesses = Array.isArray(body.harnesses) ? body.harnesses as PeerHarness[] : [];
    const sessions = (Array.isArray(body.sessions) ? body.sessions as (SessionInfo & { host?: string })[] : [])
      // A peer's own peers are not re-shared.
      .filter((session) => typeof session.key === "string" && !session.host && !parsePeerKey(session.key))
      .map((session) => ({ ...session, key: peerKey(peer.name, session.key), host: peer.name }));
    return { name: peer.name, online: true, machine: typeof body.machine === "string" ? body.machine : undefined, harnesses, sessions };
  } catch {
    return offline;
  }
}

/** Starts one turn on the peer; the response body is the peer's SSE stream. */
export function peerChat(peer: Peer, key: string, body: { message: string; conversationId?: string }, signal: AbortSignal): Promise<Response> {
  return peerFetch(peer, `/api/sessions/${encodeURIComponent(key)}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
}

export function peerCancel(peer: Peer, key: string): Promise<Response> {
  return peerFetch(peer, `/api/sessions/${encodeURIComponent(key)}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
  });
}
