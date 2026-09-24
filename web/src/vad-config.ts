/**
 * Silero v5 evaluates 32 ms frames. Keep these thresholds in one shared
 * module so the detector setup and its testable contract stay aligned.
 */
export const vadPositiveSpeechThreshold = 0.45;
export const vadNegativeSpeechThreshold = 0.30;
export const vadMinSpeechMs = 160; // Five 32 ms Silero v5 frames.
export const vadPreSpeechPadMs = 320;
export const vadRedemptionMs = 1_000;

export const vadOptions = {
  positiveSpeechThreshold: vadPositiveSpeechThreshold,
  negativeSpeechThreshold: vadNegativeSpeechThreshold,
  minSpeechMs: vadMinSpeechMs,
  preSpeechPadMs: vadPreSpeechPadMs,
  redemptionMs: vadRedemptionMs,
} as const;
