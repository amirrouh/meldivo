import { clampVadRedemptionMs, defaultVadRedemptionMs } from "./vad-config";

// Per-device end-of-speech wait, same persistence pattern as voice-preference.ts:
// stored in this browser's localStorage, never synced to the server.
export const vadRedemptionPreferenceKey = "voice-assistant.vad-redemption-ms";

type VadRedemptionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(storage?: VadRedemptionStorage): VadRedemptionStorage | undefined {
  if (storage) return storage;
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readVadRedemptionMs(storage?: VadRedemptionStorage): number {
  try {
    const raw = browserStorage(storage)?.getItem(vadRedemptionPreferenceKey);
    if (raw === null || raw === undefined) return defaultVadRedemptionMs;
    const value = Number(raw);
    return Number.isFinite(value) ? clampVadRedemptionMs(value) : defaultVadRedemptionMs;
  } catch {
    return defaultVadRedemptionMs;
  }
}

export function writeVadRedemptionMs(value: number, storage?: VadRedemptionStorage): number {
  const clamped = clampVadRedemptionMs(value);
  try {
    browserStorage(storage)?.setItem(vadRedemptionPreferenceKey, String(clamped));
  } catch {
    // Browser storage is optional; the default redemption window remains active.
  }
  return clamped;
}
