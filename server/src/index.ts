import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { createAdapters, listAllSessions } from "./harnesses/index.js";
import type { HarnessAdapter, HarnessId, SendTarget, SessionInfo, TurnEvent } from "./harnesses/types.js";
import { createAccessGate, notFound } from "./access.js";
import { createLogger, requestLoggingMiddleware } from "./logger.js";
import { createHub, hubSpeech, type Hub, type TurnSink } from "./hub.js";
import { loadHubLink, startMachineClient, type HubLink, type MachineClient } from "./machine-client.js";
import { MACHINE_NAME, parseMachineKey } from "./protocol.js";
import { detectRemoteOptions, RemoteManager, remoteGuideUrl, type RemoteId } from "./remote.js";
import { createSherpaEngine, type SpeechEngine } from "./speech.js";
import { defaultStateDir, SessionStateStore } from "./state.js";
import { voicePrompt } from "./harnesses/voice-turn.js";

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
  /** Where hub keys, machines.json, and hub.json live (default: ~/.config/meldivo). */
  configDir?: string;
  /** Run as a hub that other machines join (see hub.ts). */
  hub?: boolean;
  /** The hub this machine joined; default: hub.json in configDir, null for none. */
  hubLink?: HubLink | null;
  /** Reported to the hub by a joined machine. */
  version?: string;
  /** Load the speech models in the background at startup (a hub waits to see if a speech machine joins first). */
  warmupSpeech?: boolean;
}

function defaultConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo");
}

