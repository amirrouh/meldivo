import { createHash, createHmac, generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import type { RequestHandler } from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { SessionInfo, TurnEvent } from "./harnesses/types.js";
import type { Logger } from "./logger.js";
import type { SpeechEngine } from "./speech.js";
import {
  CONNECT_PATH,
  CREDENTIAL_HEADER,
  MACHINE_NAME,
  SUBPROTOCOL,
  helloSignedData,
  joinProofData,
  machineKey,
  parseMessage,
  type HarnessStatus,
  type HubMessage,
  type MachineMessage,
} from "./protocol.js";

// The hub side of hub mode: machines join with a one-time code, then keep an outbound
// WebSocket open to this hub, push their session lists, and run the turns relayed to them.
// On disk the hub keeps only its signing key and, per machine, a name and a hash of its
// credential (machines.json). Session lists live in memory only.

const JOIN_CODE_TTL_MS = 10 * 60_000;
const JOIN_FAILURE_LIMIT = 10;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const MAX_SESSIONS_PER_MACHINE = 200;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SPEECH_TIMEOUT_MS = 30_000;

export interface TurnSink {
  send(event: TurnEvent): void;
  end(): void;
  readonly ended: boolean;
}

interface MachineRecord {
  name: string;
  credentialHash: string;
  joinedAt: number;
}

interface LiveMachine {
  socket: WebSocket;
  version?: string;
  harnesses: HarnessStatus[];
  sessions: SessionInfo[];
  alive: boolean;
  speech: boolean;
}

interface SpeechRequest {
  machine: string;
  resolve(result: { text?: string; audio?: string }): void;
  reject(error: Error): void;
}

interface RelayedTurn {
  machine: string;
  sink: TurnSink;
  finish(): void;
}

export interface HostView {
  id: string;
  name: string;
  online: boolean;
  harnesses: HarnessStatus[];
  sessions: (SessionInfo & { host: string })[];
}

export interface Hub {
  /** POST /api/hub/join: one-time code in, machine credential out. Answers 404 to anything invalid. */
  join: RequestHandler;
  /** Handles WebSocket upgrades for machines on a listening server. */
  attach(server: Server): void;
  createJoinCode(): { code: string; expiresAt: number };
  machines(): { name: string; online: boolean; joinedAt: number; version?: string }[];
  remove(name: string): boolean;
  hosts(): HostView[];
  relay(name: string, key: string, message: string, conversationId: string | undefined, signal: AbortSignal, sink: TurnSink): Promise<void>;
  /** A connected machine that offered to do speech for this hub, if any. */
  speechMachine(): string | undefined;
  /** Runs speech on that machine; rejects if none is connected or it fails. */
  speech(request: { op: "transcribe"; audio: Buffer } | { op: "synthesize"; text: string; voice: string }, signal?: AbortSignal): Promise<{ text?: string; audio?: Buffer }>;
  close(): void;
}

export function createHub(options: { configDir: string; logger: Logger; notFound: RequestHandler }): Hub {
  const { configDir, logger } = options;
  const machinesFile = path.join(configDir, "machines.json");
  const { privateKey, publicKey } = loadOrCreateKey(path.join(configDir, "hub-key.pem"));
  let records = readRecords(machinesFile);
  const live = new Map<string, LiveMachine>();
  const turns = new Map<string, RelayedTurn>();
  const joinCodes = new Map<string, number>();
  const speechRequests = new Map<string, SpeechRequest>();
  let joinFailures = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024, handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false) });

  const heartbeat = setInterval(() => {
    for (const machine of live.values()) {
      if (!machine.alive) {
        machine.socket.terminate();
        continue;
      }
      machine.alive = false;
      machine.socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function save(): void {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(machinesFile, JSON.stringify(records, null, 2), { mode: 0o600 });
    chmodSync(machinesFile, 0o600);
  }

  function recordFor(credential: string): MachineRecord | undefined {
    const hash = sha256(credential);
    return records.find((record) => safeEqual(record.credentialHash, hash));
  }

  function uniqueName(requested: unknown): string {
    const base = typeof requested === "string" && MACHINE_NAME.test(requested) ? requested : "machine";
    const taken = new Set(records.map((record) => record.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 36)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  const join: RequestHandler = (req, res, next) => {
    const code = normalizeCode(req.body?.code);
    const expiresAt = code ? joinCodes.get(code) : undefined;
    if (!code || !expiresAt || expiresAt < Date.now()) {
      // Guessing is pointless (60-bit codes, 10 minutes), but still cap it: too many wrong
      // codes void every outstanding one.
      if (++joinFailures >= JOIN_FAILURE_LIMIT) {
        joinCodes.clear();
        joinFailures = 0;
      }
      return options.notFound(req, res, next);
    }
    joinCodes.delete(code);
    const name = uniqueName(req.body?.name);
    const credential = randomBytes(32).toString("hex");
    records.push({ name, credentialHash: sha256(credential), joinedAt: Date.now() });
    save();
    logger.info("hub_machine_joined", { machine: name });
    const proof = createHmac("sha256", code).update(joinProofData(publicKey, name)).digest("hex");
    res.set("Cache-Control", "no-store").json({ name, credential, hubKey: publicKey, proof });
  };

  function speechMachine(): string | undefined {
    for (const [name, machine] of live) if (machine.speech) return name;
    return undefined;
  }

  function refuse(socket: Duplex): void {
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = (req.url ?? "").split("?")[0];
    const credential = req.headers[CREDENTIAL_HEADER];
    const record = pathname === CONNECT_PATH && typeof credential === "string" ? recordFor(credential) : undefined;
    if (!record) return refuse(socket);
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, record.name));
  }

  function accept(ws: WebSocket, name: string): void {
    let machine: LiveMachine | undefined;
    const helloTimer = setTimeout(() => ws.close(4408, "hello timeout"), HELLO_TIMEOUT_MS);
    const send = (message: HubMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    ws.on("pong", () => { if (machine) machine.alive = true; });
    ws.on("message", (data) => {
      const message = parseMessage<MachineMessage>(data);
      if (!message) return;
      if (machine) machine.alive = true;
      switch (message.type) {
        case "hello": {
          if (machine || typeof message.nonce !== "string" || message.nonce.length < 16 || message.nonce.length > 128) return;
          clearTimeout(helloTimer);
          // A machine reconnecting replaces its previous socket.
          const previous = live.get(name);
          if (previous) previous.socket.close(4409, "replaced");
          machine = {
            socket: ws,
            version: typeof message.version === "string" ? message.version.slice(0, 40) : undefined,
            harnesses: readHarnesses(message.harnesses),
            sessions: [],
            alive: true,
            speech: message.speech === true,
          };
          live.set(name, machine);
          send({ type: "hello-ack", name, signature: sign(null, helloSignedData(message.nonce, name), privateKey).toString("base64") });
          logger.info("hub_machine_connected", { machine: name });
          return;
        }
        case "sessions":
          if (!machine) return;
          machine.harnesses = readHarnesses(message.harnesses);
          machine.sessions = readSessions(message.sessions);
          return;
        case "turn-event": {
          const turn = turns.get(message.turnId);
          if (!turn || turn.machine !== name || !message.event || typeof message.event.type !== "string") return;
          turn.sink.send(message.event);
          if (message.event.type === "done" || message.event.type === "error") turn.finish();
          return;
        }
        case "speech-result": {
          const request = speechRequests.get(message.requestId);
          if (!request || request.machine !== name) return;
          speechRequests.delete(message.requestId);
          if (typeof message.error === "string") request.reject(new Error(message.error));
          else request.resolve({ text: typeof message.text === "string" ? message.text : undefined, audio: typeof message.audio === "string" ? message.audio : undefined });
          return;
        }
        case "ping":
          send({ type: "pong" });
          return;
        default:
          return;
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!machine || live.get(name) !== machine) return;
      live.delete(name);
      logger.info("hub_machine_disconnected", { machine: name });
      for (const [turnId, turn] of turns) {
        if (turn.machine !== name) continue;
        turn.sink.send({ type: "error", message: `Lost the connection to ${name}` });
        turn.finish();
        turns.delete(turnId);
      }
      for (const [requestId, request] of speechRequests) {
        if (request.machine !== name) continue;
        speechRequests.delete(requestId);
        request.reject(new Error(`Lost the connection to ${name}`));
      }
    });
    ws.on("error", () => ws.terminate());
  }

  return {
    join,
    attach(server) {
      server.on("upgrade", onUpgrade);
    },
    createJoinCode() {
      const bytes = randomBytes(12);
      const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
      const expiresAt = Date.now() + JOIN_CODE_TTL_MS;
      for (const [existing, expiry] of joinCodes) if (expiry < Date.now()) joinCodes.delete(existing);
      joinCodes.set(code, expiresAt);
      return { code, expiresAt };
    },
    machines() {
      return records.map((record) => ({ name: record.name, joinedAt: record.joinedAt, online: live.has(record.name), version: live.get(record.name)?.version }));
    },
    remove(name) {
      const before = records.length;
      records = records.filter((record) => record.name !== name);
      if (records.length === before) return false;
      save();
      live.get(name)?.socket.close(4401, "removed");
      logger.info("hub_machine_removed", { machine: name });
      return true;
    },
    hosts() {
      return records.map((record) => {
        const machine = live.get(record.name);
        return {
          id: record.name,
          name: record.name,
          online: Boolean(machine),
          harnesses: machine?.harnesses ?? [],
          sessions: (machine?.sessions ?? []).map((session) => ({ ...session, key: machineKey(record.name, session.key), host: record.name })),
        };
      });
    },
    relay(name, key, message, conversationId, signal, sink) {
      const machine = live.get(name);
      if (!machine) {
        sink.send({ type: "error", message: records.some((record) => record.name === name) ? `${name} is offline` : `Unknown machine "${name}"` });
        sink.end();
        return Promise.resolve();
      }
      const turnId = randomUUID();
      return new Promise<void>((resolve) => {
        const onAbort = () => {
          if (machine.socket.readyState === machine.socket.OPEN) machine.socket.send(JSON.stringify({ type: "cancel", turnId } satisfies HubMessage));
          finish();
        };
        const finish = () => {
          if (!turns.has(turnId)) return;
          turns.delete(turnId);
          signal.removeEventListener("abort", onAbort);
          if (!sink.ended) sink.end();
          resolve();
        };
        turns.set(turnId, { machine: name, sink, finish });
        signal.addEventListener("abort", onAbort, { once: true });
        machine.socket.send(JSON.stringify({ type: "chat", turnId, key, message, conversationId } satisfies HubMessage));
        if (signal.aborted) onAbort();
      });
    },
    speechMachine,
    speech(request, signal) {
      const name = speechMachine();
      const machine = name ? live.get(name) : undefined;
      if (!name || !machine) return Promise.reject(new Error("No speech machine is connected"));
      const requestId = randomUUID();
      const message: HubMessage = request.op === "transcribe"
        ? { type: "speech", requestId, op: "transcribe", audio: request.audio.toString("base64") }
        : { type: "speech", requestId, op: "synthesize", text: request.text, voice: request.voice };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`${name} did not answer in time`)), SPEECH_TIMEOUT_MS);
        const onAbort = () => fail(new DOMException("aborted", "AbortError"));
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          speechRequests.delete(requestId);
        };
        const fail = (error: Error) => {
          done();
          reject(error);
        };
        speechRequests.set(requestId, {
          machine: name,
          resolve: (result) => {
            done();
            resolve({ text: result.text, audio: result.audio === undefined ? undefined : Buffer.from(result.audio, "base64") });
          },
          reject: fail,
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        machine.socket.send(JSON.stringify(message));
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const machine of live.values()) machine.socket.terminate();
      wss.close();
    },
  };
}

