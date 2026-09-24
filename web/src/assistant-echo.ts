type Word = {
  value: string;
  start: number;
};

function words(text: string): Word[] {
  return [...text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)]
    .map((match) => ({ value: match[0], start: match.index ?? 0 }));
}

function containsSequence(haystack: string[], needle: string[]) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

/**
 * Remove only a leading transcript fragment that is known to have come from
 * the active assistant reply. The caller invokes this exclusively for speech
 * that began while assistant output was active, keeping ordinary turns intact.
 */
export function removeAssistantEcho(transcript: string, assistant: string) {
  const trimmed = transcript.trim();
  const heard = words(trimmed);
  const spoken = words(assistant).map(({ value }) => value);
  const heardValues = heard.map(({ value }) => value);
  const observedIncompleteEcho = heardValues.join(" ") === "it seems like";
  if (observedIncompleteEcho && containsSequence(spoken, heardValues)) return "";
  if (heard.length < 5 || spoken.length < 5) return trimmed;

  if (containsSequence(spoken, heardValues)) return "";

  // Acoustic echo normally precedes the user's interruption. Strip an exact
  // assistant prefix, but retain the user's remaining request verbatim.
  for (let length = heard.length - 1; length >= 5; length--) {
    if (containsSequence(spoken, heardValues.slice(0, length))) {
      return trimmed.slice(heard[length].start).replace(/^[\s,.;:!?—-]+/u, "").trim();
    }
  }
  return trimmed;
}
