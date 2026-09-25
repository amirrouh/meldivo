import { uid } from "./uid";
import { authHeaders } from "./auth";

const LOCK_NAME = "voice-assistant-microphone";
const FALLBACK_KEY = "voice-assistant-microphone-owner";
const FALLBACK_LEASE_MS = 15_000;
const FALLBACK_HEARTBEAT_MS = 5_000;
const SERVER_HEARTBEAT_MS = 5_000;

export type VoiceOwnership = {
  release: () => void;
};

type ServerLease = { token: string; expiresAt: number };

type FallbackOwner = {
  id: string;
  expiresAt: number;
};

function readFallbackOwner(): FallbackOwner | null {
  try {
    const raw = window.localStorage.getItem(FALLBACK_KEY);
    if (!raw) return null;
    const owner = JSON.parse(raw) as Partial<FallbackOwner>;
    if (typeof owner.id !== "string" || typeof owner.expiresAt !== "number") return null;
    return { id: owner.id, expiresAt: owner.expiresAt };
  } catch {
    return null;
  }
}

function acquireFallbackOwnership(): VoiceOwnership | null {
  const id = uid();
  const now = Date.now();
  const active = readFallbackOwner();
  if (active && active.expiresAt > now) return null;

  const claim = () => window.localStorage.setItem(FALLBACK_KEY, JSON.stringify({ id, expiresAt: Date.now() + FALLBACK_LEASE_MS }));
  try {
    claim();
    if (readFallbackOwner()?.id !== id) return null;
  } catch {
    // If storage is disabled, do not prevent a local voice session from starting.
    return { release: () => {} };
  }

  let released = false;
  const heartbeat = window.setInterval(() => {
    if (released || readFallbackOwner()?.id !== id) return;
    claim();
  }, FALLBACK_HEARTBEAT_MS);
  return {
    release: () => {
      if (released) return;
      released = true;
      window.clearInterval(heartbeat);
      try {
        if (readFallbackOwner()?.id === id) window.localStorage.removeItem(FALLBACK_KEY);
      } catch {
        // Storage may become unavailable during page teardown.
      }
    },
  };
}

async function acquireWebLockOwnership(): Promise<VoiceOwnership | null> {
  let releaseLock!: () => void;
  let resolveAcquired!: (ownership: VoiceOwnership | null) => void;
  let rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<VoiceOwnership | null>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });
  const held = new Promise<void>((resolve) => { releaseLock = resolve; });

  void navigator.locks.request(LOCK_NAME, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) {
      resolveAcquired(null);
      return;
    }
    let released = false;
    resolveAcquired({
      release: () => {
        if (released) return;
        released = true;
        releaseLock();
      },
    });
    await held;
  }).catch(rejectAcquired);

  return acquired;
}

async function acquireServerOwnership(onLost: () => void): Promise<VoiceOwnership | null> {
  const response = await fetch("/api/voice/lease", { method: "POST", headers: authHeaders() });
  if (response.status === 409) return null;
  if (!response.ok) throw new Error("Could not reserve the voice session.");
  const lease = await response.json() as Partial<ServerLease>;
  if (typeof lease.token !== "string" || lease.token.length < 16) throw new Error("Voice session returned an invalid lease.");

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    window.clearInterval(heartbeat);
    void fetch("/api/voice/lease", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ token: lease.token }),
      keepalive: true,
    }).catch(() => undefined);
  };
  const heartbeat = window.setInterval(() => {
    void fetch("/api/voice/lease/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ token: lease.token }),
    }).then((renewal) => {
      if (renewal.status === 409) {
        release();
        onLost();
      }
    }).catch(() => undefined);
  }, SERVER_HEARTBEAT_MS);
  return { release };
}

export async function acquireVoiceOwnership(onLost: () => void = () => {}): Promise<VoiceOwnership | null> {
  const browserOwnership = typeof navigator !== "undefined" && navigator.locks
    ? await acquireWebLockOwnership()
    : typeof window === "undefined" ? null : acquireFallbackOwnership();
  if (!browserOwnership) return null;
  try {
    const serverOwnership = await acquireServerOwnership(onLost);
    if (!serverOwnership) {
      browserOwnership.release();
      return null;
    }
    return {
      release: () => {
        serverOwnership.release();
        browserOwnership.release();
      },
    };
  } catch (error) {
    browserOwnership.release();
    throw error;
  }
}