/**
 * Speech for a hub: uses a joined machine that offered to do speech (usually a faster computer
 * than the hub), and this machine's own models when none is connected or it fails.
 */
export function hubSpeech(local: SpeechEngine, hub: Hub, logger: Logger): SpeechEngine {
  async function remote<T>(run: () => Promise<T>, fallback: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!hub.speechMachine()) return fallback();
    try {
      return await run();
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.warn("hub_speech_fallback", { machine: hub.speechMachine() });
      return fallback();
    }
  }
  return {
    defaultVoice: local.defaultVoice,
    voices: () => local.voices(),
    status: () => (hub.speechMachine() ? { ready: true, downloading: false } : local.status()),
    warmup: local.warmup?.bind(local),
    transcribe: (wav, signal) => remote(
      async () => (await hub.speech({ op: "transcribe", audio: wav }, signal)).text ?? "",
      () => local.transcribe(wav, signal),
      signal,
    ),
    synthesize: (text, voice, signal) => remote(
      async () => {
        const { audio } = await hub.speech({ op: "synthesize", text, voice }, signal);
        if (!audio) throw new Error("No audio from the speech machine");
        return audio;
      },
      () => local.synthesize(text, voice, signal),
      signal,
    ),
  };
}

function loadOrCreateKey(file: string): { privateKey: KeyObject; publicKey: string } {
  let privateKey: KeyObject;
  if (existsSync(file)) {
    privateKey = createPrivateKey(readFileSync(file));
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  return { privateKey, publicKey };
}

function readRecords(file: string): MachineRecord[] {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((record): record is MachineRecord =>
      typeof record?.name === "string" && MACHINE_NAME.test(record.name) && typeof record.credentialHash === "string" && typeof record.joinedAt === "number");
  } catch {
    return [];
  }
}

