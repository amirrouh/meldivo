import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { createAdapters, listAllSessions } from "./harnesses/index.js";
import type { HarnessAdapter, HarnessId, SendTarget, SessionInfo, TurnEvent } from "./harnesses/types.js";
import { createAccessGate } from "./access.js";
import { createLogger, requestLoggingMiddleware } from "./logger.js";
import { detectRemoteOptions, RemoteManager, remoteGuideUrl, type RemoteId } from "./remote.js";
import { createSherpaEngine, type SpeechEngine } from "./speech.js";
import { defaultStateDir, SessionStateStore } from "./state.js";

const VOICE_LEASE_TTL_MS = 15_000;
const SESSIONS_CACHE_MS = 3_000;
const SESSIONS_LIMIT = 50;
const HARNESS_ORDER: HarnessId[] = ["pi", "opencode", "claude"];

export interface StartServerOptions {
  port?: number;
  host?: string;
  /** Extra addresses to listen on as well, e.g. a VPN address for a reverse proxy. */
  extraHosts?: string[];
  secret: string;
  publicUrl?: string;
  speech?: SpeechEngine;
  adapters?: HarnessAdapter[];
  webDir?: string;
  stateDir?: string;
  httpsPort?: number;
}

// Where a user-supplied TLS certificate for remote access lives.
function tlsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo", "tls");
}

// The lock that keeps only one browser tab recording at a time. It is a
// single process-wide slot rather than per-session state, since only one
// voice session is ever meant to be live from this machine. The newest claim
// wins: a reloaded page or another device takes over immediately, and the
// previous holder learns it lost the lease on its next heartbeat.
class VoiceLease {
  private active: { token: string; expiresAt: number } | null = null;

  constructor(private readonly ttlMs: number) {}

  claim(): { token: string; expiresAt: number } {
    this.active = { token: randomUUID(), expiresAt: Date.now() + this.ttlMs };
    return this.active;
  }

  renew(token: string | null): { token: string; expiresAt: number } | null {
    if (!token || !this.active || this.active.token !== token) return null;
    this.active = { ...this.active, expiresAt: Date.now() + this.ttlMs };
    return this.active;
  }

  release(token: string | null): void {
    if (token && this.active?.token === token) this.active = null;
  }
}

type SessionsSnapshot = {
  at: number;
  harnesses: { id: HarnessId; label: string; available: boolean }[];
  sessions: SessionInfo[];
};

type AttemptOutcome = "committed" | "failed";

