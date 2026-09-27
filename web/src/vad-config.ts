/**
 * Silero v5 evaluates 32 ms frames. Keep these thresholds in one shared
 * module so the detector setup and its testable contract stay aligned.
 */
export const vadPositiveSpeechThreshold = 0.45;
export const vadNegativeSpeechThreshold = 0.30;
export const vadMinSpeechMs = 160; // Five 32 ms Silero v5 frames.
export const vadPreSpeechPadMs = 320;

// How long the detector waits, after speech drops below the negative threshold,
// before deciding the user has actually stopped talking. User-configurable (see
// vad-preference.ts) because it trades end-of-speech latency against false endpoints.
export const defaultVadRedemptionMs = 700;
export const vadRedemptionMsMin = 300;
export const vadRedemptionMsMax = 2_000;
export const vadRedemptionMsStep = 100;

export function clampVadRedemptionMs(value: number): number {
  if (!Number.isFinite(value)) return defaultVadRedemptionMs;
  const stepped = Math.round(value / vadRedemptionMsStep) * vadRedemptionMsStep;
  return Math.min(vadRedemptionMsMax, Math.max(vadRedemptionMsMin, stepped));
}

/** Detector options for a given end-of-speech redemption window (Silero and the energy fallback share this contract). */
export function vadOptionsFor(redemptionMs: number = defaultVadRedemptionMs) {
  return {
    positiveSpeechThreshold: vadPositiveSpeechThreshold,
    negativeSpeechThreshold: vadNegativeSpeechThreshold,
    minSpeechMs: vadMinSpeechMs,
    preSpeechPadMs: vadPreSpeechPadMs,
    redemptionMs: clampVadRedemptionMs(redemptionMs),
  } as const;
}