// Where a user-supplied TLS certificate for remote access lives.
function tlsDir(): string {
  return path.join(defaultConfigDir(), "tls");
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
  const localSpeech = options.speech ?? createSherpaEngine();
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
  const configDir = options.configDir ?? defaultConfigDir();
  const adapterById = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const stateStore = new SessionStateStore(stateDir);
  const voiceLease = new VoiceLease(VOICE_LEASE_TTL_MS);
  const activeTurns = new Map<string, AbortController>();
  const homeDir = homedir();
  const app = express();
  app.disable("x-powered-by");
  let httpsServer: HttpsServer | undefined;
  let httpsActualPort: number | undefined;
  let sessionsSnapshot: SessionsSnapshot | undefined;

  app.use(requestLoggingMiddleware(logger));
  app.use(express.json({ limit: "1mb" }));

  // Nothing is served without the secret: not the page, not even health (see access.ts). The
  // only exceptions authenticate on their own: unlock (the secret) and a machine joining this
  // hub (a one-time code); both answer anything invalid with the same plain 404.
  const gate = createAccessGate(secret);
  const hub: Hub | undefined = options.hub ? createHub({ configDir, logger, notFound }) : undefined;
  const speech = hub ? hubSpeech(localSpeech, hub, logger) : localSpeech;
  if (options.warmupSpeech) {
    const warm = () => localSpeech.warmup?.().catch((error: unknown) => console.error("speech warmup failed:", error));
    // A hub with a speech machine never needs its own models, so give machines time to connect.
    if (hub) setTimeout(() => { if (!hub.speechMachine()) void warm(); }, 30_000).unref();
    else void warm();
  }
  let machineClient: MachineClient | undefined;
  app.post("/api/unlock", gate.unlock);
  if (hub) app.post("/api/hub/join", hub.join);
  app.use(gate.middleware);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, speech: speech.status(), hub: Boolean(hub), joined: machineClient?.status() });
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
    hub?.attach(server);
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
    const machine = hostname();
    // `machine`/`harnesses` describe this machine; on a hub, `hosts` adds every joined machine,
    // whose sessions carry `host` plus a key prefixed with `@<machine>/`.
    const joined = hub?.hosts() ?? [];
    res.set("Cache-Control", "no-store").json({
      machine,
      harnesses: snapshot.harnesses,
      sessions: [...snapshot.sessions, ...joined.flatMap((host) => host.sessions)],
      hosts: [
        { id: "", name: machine, online: true, harnesses: snapshot.harnesses },
        ...joined.map((host) => ({ id: host.id, name: host.name, online: host.online, harnesses: host.harnesses })),
      ],
    });
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
    sink: TurnSink,
    opts: {
      allowFallback?: boolean;
      onSessionId?: (id: string) => void | Promise<void>;
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
      flush(sink, buffered);
      buffered.length = 0;
      sink.send(terminal);
      if (!sink.ended) sink.end();
    };

    try {
      // Every reply is spoken, so every turn asks for a short spoken answer (see voice-turn.ts).
      for await (const event of adapter.send(target, voicePrompt(message), signal)) {
        if (event.type === "session") sessionId = event.id;
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
          flush(sink, buffered);
          buffered.length = 0;
        }
        sink.send(event);
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

  async function runQuick(message: string, conversationId: string | undefined, signal: AbortSignal, sink: TurnSink): Promise<void> {
    const conversation = conversationId ? await stateStore.getConversation(conversationId) : undefined;
    if (conversation) {
      const adapter = adapterById.get(conversation.harness as HarnessId);
      if (adapter) {
        await attempt(adapter, { id: conversation.id, cwd: homeDir, fork: false }, message, signal, sink, {
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
      sink.send({ type: "error", message: "No coding-agent CLI is available on this machine" });
      sink.end();
      return;
    }

    for (let index = 0; index < candidates.length; index++) {
      const adapter = candidates[index]!;
      const isLast = index === candidates.length - 1;
      const outcome = await attempt(adapter, { id: null, cwd: homeDir, fork: false }, message, signal, sink, {
        allowFallback: !isLast,
        onSessionId: (id) => (conversationId ? stateStore.setConversation(conversationId, { harness: adapter.id, id }) : undefined),
      });
      if (outcome === "committed") return;
      const next = candidates[index + 1]!;
      sink.send({ type: "status", message: `${adapter.label} unavailable, using ${next.label}` });
    }
  }

  // A new chat starts in the home folder, or in a folder one of this machine's listed sessions
  // already uses (the hub offers exactly those), never in an arbitrary path.
  async function resolveNewChatFolder(requested: string | undefined): Promise<string | undefined> {
    if (!requested || requested === homeDir) return homeDir;
    const snapshot = await getSessionsSnapshot();
    if (!snapshot.sessions.some((session) => session.cwd === requested)) return undefined;
    try {
      return statSync(requested).isDirectory() ? requested : undefined;
    } catch {
      return undefined;
    }
  }

  async function runNew(
    harness: HarnessId,
    message: string,
    conversationId: string | undefined,
    requestedCwd: string | undefined,
    signal: AbortSignal,
    sink: TurnSink,
  ): Promise<void> {
    const adapter = adapterById.get(harness);
    if (!adapter) {
      sink.send({ type: "error", message: `Unknown harness "${harness}"` });
      sink.end();
      return;
    }
    const cwd = await resolveNewChatFolder(requestedCwd);
    if (!cwd) {
      sink.send({ type: "error", message: "That folder is not available on this machine" });
      sink.end();
      return;
    }
    let id: string | null = null;
    if (conversationId) {
      const conversation = await stateStore.getConversation(conversationId);
      if (conversation && conversation.harness === harness) id = conversation.id;
    }
    await attempt(adapter, { id, cwd, fork: false }, message, signal, sink, {
      onSessionId: (sessionId) => (conversationId ? stateStore.setConversation(conversationId, { harness, id: sessionId }) : undefined),
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

  async function runExisting(key: string, harness: HarnessId, id: string, message: string, signal: AbortSignal, sink: TurnSink): Promise<void> {
    const adapter = adapterById.get(harness);
    if (!adapter) {
      sink.send({ type: "error", message: `Unknown harness "${harness}"` });
      sink.end();
      return;
    }
    const info = await findSession(harness, id);
    if (!info) {
      sink.send({ type: "error", message: "Session not found" });
      sink.end();
      return;
    }

    if (info.open) {
      const forkId = await stateStore.getFork(key);
      if (forkId) {
        await attempt(adapter, { id: forkId, cwd: info.cwd, model: info.model, fork: false }, message, signal, sink);
      } else {
        await attempt(adapter, { id: info.id, cwd: info.cwd, model: info.model, fork: true }, message, signal, sink, {
          onSessionId: (newId) => stateStore.setFork(key, newId),
        });
      }
    } else {
      await attempt(adapter, { id: info.id, cwd: info.cwd, model: info.model, fork: false }, message, signal, sink);
    }
  }

  // Runs one turn for a session key, from the browser (SSE) or from the hub this machine
  // joined, and keeps it cancellable under its key. A "new:<harness>" turn's client learns the
  // resolved "<harness>:<id>" key from the "session" event, well before the turn ends, and
  // switches to it immediately (including for a barge-in /cancel sent mid-turn), so the
  // resolved key is registered for the same controller. Keys of a joined machine's sessions
  // ("@<machine>/...") are relayed to that machine.
  async function runTurn(key: string, message: string, conversationId: string | undefined, cwd: string | undefined, controller: AbortController, sink: TurnSink): Promise<void> {
    activeTurns.set(key, controller);
    const target = parseMachineKey(key);
    const inner = target ? target.inner : key;
    const prefix = target ? key.slice(0, key.length - inner.length) : "";
    let aliasKey: string | undefined;
    const tracked: TurnSink = {
      send(event) {
        if (event.type === "session" && inner.startsWith("new:") && !aliasKey) {
          aliasKey = `${prefix}${inner.slice(4)}:${event.id}`;
          if (!activeTurns.has(aliasKey)) activeTurns.set(aliasKey, controller);
        }
        sink.send(event);
      },
      end: () => sink.end(),
      get ended() { return sink.ended; },
    };
    try {
      if (target) {
        if (hub) await hub.relay(target.name, target.inner, message, conversationId, cwd, controller.signal, tracked);
        else {
          tracked.send({ type: "error", message: "Session not found" });
          tracked.end();
        }
      } else if (key === "quick") {
        await runQuick(message, conversationId, controller.signal, tracked);
      } else if (key.startsWith("new:")) {
        await runNew(key.slice(4) as HarnessId, message, conversationId, cwd, controller.signal, tracked);
      } else {
        const sep = key.indexOf(":");
        if (sep < 0) {
          tracked.send({ type: "error", message: "Invalid session key" });
          tracked.end();
        } else {
          await runExisting(key, key.slice(0, sep) as HarnessId, key.slice(sep + 1), message, controller.signal, tracked);
        }
      }
    } finally {
      if (activeTurns.get(key) === controller) activeTurns.delete(key);
      if (aliasKey && activeTurns.get(aliasKey) === controller) activeTurns.delete(aliasKey);
    }
  }

  app.post("/api/sessions/:key/chat", async (req, res) => {
    const key = req.params.key!;
    const message = readMessage(req.body?.message);
    if (!message) return res.status(400).json({ error: "message is required" });
    if (activeTurns.has(key)) return res.status(409).json({ error: "This session is busy" });
    const conversationId = readConversationId(req.body?.conversationId);
    const cwd = readFolder(req.body?.cwd);

    const controller = new AbortController();
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
    const sink: TurnSink = {
      send: (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); },
      end: () => { if (!res.writableEnded) res.end(); },
      get ended() { return res.writableEnded; },
    };
    await runTurn(key, message, conversationId, cwd, controller, sink);
    sink.end();
  });

  app.post("/api/sessions/:key/cancel", (req, res) => {
    const key = req.params.key!;
    const controller = activeTurns.get(key);
    if (!controller) return res.status(404).json({ error: "No active turn for this session" });
    // For a joined machine's turn, the hub forwards the cancel to that machine.
    controller.abort();
    res.status(204).end();
  });

  // Hub administration (used by `meldivo hub ...`); only exists when this is a hub.
  if (hub) {
    app.get("/api/hub/machines", (_req, res) => {
      res.set("Cache-Control", "no-store").json({ machines: hub.machines() });
    });
    app.post("/api/hub/codes", (_req, res) => {
      res.set("Cache-Control", "no-store").status(201).json(hub.createJoinCode());
    });
    app.delete("/api/hub/machines/:name", (req, res) => {
      const name = req.params.name!;
      if (!MACHINE_NAME.test(name) || !hub.remove(name)) return res.status(404).json({ error: "No such machine" });
      res.status(204).end();
    });
  }

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
  hub?.attach(httpServer!);
  const actualPort = (httpServer!.address() as AddressInfo).port;
  const extraServers: Server[] = [];
  for (const extraHost of options.extraHosts ?? []) {
    await new Promise<void>((resolve, reject) => {
      const extra = app.listen(actualPort, extraHost, () => resolve());
      extra.once("error", reject);
      hub?.attach(extra);
      extraServers.push(extra);
    });
  }
  (remoteManager as unknown as { opts: { httpPort: number } }).opts.httpPort = actualPort;
  logger.info("server_started", { host, extraHosts: (options.extraHosts ?? []).join(","), port: actualPort, hub: Boolean(hub) });

  const hubLink = options.hubLink === undefined ? loadHubLink(configDir) : options.hubLink ?? undefined;
  if (hubLink) {
    machineClient = startMachineClient({
      link: hubLink,
      logger,
      version: options.version ?? "unknown",
      snapshot: async () => {
        const snapshot = await getSessionsSnapshot();
        return { harnesses: snapshot.harnesses, sessions: snapshot.sessions };
      },
      isBusy: (key) => activeTurns.has(key),
      speech: localSpeech,
      runTurn: (key, message, conversationId, cwd, signal, sink) => {
        const controller = new AbortController();
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        return runTurn(key, message, conversationId, cwd, controller, sink);
      },
    });
  }

  async function close(): Promise<void> {
    for (const controller of activeTurns.values()) controller.abort();
    activeTurns.clear();
    machineClient?.close();
    hub?.close();
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

function flush(sink: TurnSink, events: TurnEvent[]): void {
  for (const event of events) sink.send(event);
}


function readConversationId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : undefined;
}

function readFolder(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("/") && value.length <= 1_000 && !value.includes("\0") ? value : undefined;
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
  const hub = process.env.MELDIVO_HUB === "1";
  const version = readVersion();
  // Speech models download and load in the background (warmupSpeech) so the first turn is fast.
  void startServer({ port, host: "127.0.0.1", extraHosts, secret, publicUrl, speech, httpsPort, hub, version, warmupSpeech: true });
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}
