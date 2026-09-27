/**
 * Early end-of-utterance on a finished-sounding speculative transcript. The
 * detector's redemption window (700 ms by default) is the safe fallback; when
 * Whisper already heard a complete sentence covering every spoken frame, a
 * short pause is enough to send it.
 */

/** Quiet 32 ms frames required before a finished sentence ends the utterance (about 320 ms). */
export const earlyEndpointQuietFrames = 10;
export const earlyEndpointMinWords = 2;

export type EndpointCandidate = {
  /** The latest speculative transcript, if any. */
  text?: string;
  /** Speech revision the transcript was requested for. */
  resultRevision?: number;
  /** Current speech revision of the segment; newer speech invalidates the transcript. */
  revision: number;
  /** Consecutive frames below the speech threshold since the last speech frame. */
  quietFrames: number;
};

/** True when the text reads as a finished sentence: `?`, `.` or `!` after closing quotes/brackets, but not a trailing-off ellipsis. */
export function endsSentence(text: string): boolean {
  const trimmed = text.trim().replace(/["'“”‘’«»)\]}]+$/u, "").trimEnd();
  if (!/[.?!]$/.test(trimmed)) return false;
  return !/(\.\.|…)$/.test(trimmed);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export function shouldEndpointEarly(candidate: EndpointCandidate): boolean {
  const { text, resultRevision, revision, quietFrames } = candidate;
  if (text === undefined || resultRevision !== revision) return false;
  if (quietFrames < earlyEndpointQuietFrames) return false;
  return endsSentence(text) && wordCount(text) >= earlyEndpointMinWords;
}