export async function startServer(options: StartServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const secret = options.secret;
  const speech = options.speech ?? createSherpaEngine();
  const webDir = options.webDir ?? fileURLToPath(new URL("../web", import.meta.url));
  const stateDir = options.stateDir ?? defaultStateDir();
  const logger = createLogger();
  const adapters = options.adapters ?? createAdapters();
  if (!options.adapters) {
    // Start slow-to-boot harness backends (the OpenCode server) now rather than on the first turn.
    for (const adapter of adapters) {
      adapter.warmup?.().catch((error: unknown) => console.error(`${adapter.id} warmup failed:`, error));
    }
  }
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const stateStore = new SessionStateStore(stateDir);
  const voiceLease = new VoiceLease(VOICE_LEASE_TTL_MS);
  const activeTurns = new Map<string, AbortController>();
  const homeDir = homedir();
  const app = express();
  let httpsServer: HttpsServer | undefined;
  let httpsActualPort: number | undefined;
  let sessionsSnapshot: SessionsSnapshot | undefined;

  app.use(requestLoggingMiddleware(logger));
  app.use(express.json({ limit: "1mb" }));

  // Nothing is served without the secret: not the page, not even health (see access.ts).
  const gate = createAccessGate(secret);
  app.post("/api/unlock", gate.unlock);
  app.use(gate.middleware);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, speech: speech.status() });
  });

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

  const remoteManager = new RemoteManager({
    httpPort: 0, // patched to the real port once listen() resolves, below
    enableHttps,
    disableHttps,
    buildUrl: (origin) => `${origin}/#token=${encodeURIComponent(secret)}`,
  });

  async function getSessionsSnapshot(): Promise<SessionsSnapshot> {
    if (sessionsSnapshot && Date.now() - sessionsSnapshot.at < SESSIONS_CACHE_MS) return sessionsSnapshot;
    const [sessions, availability, forkIds] = await Promise.all([
      listAllSessions(adapters, SESSIONS_LIMIT),
      Promise.all(adapters.map(async (adapter) => ({ id: adapter.id, label: adapter.label, available: await adapter.available() }))),
      stateStore.allForkIds(),
    ]);
    // Voice forks are an implementation detail of continuing an open session;
    // hide them from the list so they don't show up as extra sessions.
    const visible = sessions.filter((session) => !forkIds.has(session.id));
    sessionsSnapshot = { at: Date.now(), harnesses: availability, sessions: visible };
    return sessionsSnapshot;
  }

  app.get("/api/sessions", async (_req, res) => {
    const snapshot = await getSessionsSnapshot();
    res.set("Cache-Control", "no-store").json({ machine: hostname(), harnesses: snapshot.harnesses, sessions: snapshot.sessions });
  });

  // Runs one candidate adapter for one turn, streaming its events to `res`.
  // When `allowFallback` is set, events are buffered until the first delta;
  // an error before any delta is swallowed and reported as "failed" so the
  // caller can retry with the next harness instead. Once a delta (or a
  // terminal event) has been seen, the outcome is final ("committed").
  async function attempt(
    adapter: HarnessAdapter,
    target: SendTarget,
    message: string,
    signal: AbortSignal,
    res: express.Response,
    opts: {
      allowFallback?: boolean;
      onSessionId?: (id: string) => void | Promise<void>;
      // Fired the instant the session id is known, mid-stream, well before the
      // turn ends. Lets the caller register an alias for cancellation: a
      // "new:<harness>" turn's client learns the resolved key from this same
      // event and switches to it immediately, so /cancel must find the turn
      // under either the original request key or the resolved one.
      onLiveSessionId?: (id: string) => void;
    } = {},
  ): Promise<AttemptOutcome> {
    const allowFallback = opts.allowFallback ?? false;
    const buffered: TurnEvent[] = [];
    let sawDelta = false;
    let sessionId: string | undefined;

    // Persists the session/fork id (if any) *before* the terminal event
    // reaches the client, so a caller's very next request — sent the
    // instant it observes "done" — never races the bookkeeping that
    // request depends on (e.g. the busy-lock for this key, or which
    // session a fork continues).
    const persist = async (): Promise<void> => {
      if (sessionId && opts.onSessionId) await opts.onSessionId(sessionId);
    };
    const endWith = async (terminal: TurnEvent): Promise<void> => {
      await persist();
      flush(res, buffered);
      buffered.length = 0;
      sendEvent(res, terminal);
      if (!res.writableEnded) res.end();
    };

    try {
      for await (const event of adapter.send(target, message, signal)) {
        if (event.type === "session") {
          sessionId = event.id;
          opts.onLiveSessionId?.(event.id);
        }
        if (event.type === "delta") sawDelta = true;

        if (allowFallback && !sawDelta) {
          if (event.type === "error") return "failed";
          if (event.type === "done") {
            await endWith(event);
            return "committed";
          }
          buffered.push(event);
          continue;
        }

        if (event.type === "error" || event.type === "done") {
          await endWith(event);
          return "committed";
        }

        if (buffered.length > 0) {
          flush(res, buffered);
          buffered.length = 0;
        }
        sendEvent(res, event);
      }
      // Defensive: the generator ended without an explicit done/error event.
      await endWith({ type: "done" });
      return "committed";
    } catch (error) {
      if (allowFallback && !sawDelta) return "failed";
      await endWith({ type: "error", message: messageFor(error) });
      return "committed";
    }
  }

  async function runQuick(message: string, conversationId: string | undefined, signal: AbortSignal, res: express.Response): Promise<void> {
    const conversation = conversationId ? await stateStore.getConversation(conversationId) : undefined;
    if (conversation) {
      const adapter = adapterById.get(conversation.harness as HarnessId);
      if (adapter) {
        await attempt(adapter, { id: conversation.id, cwd: homeDir, fork: false }, message, signal, res, {
          onSessionId: (id) => (conversationId ? stateStore.setConversation(conversationId, { harness: adapter.id, id }) : undefined),
        });
        return;
      }
    }

    const candidates: HarnessAdapter[] = [];
    for (const id of HARNESS_ORDER) {
      const adapter = adapterById.get(id);
      if (adapter && (await adapter.available())) candidates.push(adapter);
    }
    if (candidates.length === 0) {
      sendEvent(res, { type: "error", message: "No coding-agent CLI is available on this machine" });
      res.end();
      return;
    }

    for (let index = 0; index < candidates.length; index++) {
      const adapter = candidates[index]!;
      const isLast = index === candidates.length - 1;
      const outcome = await attempt(adapter, { id: null, cwd: homeDir, fork: false }, message, signal, res, {
        allowFallback: !isLast,
        onSessionId: (id) => (conversationId ? stateStore.setConversation(conversationId, { harness: adapter.id, id }) : undefined),
      });
      if (outcome === "committed") return;
      const next = candidates[index + 1]!;
      sendEvent(res, { type: "status", message: `${adapter.label} unavailable, using ${next.label}` });
    }
  }

  async function runNew(
    harness: HarnessId,
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    res: express.Response,
    onLiveSessionId?: (id: string) => void,
  ): Promise<void> {
    const adapter = adapterById.get(harness);
    if (!adapter) {
      sendEvent(res, { type: "error", message: `Unknown harness "${harness}"` });
      res.end();
      return;
    }
    let id: string | null = null;
    if (conversationId) {
      const conversation = await stateStore.getConversation(conversationId);
      if (conversation && conversation.harness === harness) id = conversation.id;
    }
    await attempt(adapter, { id, cwd: homeDir, fork: false }, message, signal, res, {
      onSessionId: (sessionId) => (conversationId ? stateStore.setConversation(conversationId, { harness, id: sessionId }) : undefined),
      onLiveSessionId,
    });
  }

  async function findSession(harness: HarnessId, id: string): Promise<SessionInfo | undefined> {
    const snapshot = await getSessionsSnapshot();
    const cached = snapshot.sessions.find((session) => session.harness === harness && session.id === id);
    if (cached) return cached;
    const adapter = adapterById.get(harness);
    if (!adapter) return undefined;
    const deeper = await adapter.listSessions(200).catch((): SessionInfo[] => []);
    return deeper.find((session) => session.id === id);
  }

  async function runExisting(key: string, harness: HarnessId, id: string, message: string, signal: AbortSignal, res: express.Response): Promise<void> {
    const adapter = adapterById.get(harness);
    if (!adapter) {
      sendEvent(res, { type: "error", message: `Unknown harness "${harness}"` });
      res.end();
      return;
    }
    const info = await findSession(harness, id);
    if (!info) {
      sendEvent(res, { type: "error", message: "Session not found" });
      res.end();
      return;
    }

    if (info.open) {
      const forkId = await stateStore.getFork(key);
      if (forkId) {
        await attempt(adapter, { id: forkId, cwd: info.cwd, model: info.model, fork: false }, message, signal, res);
      } else {
        await attempt(adapter, { id: info.id, cwd: info.cwd, model: info.model, fork: true }, message, signal, res, {
          onSessionId: (newId) => stateStore.setFork(key, newId),
        });
      }
    } else {
      await attempt(adapter, { id: info.id, cwd: info.cwd, model: info.model, fork: false }, message, signal, res);
    }
  }

  app.post("/api/sessions/:key/chat", async (req, res) => {
    const key = req.params.key!;
    const message = readMessage(req.body?.message);
    if (!message) return res.status(400).json({ error: "message is required" });
    if (activeTurns.has(key)) return res.status(409).json({ error: "This session is busy" });
    const conversationId = readConversationId(req.body?.conversationId);

    const controller = new AbortController();
    activeTurns.set(key, controller);
    req.on("aborted", () => controller.abort());
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // A "new:<harness>" turn tells its client the resolved "<harness>:<id>" key
    // as soon as the underlying session id is known (see the "session" SSE
    // event), well before the turn ends. The client switches to that key
    // immediately, including for a barge-in /cancel sent mid-turn - so the
    // resolved key must also resolve to this same controller.
    let aliasKey: string | undefined;
    const registerAlias = (id: string) => {
      aliasKey = `${key.slice(4)}:${id}`;
      if (!activeTurns.has(aliasKey)) activeTurns.set(aliasKey, controller);
    };

    try {
      if (key === "quick") {
        await runQuick(message, conversationId, controller.signal, res);
      } else if (key.startsWith("new:")) {
        await runNew(key.slice(4) as HarnessId, message, conversationId, controller.signal, res, registerAlias);
      } else {
        const sep = key.indexOf(":");
        if (sep < 0) {
          sendEvent(res, { type: "error", message: "Invalid session key" });
          res.end();
        } else {
          await runExisting(key, key.slice(0, sep) as HarnessId, key.slice(sep + 1), message, controller.signal, res);
        }
      }
    } finally {
      if (activeTurns.get(key) === controller) activeTurns.delete(key);
      if (aliasKey && activeTurns.get(aliasKey) === controller) activeTurns.delete(aliasKey);
    }
  });

  app.post("/api/sessions/:key/cancel", (req, res) => {
    const key = req.params.key!;
    const controller = activeTurns.get(key);
    if (!controller) return res.status(404).json({ error: "No active turn for this session" });
    controller.abort();
    res.status(204).end();
  });

  app.get("/api/remote", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ options: detectRemoteOptions(), active: remoteManager.status().active, guide: remoteGuideUrl });
  });

  app.post("/api/remote", async (req, res) => {
    const id = readRemoteId(req.body?.id);
    if (!id) return res.status(400).json({ error: "id must be one of tailscale, cloudflare, certificate" });
    try {
      const result = await remoteManager.start(id);
      res.status(200).json(result);
    } catch (error) {
      res.status(502).json({ error: messageFor(error) });
    }
  });

  app.delete("/api/remote", async (_req, res) => {
    await remoteManager.stop();
    res.status(204).end();
  });

  app.post("/api/voice/lease", (_req, res) => {
    res.status(201).json(voiceLease.claim());
  });

  app.post("/api/voice/lease/heartbeat", (req, res) => {
    const lease = voiceLease.renew(readLeaseToken(req.body?.token));
    if (!lease) return res.status(409).json({ error: "Voice session is no longer active." });
    res.json(lease);
  });

  app.delete("/api/voice/lease", (req, res) => {
    voiceLease.release(readLeaseToken(req.body?.token));
    res.status(204).end();
  });

  app.post("/api/voice/transcribe", express.raw({ type: "audio/wav", limit: "16mb" }), async (req, res) => {
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

  app.get("/api/voice/voices", (_req, res) => {
    res.set("Cache-Control", "no-store").json({ current: speech.defaultVoice, voices: speech.voices() });
  });

  app.post("/api/voice/speech", async (req, res) => {
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

  let httpServer: Server;
  await new Promise<void>((resolve, reject) => {
    httpServer = app.listen(options.port ?? 0, host, () => resolve());
    httpServer.once("error", reject);
  });
  const actualPort = (httpServer!.address() as AddressInfo).port;
  const extraServers: Server[] = [];
  for (const extraHost of options.extraHosts ?? []) {
    await new Promise<void>((resolve, reject) => {
      const extra = app.listen(actualPort, extraHost, () => resolve());
      extra.once("error", reject);
      extraServers.push(extra);
    });
  }
  (remoteManager as unknown as { opts: { httpPort: number } }).opts.httpPort = actualPort;
  logger.info("server_started", { host, extraHosts: (options.extraHosts ?? []).join(","), port: actualPort });

  async function close(): Promise<void> {
    for (const controller of activeTurns.values()) controller.abort();
    activeTurns.clear();
    await Promise.all([
      ...[httpServer, ...extraServers].map((server) => new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })),
      remoteManager.stop(),
      disableHttps(),
    ]);
  }

  return { port: actualPort, close };
}

function flush(res: express.Response, events: TurnEvent[]): void {
  for (const event of events) sendEvent(res, event);
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

function readRemoteId(value: unknown): RemoteId | undefined {
  return value === "tailscale" || value === "cloudflare" || value === "certificate" ? value : undefined;
}

function sendEvent(res: express.Response, event: TurnEvent | { type: "status"; message: string }): void {
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
  const extraHosts = (process.env.MELDIVO_HOST ?? "").split(",").map((value) => value.trim()).filter((value) => value && value !== "127.0.0.1");
  void startServer({ port, host: "127.0.0.1", extraHosts, secret, publicUrl, speech, httpsPort });
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
