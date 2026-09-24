import { timingSafeEqual as secureCompare } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { MeldivoHub, type HarnessKind, type MeldivoRoom } from "./hub.js";
import { createLogger, requestLoggingMiddleware } from "./logger.js";
import { createSherpaEngine, type SpeechEngine } from "./speech.js";

type ActiveHarnessTurn = { controller: AbortController; roomId: string; turnId: string; res: express.Response };
type ActiveVoiceLease = { token: string; expiresAt: number };
type AdapterEvent =
  | { turnId: string; type: "delta"; text: string }
  | { turnId: string; type: "done" }
  | { turnId: string; type: "error"; error: string };

// Rooms without any adapter/browser activity for this long are dropped, so a
// crashed Pi session or an abandoned tab does not linger forever.
const ROOM_IDLE_TTL_MS = 8 * 60 * 60 * 1_000;
const VOICE_LEASE_TTL_MS = 15_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1_000;
const IDLE_CHECK_INTERVAL_MS = 10_000;

export interface StartServerOptions {
  port?: number;
  host?: string;
  secret: string;
  publicUrl?: string;
  speech?: SpeechEngine;
  idleShutdownMs?: number;
  webDir?: string;
  /** Port for the optional certificate-based HTTPS listener (see /api/remote/https). */
  httpsPort?: number;
}

// Where a user-supplied TLS certificate for remote access lives, mirroring the
// extension's own config-dir resolution so both sides agree without coupling.
function tlsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo", "tls");
}

// The lock that keeps only one browser tab recording at a time. It is a
// single process-wide slot rather than per-room state, since only one voice
// session is ever meant to be live from this machine.
class VoiceLease {
  private active: ActiveVoiceLease | null = null;

  constructor(private readonly ttlMs: number) {}

  claim(): ActiveVoiceLease | null {
    if (this.active && this.active.expiresAt > Date.now()) return null;
    this.active = { token: crypto.randomUUID(), expiresAt: Date.now() + this.ttlMs };
    return this.active;
  }

  // A late heartbeat from the lease's own holder must still succeed even past
  // expiresAt, as long as nobody else has claimed the lease since (claim()
  // would have overwritten the token). Otherwise a single delayed heartbeat
  // (tab throttling, a slow TTS turn) evicts the caller's own session and
  // reports it as if another tab had taken over.
  renew(token: string | null): ActiveVoiceLease | null {
    if (!token || !this.active || this.active.token !== token) return null;
    this.active = { ...this.active, expiresAt: Date.now() + this.ttlMs };
    return this.active;
  }

  release(token: string | null): void {
    if (token && this.active?.token === token) this.active = null;
  }
}

