export const voicePreferenceKey = "voice-assistant.selected-voice";

type VoicePreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function isValidVoicePreference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

function browserStorage(storage?: VoicePreferenceStorage): VoicePreferenceStorage | undefined {
  if (storage) return storage;
  return typeof window === "undefined" ? undefined : window.localStorage;
}

export function readVoicePreference(storage?: VoicePreferenceStorage): string | undefined {
  try {
    const value = browserStorage(storage)?.getItem(voicePreferenceKey);
    return isValidVoicePreference(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeVoicePreference(voice: string, storage?: VoicePreferenceStorage): boolean {
  if (!isValidVoicePreference(voice)) return false;
  try {
    browserStorage(storage)?.setItem(voicePreferenceKey, voice);
    return true;
  } catch {
    return false;
  }
}

export function clearVoicePreference(storage?: VoicePreferenceStorage): void {
  try {
    browserStorage(storage)?.removeItem(voicePreferenceKey);
  } catch {
    // Browser storage is optional; the configured profile voice remains active.
  }
}
