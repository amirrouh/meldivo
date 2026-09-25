import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import type { SessionInfo, TurnEvent } from "./harnesses/types.js";
import type { TurnSink } from "./hub.js";
import type { Logger } from "./logger.js";
import type { SpeechEngine } from "./speech.js";
import {
  CONNECT_PATH,
  CREDENTIAL_HEADER,
  MACHINE_NAME,
  JOIN_PATH,
  SUBPROTOCOL,
  helloSignedData,
  joinProofData,
  parseMessage,
  type HarnessStatus,
  type HubMessage,
  type MachineMessage,
} from "./protocol.js";

// The machine side of hub mode: one outbound WebSocket to the hub this machine joined
// (`meldivo join`), so the machine needs no open ports. It pushes its session list and runs
// the text turns the hub relays, and nothing else. The hub must prove on every connection
// that it holds the key pinned at join time, so a look-alike hub is refused.

const SESSIONS_PUSH_MS = 5_000;
const PING_MS = 20_000;
const SILENCE_LIMIT_MS = 50_000;
const MAX_BACKOFF_MS = 30_000;
const IDENTITY_FAILURE_BACKOFF_MS = 5 * 60_000;
const MAX_CONCURRENT_TURNS = 4;

export interface HubLink {
  url: string;
  name: string;
  credential: string;
  /** The hub's public key (base64 SPKI), pinned when this machine joined. */
  hubKey: string;
  /** Harnesses the hub may use on this machine; all when unset. */
  allow?: string[];
  /** Whether this machine does speech (STT/TTS) for the hub. */
  speech?: boolean;
}

export function hubLinkPath(configDir: string): string {
  return path.join(configDir, "hub.json");
}

