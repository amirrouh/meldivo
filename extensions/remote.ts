import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announceLinkWithQr, clearLinkQr } from "./qr.ts";

export const remoteGuideUrl = "https://github.com/amirrouh/meldivo/blob/main/docs/remote-access.md";
const remoteLinkQrWidgetKey = "meldivo-remote-qr";

const cloudflaredReadyTimeoutMs = 30_000;
const spawnSyncTimeoutMs = 5_000;

type ReadyOption = "tailscale" | "cloudflare" | "certificate";

type Detected = {
  tailscale?: { dnsName: string };
  cloudflare: boolean;
  certificate: boolean;
};

function tlsDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "meldivo", "tls");
}

/** Reads `tailscale status --json`, without a shell, to see if it's ready to serve HTTPS. */
function detectTailscale(): { dnsName: string } | undefined {
  try {
    const result = spawnSync("tailscale", ["status", "--json"], { timeout: spawnSyncTimeoutMs, encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) return undefined;
    const data = JSON.parse(result.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    if (data.BackendState !== "Running") return undefined;
    const dnsName = data.Self?.DNSName?.replace(/\.$/, "");
    return dnsName ? { dnsName } : undefined;
  } catch {
    return undefined;
  }
}

function detectCloudflared(): boolean {
  try {
    const result = spawnSync("cloudflared", ["--version"], { timeout: spawnSyncTimeoutMs });
    return result.status === 0;
  } catch {
    return false;
  }
}

function detectCertificate(): boolean {
  const dir = tlsDir();
  return existsSync(path.join(dir, "cert.pem")) && existsSync(path.join(dir, "key.pem"));
}

function detect(): Detected {
  return { tailscale: detectTailscale(), cloudflare: detectCloudflared(), certificate: detectCertificate() };
}

function nonInternalIPv4(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/** Swaps the origin of a room deep link, keeping its ?room=…#token=… intact. */
function replaceOrigin(roomUrl: string, origin: string): string {
  const room = new URL(roomUrl);
  const target = new URL(origin);
  room.protocol = target.protocol;
  room.hostname = target.hostname;
  room.port = target.port;
  return room.toString();
}

async function callSecret(baseUrl: string, path_: string, secret: string, body: unknown): Promise<{ port: number | null }> {
  const response = await fetch(`${baseUrl}${path_}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-meldivo-secret": secret },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error ?? `Meldivo server returned ${response.status}`);
  return payload;
}

export type RemoteStartOptions = {
  secret: string;
  baseUrl: string;
  roomUrl: string;
  port: number;
  httpsPort: number;
};

/** Owns the lifecycle of whichever remote-access transport `/meldivo remote` turns on. */
export function createRemoteManager() {
  let cloudflaredChild: ChildProcess | undefined;
  let tailscaleOn = false;
  let httpsOn = false;

  function startTailscale(ctx: ExtensionCommandContext, port: number, dnsName: string): string | undefined {
    const result = spawnSync("tailscale", ["serve", "--bg", String(port)], { timeout: 10_000, encoding: "utf8" });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "unknown error").trim();
      ctx.ui.notify(`Tailscale serve failed: ${detail}\nSetup guide: ${remoteGuideUrl}`, "error");
      return undefined;
    }
    tailscaleOn = true;
    return `https://${dnsName}`;
  }

  function startCloudflared(ctx: ExtensionCommandContext, port: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      cloudflaredChild = child;
      let buffer = "";
      let settled = false;
      const settle = (value: string | undefined, notice?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (notice) ctx.ui.notify(`${notice}\nSetup guide: ${remoteGuideUrl}`, "error");
        resolve(value);
      };
      const timer = setTimeout(() => settle(undefined, "Cloudflare tunnel did not start in time."), cloudflaredReadyTimeoutMs);
      child.stderr?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) settle(match[0]);
      });
      child.once("error", (error) => settle(undefined, `Cloudflare tunnel failed to start: ${error.message}`));
      child.once("exit", () => {
        if (cloudflaredChild === child) cloudflaredChild = undefined;
        settle(undefined, "Cloudflare tunnel exited before it was ready.");
      });
    });
  }

  async function startCertificate(ctx: ExtensionCommandContext, opts: RemoteStartOptions): Promise<string | undefined> {
    try {
      const result = await callSecret(opts.baseUrl, "/api/remote/https", opts.secret, { enable: true });
      httpsOn = true;
      const ips = nonInternalIPv4();
      const port = result.port ?? opts.httpsPort;
      if (ips.length === 0) {
        ctx.ui.notify(`No non-internal network address found for the certificate link.\nSetup guide: ${remoteGuideUrl}`, "error");
        return undefined;
      }
      if (ips.length > 1) {
        const rest = ips.slice(1).map((ip) => `https://${ip}:${port}`).join(", ");
        ctx.ui.notify(`Also reachable at: ${rest}`, "info");
      }
      return `https://${ips[0]}:${port}`;
    } catch (error) {
      ctx.ui.notify(`Failed to enable HTTPS: ${error instanceof Error ? error.message : String(error)}\nSetup guide: ${remoteGuideUrl}`, "error");
      return undefined;
    }
  }

  async function start(ctx: ExtensionCommandContext, opts: RemoteStartOptions): Promise<void> {
    const detected = detect();
    const ready: { key: ReadyOption; label: string }[] = [];
    if (detected.tailscale) ready.push({ key: "tailscale", label: "Tailscale (private to your tailnet)" });
    if (detected.cloudflare) ready.push({ key: "cloudflare", label: "Cloudflare quick tunnel (public link)" });
    if (detected.certificate) ready.push({ key: "certificate", label: "My certificate (LAN/VPN, port 4443)" });

    if (ready.length === 0) {
      ctx.ui.notify(
        `Remote access needs HTTPS, and none of Tailscale, Cloudflare Tunnel, or a certificate is set up.\nSetup guide: ${remoteGuideUrl}`,
        "info",
      );
      return;
    }

    let choice: ReadyOption | undefined;
    if (!ctx.hasUI) {
      if (ready.length === 1) {
        choice = ready[0]!.key;
      } else {
        ctx.ui.notify(`Multiple remote access options are ready; pick one from a UI-capable session.\nSetup guide: ${remoteGuideUrl}`, "info");
        return;
      }
    } else {
      const labels = [...ready.map((option) => option.label), "Show setup guide"];
      const picked = await ctx.ui.select("Choose how to expose Meldivo remotely", labels);
      if (!picked) return;
      if (picked === "Show setup guide") {
        ctx.ui.notify(`Setup guide: ${remoteGuideUrl}`, "info");
        return;
      }
      choice = ready.find((option) => option.label === picked)?.key;
    }
    if (!choice) return;

    let origin: string | undefined;
    if (choice === "tailscale") origin = startTailscale(ctx, opts.port, detected.tailscale!.dnsName);
    else if (choice === "cloudflare") origin = await startCloudflared(ctx, opts.port);
    else origin = await startCertificate(ctx, opts);

    if (!origin) return;
    await announceLinkWithQr(ctx, "Meldivo remote link", replaceOrigin(opts.roomUrl, origin), remoteLinkQrWidgetKey);
  }

  async function stop(ctx: ExtensionContext | undefined, opts: { secret: string; baseUrl: string }): Promise<void> {
    let stoppedAnything = false;

    if (cloudflaredChild) {
      cloudflaredChild.kill();
      cloudflaredChild = undefined;
      stoppedAnything = true;
    }
    if (tailscaleOn) {
      spawnSync("tailscale", ["serve", "--https=443", "off"], { timeout: 10_000 });
      tailscaleOn = false;
      stoppedAnything = true;
    }
    if (httpsOn) {
      await callSecret(opts.baseUrl, "/api/remote/https", opts.secret, { enable: false }).catch(() => undefined);
      httpsOn = false;
      stoppedAnything = true;
    }

    if (ctx) {
      clearLinkQr(ctx, remoteLinkQrWidgetKey);
      if (stoppedAnything) ctx.ui.notify("Meldivo remote access stopped.", "info");
    }
  }

  return { start, stop };
}

export type RemoteManager = ReturnType<typeof createRemoteManager>;
