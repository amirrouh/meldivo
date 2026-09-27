/**
 * A short spoken bridge ("sorry, as I was saying,") to say before resuming a sentence that was
 * paused by a barge-in that turned out not to be meaningful. Always asked of the hub - never
 * hardcoded here - so it can fit what was actually being said; on any failure, timeout, or an
 * empty reply, the caller just resumes with the cut sentence on its own, with no bridge at all.
 */

/** How long to wait for the hub before giving up and resuming with no bridge. */
export const bridgeTimeoutMs = 1_500;

/** Only the last this many characters of what was said before the cut are sent, for context. */
export const bridgeSaidChars = 400;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export async function fetchResumeBridge(
  said: string,
  resume: string,
  authHeaders: Record<string, string>,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  if (!resume.trim()) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bridgeTimeoutMs);
  try {
    const response = await fetchImpl("/api/voice/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify({ said: said.slice(-bridgeSaidChars), resume }),
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const result = await response.json().catch(() => ({}));
    return typeof result?.bridge === "string" ? result.bridge : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** The first resumed phrase: the bridge (if any) followed by the sentence that was cut off. */
export function withBridge(bridge: string, resumeText: string): string {
  const trimmedBridge = bridge.trim();
  return trimmedBridge ? `${trimmedBridge} ${resumeText}` : resumeText;
}