export function loadHubLink(configDir: string): HubLink | undefined {
  try {
    const link = JSON.parse(readFileSync(hubLinkPath(configDir), "utf8")) as Partial<HubLink>;
    if (typeof link.url !== "string" || !/^https?:\/\//.test(link.url)) return undefined;
    if (typeof link.name !== "string" || !MACHINE_NAME.test(link.name)) return undefined;
    if (typeof link.credential !== "string" || typeof link.hubKey !== "string") return undefined;
    const allow = Array.isArray(link.allow) ? link.allow.filter((id): id is string => typeof id === "string") : undefined;
    return { url: link.url.replace(/\/+$/, ""), name: link.name, credential: link.credential, hubKey: link.hubKey, allow, speech: link.speech === true };
  } catch {
    return undefined;
  }
}

/**
 * Exchanges a one-time join code for this machine's credential (`meldivo join`). The hub's
 * answer carries an HMAC keyed by the code, so only the hub that issued the code can answer.
 */
export async function joinHub(hubUrl: string, code: string, name: string): Promise<HubLink> {
  const url = new URL(hubUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The hub address must start with http:// or https://");
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");
  const response = await fetch(`${url.origin}${JOIN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalized, name }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("The hub did not accept this code (it may be wrong, used, or expired)");
  const body = await response.json() as { name?: unknown; credential?: unknown; hubKey?: unknown; proof?: unknown };
  if (typeof body.name !== "string" || !MACHINE_NAME.test(body.name) || typeof body.credential !== "string" || typeof body.hubKey !== "string" || typeof body.proof !== "string") {
    throw new Error("Unexpected answer from the hub");
  }
  const expected = createHmac("sha256", normalized).update(joinProofData(body.hubKey, body.name)).digest();
  const proof = Buffer.from(body.proof, "hex");
  if (proof.length !== expected.length || !timingSafeEqual(proof, expected)) throw new Error("The hub could not prove it issued this code");
  createPublicKey({ key: Buffer.from(body.hubKey, "base64"), format: "der", type: "spki" });
  return { url: url.origin, name: body.name, credential: body.credential, hubKey: body.hubKey };
}

export interface MachineClientOptions {
  link: HubLink;
  logger: Logger;
  version: string;
  snapshot(): Promise<{ harnesses: HarnessStatus[]; sessions: SessionInfo[] }>;
  /** This machine's speech engine, used for the hub when the link has `speech` set. */
  speech?: SpeechEngine;
  isBusy(key: string): boolean;
  runTurn(key: string, message: string, conversationId: string | undefined, cwd: string | undefined, signal: AbortSignal, sink: TurnSink): Promise<void>;
}

export interface MachineClient {
  status(): { connected: boolean; name: string };
  close(): void;
}

/** Which harness a local session key would run, or undefined for keys the hub may not use. */
function harnessOfKey(key: string): string | undefined {
  if (key.startsWith("@") || key === "quick") return undefined;
  if (key.startsWith("new:")) return key.slice(4);
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : undefined;
}

export function startMachineClient(options: MachineClientOptions): MachineClient {
  const { link, logger } = options;
  const hubKey = createPublicKey({ key: Buffer.from(link.hubKey, "base64"), format: "der", type: "spki" });
  const allowed = (harness: string) => !link.allow || link.allow.includes(harness);
  const turns = new Map<string, AbortController>();
  let socket: WebSocket | undefined;
  let verified = false;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let pushTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let lastPushed = "";
  let lastHeard = 0;

  async function localSnapshot() {
    const { harnesses, sessions } = await options.snapshot();
    return {
      harnesses: harnesses.map((harness) => ({ ...harness, available: harness.available && allowed(harness.id) })),
      sessions: sessions.filter((session) => allowed(session.harness)),
    };
  }

  async function push(force = false): Promise<void> {
    if (!verified || !socket) return;
    const snapshot = await localSnapshot().catch(() => undefined);
    if (!snapshot) return;
    const payload = JSON.stringify({ type: "sessions", ...snapshot } satisfies MachineMessage);
    if (!force && payload === lastPushed) return;
    lastPushed = payload;
    send(payload);
  }

  function send(payload: string | MachineMessage): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  function scheduleReconnect(delay?: number): void {
    if (closed || reconnectTimer) return;
    const backoff = delay ?? Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, backoff);
    reconnectTimer.unref();
  }

  function handleChat(message: Extract<HubMessage, { type: "chat" }>): void {
    const { turnId } = message;
    const emit = (event: TurnEvent) => send({ type: "turn-event", turnId, event });
    const harness = typeof message.key === "string" ? harnessOfKey(message.key) : undefined;
    if (typeof turnId !== "string" || !turnId || turns.has(turnId)) return;
    if (!harness || !allowed(harness)) return emit({ type: "error", message: "This session is not available from the hub" });
    if (typeof message.message !== "string" || !message.message.trim()) return emit({ type: "error", message: "message is required" });
    if (turns.size >= MAX_CONCURRENT_TURNS) return emit({ type: "error", message: "Too many turns are running on this machine" });
    if (options.isBusy(message.key)) return emit({ type: "error", message: "This session is busy" });

    const controller = new AbortController();
    turns.set(turnId, controller);
    let ended = false;
    const sink: TurnSink = {
      send: (event) => { if (!ended) emit(event); },
      end: () => { ended = true; },
      get ended() { return ended; },
    };
    // Audit trail on this machine: which session the hub drove, never what was said.
    logger.info("hub_turn", { harness, kind: message.key.startsWith("new:") ? "new" : "existing" });
    const conversationId = typeof message.conversationId === "string" ? message.conversationId : undefined;
    const cwd = typeof message.cwd === "string" ? message.cwd : undefined;
    void options.runTurn(message.key, message.message, conversationId, cwd, controller.signal, sink)
      .catch((error: unknown) => sink.send({ type: "error", message: error instanceof Error ? error.message : "Turn failed" }))
      .finally(() => {
        turns.delete(turnId);
        void push();
      });
  }

  const speechControllers = new Map<string, AbortController>();

  function handleSpeech(message: Extract<HubMessage, { type: "speech" }>): void {
    const { requestId } = message;
    if (typeof requestId !== "string" || !requestId || speechControllers.has(requestId)) return;
    const reply = (result: { text?: string; audio?: string; error?: string }) => send({ type: "speech-result", requestId, ...result });
    const engine = options.speech;
    if (!link.speech || !engine) return reply({ error: "This machine does not do speech for the hub" });
    const controller = new AbortController();
    speechControllers.set(requestId, controller);
    const work = message.op === "transcribe" && typeof message.audio === "string"
      ? engine.transcribe(Buffer.from(message.audio, "base64"), controller.signal).then((text) => ({ text: text.trim() }))
      : message.op === "synthesize" && typeof message.text === "string" && message.text.length <= 1_200 && typeof message.voice === "string"
        ? engine.synthesize(message.text, message.voice, controller.signal).then((wav) => ({ audio: wav.toString("base64") }))
        : Promise.reject(new Error("Invalid speech request"));
    void work
      .then(reply, (error: unknown) => reply({ error: error instanceof Error ? error.message : "Speech failed" }))
      .finally(() => speechControllers.delete(requestId));
  }

  function connect(): void {
    if (closed) return;
    const nonce = randomBytes(24).toString("base64");
    const url = `${link.url.replace(/^http/, "ws")}${CONNECT_PATH}`;
    const ws = new WebSocket(url, SUBPROTOCOL, { headers: { [CREDENTIAL_HEADER]: link.credential }, handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 });
    socket = ws;
    verified = false;
    lastPushed = "";

    ws.on("open", () => {
      lastHeard = Date.now();
      void options.snapshot().then(
        ({ harnesses }) => send({ type: "hello", nonce, version: options.version, speech: Boolean(link.speech && options.speech), harnesses: harnesses.map((harness) => ({ ...harness, available: harness.available && allowed(harness.id) })) }),
        () => send({ type: "hello", nonce, version: options.version, speech: Boolean(link.speech && options.speech), harnesses: [] }),
      );
    });
    ws.on("message", (data) => {
      lastHeard = Date.now();
      const message = parseMessage<HubMessage>(data);
      if (!message) return;
      if (!verified) {
        if (message.type !== "hello-ack") return;
        const ok = message.name === link.name && typeof message.signature === "string"
          && verify(null, helloSignedData(nonce, link.name), hubKey, Buffer.from(message.signature, "base64"));
        if (!ok) {
          logger.error("hub_identity_mismatch", { url: link.url });
          ws.close(4403, "identity");
          return;
        }
        verified = true;
        attempt = 0;
        logger.info("hub_connected", { url: link.url });
        void push(true);
        return;
      }
      switch (message.type) {
        case "chat":
          handleChat(message);
          return;
        case "cancel":
          turns.get(message.turnId)?.abort();
          return;
        case "speech":
          handleSpeech(message);
          return;
        case "ping":
          send({ type: "pong" });
          return;
        default:
          return;
      }
    });
    ws.on("close", (code) => {
      if (socket !== ws) return;
      const wasVerified = verified;
      socket = undefined;
      verified = false;
      // The browser behind these turns is gone with the hub connection.
      for (const controller of turns.values()) controller.abort();
      turns.clear();
      for (const controller of speechControllers.values()) controller.abort();
      speechControllers.clear();
      if (wasVerified) logger.warn("hub_disconnected", { status: code });
      scheduleReconnect(code === 4403 ? IDENTITY_FAILURE_BACKOFF_MS : undefined);
    });
    ws.on("error", () => {
      // "close" follows and schedules the reconnect.
    });
  }

  pushTimer = setInterval(() => void push(), SESSIONS_PUSH_MS);
  pingTimer = setInterval(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastHeard > SILENCE_LIMIT_MS) {
      socket.terminate();
      return;
    }
    send({ type: "ping" });
  }, PING_MS);
  pushTimer.unref();
  pingTimer.unref();
  connect();

  return {
    status: () => ({ connected: verified, name: link.name }),
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearInterval(pushTimer);
      clearInterval(pingTimer);
      for (const controller of turns.values()) controller.abort();
      socket?.terminate();
    },
  };
}
