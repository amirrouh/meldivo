import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announceLinkWithQr, clearLinkQr } from "./qr.ts";
import { createRemoteManager } from "./remote.ts";

type Room = { room: string; token: string; url: string };
type PendingTurn = { id: string };

const localLinkQrWidgetKey = "meldivo-link-qr";

const pollIntervalMs = 1_500;
const healthPollIntervalMs = 500;
const healthWaitTimeoutMs = 10_000;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function configDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo");
}

function stateDir() {
  const base = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
  return path.join(base, "meldivo");
}

/** Reads the persisted Meldivo secret, creating one on first use. */
function loadOrCreateSecret(): string {
  const dir = configDir();
  const file = path.join(dir, "secret");
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value) return value;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

function port() {
  return process.env.MELDIVO_PORT ?? "4100";
}

function httpsPort() {
  return Number(process.env.MELDIVO_HTTPS_PORT ?? "4443");
}

function baseUrl() {
  return `http://127.0.0.1:${port()}`;
}

/** Resolves the compiled server entry point shipped alongside this extension. */
function serverEntryPath(): string {
  try {
    return fileURLToPath(new URL("../dist/server/index.js", import.meta.url));
  } catch {
    // Fallback for runtimes that don't resolve import.meta.url as expected.
    const dir = (globalThis as { __dirname?: string }).__dirname ?? process.cwd();
    return path.join(dir, "..", "dist", "server", "index.js");
  }
}

