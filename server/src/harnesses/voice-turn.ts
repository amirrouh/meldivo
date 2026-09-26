// Shared by meldivo and by the small hooks it loads into the agents it starts (pi-voice-extension.ts,
// opencode-voice-plugin.ts), so keep this file free of other meldivo imports.

/** Appended to every message meldivo sends, since every reply is read aloud. */
export const VOICE_NOTE =
  "(meldivo voice: this reply will be spoken aloud. Answer in one to three short, plain sentences, " +
  "with no markdown, lists, code, file paths, or links. Before you use any tool, first say in one short " +
  "sentence what you are about to do.)";

export function voicePrompt(message: string): string {
  return `${message}\n\n${VOICE_NOTE}`;
}

export function isVoicePrompt(text: string): boolean {
  return text.includes(VOICE_NOTE);
}

/**
 * True for model servers on this machine or a private network (llama.cpp, vLLM, and the like).
 * Only those get the thinking switch: hosted APIs can reject parameters they don't know.
 */
export function isSelfHostedUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  const ip = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return !host.includes(".") || /\.(local|lan|internal|home\.arpa|ts\.net)$/.test(host);
}

/** The chat-completions request with the model's thinking turned off, or undefined if it isn't one. */
export function withoutThinking(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { messages?: unknown }).messages)) return undefined;
  const body = payload as Record<string, unknown>;
  const kwargs = body.chat_template_kwargs && typeof body.chat_template_kwargs === "object" ? body.chat_template_kwargs : {};
  const next: Record<string, unknown> = { ...body, chat_template_kwargs: { ...kwargs, enable_thinking: false } };
  if ("enable_thinking" in next) next.enable_thinking = false;
  delete next.reasoning_effort;
  delete next.thinking_budget_tokens;
  return next;
}
