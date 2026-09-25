import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

export const remoteGuideUrl = "https://github.com/amirrouh/meldivo/blob/main/docs/remote-access.md";

const cloudflaredReadyTimeoutMs = 30_000;
const spawnSyncTimeoutMs = 5_000;

export type RemoteId = "tailscale" | "cloudflare" | "certificate";

export interface RemoteOption {
  id: RemoteId;
  label: string;
  ready: boolean;
}

export interface RemoteActive {
  id: RemoteId;
  url: string;
}

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

/** The three remote-access options, and whether each is currently ready to use. */
export function detectRemoteOptions(): RemoteOption[] {
  const detected = detect();
  return [
    { id: "tailscale", label: "Tailscale (private to your tailnet)", ready: Boolean(detected.tailscale) },
    { id: "cloudflare", label: "Cloudflare quick tunnel (public link)", ready: detected.cloudflare },
    { id: "certificate", label: "My certificate (LAN/VPN)", ready: detected.certificate },
  ];
}

export interface RemoteManagerOptions {
  /** HTTP port the plain hub server listens on (used by tailscale serve / cloudflared). */
  httpPort: number;
  /** Enables the certificate-backed HTTPS listener, returning its actual port. */
  enableHttps(): Promise<number>;
  /** Disables the certificate-backed HTTPS listener. */
  disableHttps(): Promise<void>;
  /** Builds the hub URL (with token) for a given origin, e.g. `https://host.ts.net`. */
  buildUrl(origin: string): string;
}

/** Owns the lifecycle of whichever remote-access transport is currently turned on. */
export class RemoteManager {
  private cloudflaredChild: ChildProcess | undefined;
  private tailscaleOn = false;
  private httpsOn = false;
  private active: RemoteActive | null = null;

  constructor(private readonly opts: RemoteManagerOptions) {}

  status(): { active: RemoteActive | null } {
    return { active: this.active };
  }

  async start(id: RemoteId): Promise<{ url: string; alternatives?: string[] }> {
    await this.stop();
    if (id === "tailscale") return this.startTailscale();
    if (id === "cloudflare") return this.startCloudflare();
    return this.startCertificate();
  }

  private startTailscale(): { url: string } {
    const detected = detectTailscale();
    if (!detected) throw new Error(`Tailscale is not ready. Setup guide: ${remoteGuideUrl}`);
    const result = spawnSync("tailscale", ["serve", "--bg", String(this.opts.httpPort)], { timeout: 10_000, encoding: "utf8" });
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "unknown error").trim();
      throw new Error(`Tailscale serve failed: ${detail}. Setup guide: ${remoteGuideUrl}`);
    }
    this.tailscaleOn = true;
    const url = this.opts.buildUrl(`https://${detected.dnsName}`);
    this.active = { id: "tailscale", url };
    return { url };
  }

  private startCloudflare(): Promise<{ url: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.opts.httpPort}`], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.cloudflaredChild = child;
      let buffer = "";
      let settled = false;
      const settle = (origin: string | undefined, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!origin) {
          reject(new Error(`${error ?? "Cloudflare tunnel failed to start"}. Setup guide: ${remoteGuideUrl}`));
          return;
        }
        const url = this.opts.buildUrl(origin);
        this.active = { id: "cloudflare", url };
        resolve({ url });
      };
      const timer = setTimeout(() => settle(undefined, "Cloudflare tunnel did not start in time"), cloudflaredReadyTimeoutMs);
      child.stderr?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) settle(match[0]);
      });
      child.once("error", (error) => settle(undefined, `Cloudflare tunnel failed to start: ${error.message}`));
      child.once("exit", () => {
        if (this.cloudflaredChild === child) this.cloudflaredChild = undefined;
        settle(undefined, "Cloudflare tunnel exited before it was ready");
      });
    });
  }

  private async startCertificate(): Promise<{ url: string; alternatives?: string[] }> {
    if (!detectCertificate()) throw new Error(`No certificate found. Setup guide: ${remoteGuideUrl}`);
    const port = await this.opts.enableHttps();
    this.httpsOn = true;
    const ips = nonInternalIPv4();
    if (ips.length === 0) {
      await this.opts.disableHttps().catch(() => undefined);
      this.httpsOn = false;
      throw new Error(`No non-internal network address found for the certificate link. Setup guide: ${remoteGuideUrl}`);
    }
    const url = this.opts.buildUrl(`https://${ips[0]}:${port}`);
    const alternatives = ips.slice(1).map((ip) => this.opts.buildUrl(`https://${ip}:${port}`));
    this.active = { id: "certificate", url };
    return alternatives.length > 0 ? { url, alternatives } : { url };
  }

  async stop(): Promise<void> {
    if (this.cloudflaredChild) {
      this.cloudflaredChild.kill();
      this.cloudflaredChild = undefined;
    }
    if (this.tailscaleOn) {
      spawnSync("tailscale", ["serve", "--https=443", "off"], { timeout: 10_000 });
      this.tailscaleOn = false;
    }
    if (this.httpsOn) {
      await this.opts.disableHttps().catch(() => undefined);
      this.httpsOn = false;
    }
    this.active = null;
  }
}