async function api(path_: string, secret: string, options: RequestInit = {}, token?: string) {
  const response = await fetch(`${baseUrl()}${path_}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : { "x-meldivo-secret": secret }),
      ...options.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error ?? `Meldivo server returned ${response.status}`);
  return payload;
}

async function checkHealth(): Promise<{ ok: boolean; speechReady?: boolean }> {
  try {
    const response = await fetch(`${baseUrl()}/api/health`);
    if (!response.ok) return { ok: false };
    const payload = (await response.json()) as { ok?: boolean; speech?: { ready?: boolean } };
    return { ok: !!payload?.ok, speechReady: payload?.speech?.ready };
  } catch {
    return { ok: false };
  }
}

/** Starts the Meldivo server as a detached background process, if it isn't already running. */
async function ensureServerRunning(secret: string, ctx: ExtensionCommandContext): Promise<{ speechReady?: boolean }> {
  const initial = await checkHealth();
  if (initial.ok) return initial;

  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logPath = path.join(dir, "server.log");
  const logFd = openSync(logPath, "a");

  const child = spawn("node", [serverEntryPath()], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      MELDIVO_SECRET: secret,
    },
  });
  child.unref();

  const deadline = Date.now() + healthWaitTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(healthPollIntervalMs);
    const health = await checkHealth();
    if (health.ok) return health;
  }
  throw new Error(`Meldivo server did not become healthy within ${healthWaitTimeoutMs}ms; see ${logPath}`);
}

function textFromMessage(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const value = message as { content?: unknown };
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** Pi extension: run /meldivo in an active Pi session to get a localhost voice link. */
export default function meldivoExtension(pi: ExtensionAPI) {
  let room: Room | undefined;
  let pending: PendingTurn | undefined;
  let stopped = false;
  let loop: Promise<void> | undefined;
  let secret: string | undefined;
  const remote = createRemoteManager();

  /** Starts the server if needed and opens a fresh room, notifying the resulting link. Returns whether it succeeded. */
  const connectRoom = async (ctx: ExtensionCommandContext): Promise<boolean> => {
    let health: { speechReady?: boolean };
    try {
      health = await ensureServerRunning(secret!, ctx);
    } catch (error) {
      ctx.ui.notify(`Meldivo failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }

    const response = await api("/api/rooms", secret!, {
      method: "POST",
      body: JSON.stringify({
        mode: "harness",
        harness: "pi",
        cwd: ctx.cwd,
        label: pi.getSessionName() ?? undefined,
      }),
    });
    room = { room: response.room.id, token: response.token, url: response.url };
    stopped = false;
    const note = health.speechReady === false
      ? " (first run downloads voice models, about 650 MB; voice mode is ready once it finishes)"
      : "";
    await announceLinkWithQr(ctx, `Meldivo connected${note}`, room.url, localLinkQrWidgetKey);
    loop = listen(ctx);
    return true;
  };

  const listen = async (ctx: ExtensionCommandContext) => {
    while (room && !stopped) {
      try {
        const next = await api(`/api/rooms/${encodeURIComponent(room.room)}/adapter/next`, secret!, { method: "POST" }, room.token);
        if (!next) {
          await sleep(pollIntervalMs);
          continue;
        }
        pending = { id: next.turnId };
        const delivery = ctx.isIdle() ? undefined : { deliverAs: "followUp" as const };
        await pi.sendUserMessage(next.message, delivery);
      } catch (error) {
        if (!stopped) ctx.ui.notify(`Meldivo disconnected: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
    }
  };

  pi.registerCommand("meldivo", {
    description: "Connect or disconnect Meldivo voice mode for this Pi session, or expose it remotely",
    handler: async (args, ctx) => {
      secret = secret ?? loadOrCreateSecret();
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      if (tokens[0] === "remote") {
        if (tokens[1] === "stop") {
          await remote.stop(ctx, { secret, baseUrl: baseUrl() });
          return;
        }
        if (!room && !(await connectRoom(ctx))) return;
        await remote.start(ctx, { secret, baseUrl: baseUrl(), roomUrl: room!.url, port: Number(port()), httpsPort: httpsPort() });
        return;
      }

      if (tokens[0] === "stop") {
        stopped = true;
        await remote.stop(ctx, { secret, baseUrl: baseUrl() });
        clearLinkQr(ctx, localLinkQrWidgetKey);
        if (room) await api(`/api/rooms/${encodeURIComponent(room.room)}`, secret, { method: "DELETE" }, room.token).catch(() => undefined);
        room = undefined;
        pending = undefined;
        ctx.ui.notify("Meldivo voice mode stopped", "info");
        return;
      }

      if (room) {
        const confirmed = await ctx.ui.confirm("Disconnect Meldivo?", "Voice mode will stop for this session.");
        if (!confirmed) {
          ctx.ui.notify("Meldivo stays connected.", "info");
          return;
        }
        stopped = true;
        await remote.stop(ctx, { secret, baseUrl: baseUrl() });
        clearLinkQr(ctx, localLinkQrWidgetKey);
        await api(`/api/rooms/${encodeURIComponent(room.room)}`, secret, { method: "DELETE" }, room.token).catch(() => undefined);
        room = undefined;
        pending = undefined;
        ctx.ui.notify("Meldivo disconnected.", "info");
        return;
      }

      await connectRoom(ctx);
    },
  });

  pi.on("message_end", async (event) => {
    if (!pending || event.message.role !== "assistant" || !room || !secret) return;
    const turn = pending;
    pending = undefined;
    const text = textFromMessage(event.message);
    try {
      if (text) await api(`/api/rooms/${encodeURIComponent(room.room)}/adapter/events`, secret, {
        method: "POST",
        body: JSON.stringify({ turnId: turn.id, type: "delta", text }),
      }, room.token);
      await api(`/api/rooms/${encodeURIComponent(room.room)}/adapter/events`, secret, {
        method: "POST",
        body: JSON.stringify({ turnId: turn.id, type: "done" }),
      }, room.token);
    } catch {
      // The server may have been stopped before Pi finished its turn.
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    stopped = true;
    await loop?.catch(() => undefined);
    if (secret) await remote.stop(ctx, { secret, baseUrl: baseUrl() }).catch(() => undefined);
    clearLinkQr(ctx, localLinkQrWidgetKey);
    if (room && secret) await api(`/api/rooms/${encodeURIComponent(room.room)}`, secret, { method: "DELETE" }, room.token).catch(() => undefined);
  });
}