export async function startServer(options: StartServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const secret = options.secret;
  const speech = options.speech ?? createSherpaEngine();
  const webDir = options.webDir ?? fileURLToPath(new URL("../web", import.meta.url));
  const logger = createLogger();
  const hub = new MeldivoHub(ROOM_IDLE_TTL_MS);
  const voiceLease = new VoiceLease(VOICE_LEASE_TTL_MS);
  const activeHarnessTurns = new Map<string, ActiveHarnessTurn>();
  const app = express();
  let httpsServer: HttpsServer | undefined;
  let httpsActualPort: number | undefined;

  app.use(requestLoggingMiddleware(logger));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, speech: speech.status() });
  });

  // A room deep link must use the origin of the request that asked for it, so
  // the hub page (and its microphone) stays same-origin with the browser, no
  // matter which address or port it was reached on.
  function roomOrigin(req: express.Request): string {
    const forwardedHost = req.get("host");
    if (!forwardedHost) return options.publicUrl ?? `http://localhost:${actualPort}`;
    const proto = (req.get("x-forwarded-proto") || "").split(",")[0]!.trim().toLowerCase();
    const scheme = proto === "https" || req.secure ? "https" : "http";
    return `${scheme}://${forwardedHost}`;
  }

  function hasSecret(req: express.Request): boolean {
    const header = req.get("x-meldivo-secret");
    return typeof header === "string" && secureTokenEqual(secret, header);
  }

  function readRoomToken(req: express.Request): string | undefined {
    const authorization = req.get("authorization");
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const header = req.get("x-meldivo-room-token");
    const bodyToken = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>).roomToken : undefined;
    const token = bearer ?? header ?? bodyToken;
    return typeof token === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : undefined;
  }

  function authorizedRoom(req: express.Request): MeldivoRoom | undefined {
    const roomId = readRoomId(req.params.roomId);
    return hub.authorize(roomId, readRoomToken(req));
  }

  // Voice endpoints are not scoped to a single room in the URL, but they must
  // still be gated on a live room's own capability token rather than left open.
  function authorizedByToken(req: express.Request): MeldivoRoom | undefined {
    return hub.authorizeToken(readRoomToken(req));
  }

  app.post("/api/rooms", (req, res) => {
    if (!hasSecret(req)) return res.status(401).json({ error: "Meldivo secret is required" });
    const input = readRoomCreateRequest(req.body);
    if (!input) return res.status(400).json({ error: "mode must be harness and harness must be pi" });
    const created = hub.create(input);
    const url = `${roomOrigin(req)}/?room=${encodeURIComponent(created.room.id)}#token=${encodeURIComponent(created.token)}`;
    res.status(201).set("Cache-Control", "no-store").json({ room: created.room, token: created.token, url });
  });

  app.get("/api/rooms/:roomId", (req, res) => {
    const room = authorizedRoom(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    res.set("Cache-Control", "no-store").json({ room: hub.public(room) });
  });

  app.delete("/api/rooms/:roomId", (req, res) => {
    const roomId = readRoomId(req.params.roomId);
    const room = hasSecret(req) ? (roomId ? hub.get(roomId) : undefined) : authorizedRoom(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    abortHarnessTurn(room.id, "Voice room was closed");
    hub.close(room);
    res.status(204).end();
  });

  // A harness adapter polls this endpoint. It is deliberately pull-based so a
  // local plugin can reconnect without the hub having to reach into a terminal.
  app.post("/api/rooms/:roomId/adapter/next", (req, res) => {
    const room = authorizedRoom(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    const turn = hub.nextTurn(room);
    if (!turn) return res.status(204).end();
    res.set("Cache-Control", "no-store").json(turn);
  });

  app.post("/api/rooms/:roomId/adapter/events", (req, res) => {
    const room = authorizedRoom(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    const event = readAdapterEvent(req.body);
    if (!event) return res.status(400).json({ error: "A valid adapter event is required" });
    const turn = activeHarnessTurns.get(event.turnId);
    if (!turn || turn.roomId !== room.id || turn.controller.signal.aborted) return res.status(409).json({ error: "Turn is no longer active" });
    if (event.type === "delta") sendEvent(turn.res, { type: "delta", text: event.text });
    else if (event.type === "error") finishHarnessTurn(turn, { type: "error", error: event.error });
    else finishHarnessTurn(turn, { type: "done" });
    res.status(202).end();
  });

  // Lets the Pi extension turn a user-supplied TLS certificate into a real
  // HTTPS listener for remote access, without the extension needing to
  // manage a Node https server itself. Idempotent in both directions.
  async function enableHttps(): Promise<number> {
    if (httpsServer && httpsActualPort) return httpsActualPort;
    const certPath = path.join(tlsDir(), "cert.pem");
    const keyPath = path.join(tlsDir(), "key.pem");
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      throw new Error(`TLS certificate not found at ${certPath}`);
    }
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);
    const server = createHttpsServer({ cert, key }, app);
    await new Promise<void>((resolve, reject) => {
      server.listen(options.httpsPort ?? 4443, "0.0.0.0", () => resolve());
      server.once("error", reject);
    });
    httpsServer = server;
    httpsActualPort = (server.address() as AddressInfo).port;
    return httpsActualPort;
  }

  function disableHttps(): Promise<void> {
    if (!httpsServer) return Promise.resolve();
    const server = httpsServer;
    httpsServer = undefined;
    httpsActualPort = undefined;
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  app.post("/api/remote/https", (req, res) => {
    if (!hasSecret(req)) return res.status(401).json({ error: "Meldivo secret is required" });
    const enable = (req.body as Record<string, unknown> | undefined)?.enable;
    if (typeof enable !== "boolean") return res.status(400).json({ error: "enable must be a boolean" });
    const result = enable ? enableHttps() : disableHttps().then(() => null);
    result
      .then((port) => res.status(200).json({ port }))
      .catch((error) => res.status(502).json({ error: messageFor(error) }));
  });

  app.post("/api/voice/lease", (req, res) => {
    if (!authorizedByToken(req)) return res.status(401).json({ error: "Invalid room capability" });
    const lease = voiceLease.claim();
    if (!lease) return res.status(409).json({ error: "Another voice session is active." });
    res.status(201).json(lease);
  });

  app.post("/api/voice/lease/heartbeat", (req, res) => {
    if (!authorizedByToken(req)) return res.status(401).json({ error: "Invalid room capability" });
    const lease = voiceLease.renew(readLeaseToken(req.body?.token));
    if (!lease) return res.status(409).json({ error: "Voice session is no longer active." });
    res.json(lease);
  });

  app.delete("/api/voice/lease", (req, res) => {
    if (!authorizedByToken(req)) return res.status(401).json({ error: "Invalid room capability" });
    voiceLease.release(readLeaseToken(req.body?.token));
    res.status(204).end();
  });

  app.post("/api/chat", (req, res) => {
    const conversationId = readConversationId(req.body?.conversationId);
    const message = readMessage(req.body?.message);
    if (!conversationId || !message) return res.status(400).json({ error: "conversationId and message are required" });
    const roomId = readRoomId(req.body?.roomId);
    const room = hub.authorize(roomId, readRoomToken(req));
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    startHarnessChat(room, message, req, res);
  });

  app.post("/api/voice/transcribe", express.raw({ type: "audio/wav", limit: "16mb" }), async (req, res) => {
    const room = authorizedByToken(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    if (!Buffer.isBuffer(req.body) || req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF") {
      return res.status(400).json({ error: "A WAV recording is required" });
    }
    const controller = abortOnDisconnect(req, res);
    try {
      const text = await speech.transcribe(req.body, controller.signal);
      res.json({ text: text.trim() });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.status(502).json({ error: messageFor(error) });
    }
  });

  app.get("/api/voice/voices", (req, res) => {
    const room = authorizedByToken(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    res.set("Cache-Control", "no-store").json({ current: speech.defaultVoice, voices: speech.voices() });
  });

  app.post("/api/voice/speech", async (req, res) => {
    const room = authorizedByToken(req);
    if (!room) return res.status(401).json({ error: "Invalid room capability" });
    const text = readSpeechText(req.body?.text);
    if (!text) return res.status(400).json({ error: "text must contain 1–1200 characters" });
    const requestedVoice = req.body?.voice === undefined ? undefined : readVoice(req.body.voice);
    if (req.body?.voice !== undefined && !requestedVoice) return res.status(400).json({ error: "voice must be a valid provider voice ID" });

    const controller = abortOnDisconnect(req, res);
    try {
      const wav = await speech.synthesize(text, requestedVoice ?? speech.defaultVoice, controller.signal);
      if (!controller.signal.aborted && !res.destroyed) {
        res.status(200).set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" }).send(wav);
      }
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) res.status(502).json({ error: messageFor(error) });
    }
  });

  if (webDir && existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get("/{*path}", (req, res, next) => {
      if (req.path === "/api" || req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(webDir, "index.html"));
    });
  }
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

  function abortHarnessTurn(roomId: string, reason: string): void {
    const active = [...activeHarnessTurns.values()].find((turn) => turn.roomId === roomId);
    if (active) {
      active.controller.abort();
      finishHarnessTurn(active, { type: "error", error: reason });
    }
  }

  function abortHarnessTurnById(turnId: string): void {
    const active = activeHarnessTurns.get(turnId);
    if (!active) return;
    active.controller.abort();
    activeHarnessTurns.delete(turnId);
    hub.removeTurnById(active.roomId, active.turnId);
  }

  function finishHarnessTurn(turn: ActiveHarnessTurn, event: { type: "done" } | { type: "error"; error: string }): void {
    if (activeHarnessTurns.get(turn.turnId) !== turn) return;
    activeHarnessTurns.delete(turn.turnId);
    hub.removeTurnById(turn.roomId, turn.turnId);
    if (!turn.res.destroyed && !turn.res.writableEnded) {
      sendEvent(turn.res, event);
      turn.res.end();
    }
  }

  function startHarnessChat(room: MeldivoRoom, message: string, req: express.Request, res: express.Response): void {
    abortHarnessTurn(room.id, "A newer voice request replaced this one");
    const controller = new AbortController();
    const adapterTurn = hub.enqueueTurn(room, message);
    const turn: ActiveHarnessTurn = { controller, roomId: room.id, turnId: adapterTurn.turnId, res };
    activeHarnessTurns.set(turn.turnId, turn);
    req.on("aborted", () => abortHarnessTurnById(turn.turnId));
    res.on("close", () => {
      if (!res.writableEnded) abortHarnessTurnById(turn.turnId);
    });
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    sendEvent(res, { type: "status", message: "Waiting for the coding agent", turnId: turn.turnId });
  }

  let httpServer: Server;
  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(options.port ?? 0, host, () => resolve());
    httpServer.once("error", reject);
  });
  const actualPort = (httpServer!.address() as AddressInfo).port;
  logger.info("server_started", { host, port: actualPort });

  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let idleSince: number | undefined;
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  if (idleShutdownMs > 0) {
    idleTimer = setInterval(() => {
      if (hub.size() > 0) {
        idleSince = undefined;
        return;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince < idleShutdownMs) return;
      clearInterval(idleTimer);
      void close().then(() => {
        if (isMainModule) process.exit(0);
      });
    }, IDLE_CHECK_INTERVAL_MS);
    idleTimer.unref?.();
  }

  async function close(): Promise<void> {
    if (idleTimer) clearInterval(idleTimer);
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
      disableHttps(),
    ]);
  }

  return { port: actualPort, close };
}

