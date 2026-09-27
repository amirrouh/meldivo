/**
 * Where a phrase that was cut off by a barge-in should resume from. See App.tsx's
 * pauseForBargeIn: when the acoustic gate passes, the phrase currently playing is paused in
 * place (SpeechPipeline.hold()) and its text position is estimated from how much of its
 * estimated (or, once known, actual) audio duration had already played. If the interruption
 * turns out not to be meaningful, the reply must not restart the whole phrase, nor pick back
 * up mid-sentence (which would sound broken) - it resumes from the start of whichever
 * sentence the cut fell inside, so it always reads as a complete sentence.
 */

/** A sentence boundary is `.`, `!`, or `?` followed by whitespace; the very start also counts. */
const sentenceBoundary = /[.!?]\s+/g;

/** Every index in `text` where a new sentence begins, always including 0. */
function sentenceStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(sentenceBoundary)) {
    const start = match.index! + match[0].length;
    if (start < text.length) starts.push(start);
  }
  return starts;
}

/** Above this fraction of the phrase, treat it as fully spoken: nothing left worth resuming. */
const finishedFraction = 0.98;

/**
 * Given `fraction` (0-1) of a phrase's estimated audio duration that had already played when
 * it was cut off, returns the phrase's text from the start of the sentence containing that
 * position through to the end of the phrase - the part that must be re-spoken to resume
 * cleanly. An empty string means the phrase had, for practical purposes, already finished:
 * there is nothing left to resume.
 */
export function cutSentence(text: string, fraction: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (!Number.isFinite(fraction) || fraction >= finishedFraction) return "";
  const clamped = Math.max(0, Math.min(1, fraction));
  const position = Math.round(clamped * trimmed.length);
  const starts = sentenceStarts(trimmed);
  let start = starts[0];
  for (const candidate of starts) {
    if (candidate <= position) start = candidate;
    else break;
  }
  return trimmed.slice(start).trim();
}