function readHarnesses(value: unknown): HarnessStatus[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry?.id === "string" && typeof entry.label === "string")
    .slice(0, 10)
    .map((entry) => ({ id: String(entry.id).slice(0, 40), label: String(entry.label).slice(0, 60), available: entry.available === true }));
}

function readSessions(value: unknown): SessionInfo[] {
  if (!Array.isArray(value)) return [];
  const sessions: SessionInfo[] = [];
  for (const entry of value.slice(0, MAX_SESSIONS_PER_MACHINE)) {
    const session = entry as Partial<SessionInfo>;
    if (typeof session.key !== "string" || session.key.startsWith("@") || typeof session.id !== "string") continue;
    if (session.harness !== "pi" && session.harness !== "opencode" && session.harness !== "claude") continue;
    sessions.push({
      key: session.key.slice(0, 300),
      harness: session.harness,
      id: session.id.slice(0, 200),
      title: typeof session.title === "string" ? session.title.slice(0, 300) : "",
      cwd: typeof session.cwd === "string" ? session.cwd.slice(0, 500) : "",
      updatedAt: typeof session.updatedAt === "number" ? session.updatedAt : 0,
      open: session.open === true,
      busy: session.busy === true ? true : undefined,
      model: typeof session.model === "string" ? session.model.slice(0, 100) : undefined,
    });
  }
  return sessions;
}

function normalizeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 12 ? compact.replace(/(.{4})(?=.)/g, "$1-") : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