function secureTokenEqual(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return expectedBytes.length === candidateBytes.length && secureCompare(expectedBytes, candidateBytes);
}

function readRoomId(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : undefined;
}

function readRoomCreateRequest(value: unknown): { harness: HarnessKind; cwd?: string; label?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.mode !== "harness" || record.harness !== "pi") return undefined;
  const cwd = readRoomText(record.cwd, 2_000);
  const label = readRoomText(record.label, 120);
  if ((record.cwd !== undefined && !cwd) || (record.label !== undefined && !label)) return undefined;
  return { harness: "pi", ...(cwd ? { cwd } : {}), ...(label ? { label } : {}) };
}

function readRoomText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f]/.test(text) ? text : undefined;
}

function readAdapterEvent(value: unknown): AdapterEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const turnId = readRoomId(record.turnId);
  if (!turnId || typeof record.type !== "string") return undefined;
  if (record.type === "done") return { turnId, type: "done" };
  if (record.type === "delta") {
    const text = readSpeechText(record.text);
    return text ? { turnId, type: "delta", text } : undefined;
  }
  if (record.type === "error") {
    const error = readRoomText(record.error, 1_000);
    return error ? { turnId, type: "error", error } : undefined;
  }
  return undefined;
}

function readConversationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

function readMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= 12_000 ? text : undefined;
}

function readSpeechText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= 1_200 ? text : undefined;
}

function readVoice(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const voice = value.trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(voice) ? voice : undefined;
}

function readLeaseToken(value: unknown): string | null {
  return typeof value === "string" && value.length >= 16 && value.length <= 128 ? value : null;
}

function sendEvent(res: express.Response, event: object): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function abortOnDisconnect(req: express.Request, res: express.Response): AbortController {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected upstream error";
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const secret = process.env.MELDIVO_SECRET;
  if (!secret) throw new Error("MELDIVO_SECRET is required");
  const port = numberEnv("MELDIVO_PORT", 4100);
  const httpsPort = numberEnv("MELDIVO_HTTPS_PORT", 4443);
  const publicUrl = process.env.MELDIVO_PUBLIC_URL?.trim() || undefined;
  const modelsDir = process.env.MELDIVO_MODELS_DIR?.trim() || undefined;
  const speech = createSherpaEngine(modelsDir ? { modelsDir } : undefined);
  void startServer({ port, host: "127.0.0.1", secret, publicUrl, speech, httpsPort });
  // Download and load the voice models in the background so the first turn is fast.
  speech.warmup?.().catch((error: unknown) => console.error("speech warmup failed:", error));
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}
