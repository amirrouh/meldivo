import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isSelfHostedUrl } from "./harnesses/voice-turn.js";

// A short spoken bridge ("as I was saying") for when a reply resumes after the user started to
// interrupt and then didn't. Written by the user's own model, off the record: a one-off request
// that is never added to any session. Only self-hosted models are asked; otherwise there is no bridge.

const BRIDGE_TIMEOUT_MS = 1_500;
const MAX_BRIDGE_WORDS = 8;
const DANGLING = new Set(["the", "a", "an", "to", "of", "regarding", "about", "for", "with", "and", "that", "is", "was"]);

interface BridgeModel {
  url: string;
  model: string;
  apiKey?: string;
}

/** The default model pi is set up with, if it is an OpenAI-compatible server on a private network. */
export function findBridgeModel(home = homedir()): BridgeModel | undefined {
  try {
    const dir = path.join(home, ".pi", "agent");
    const settings = JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
    const models = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8")) as {
      providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; models?: { id?: string }[] }>;
    };
    const provider = settings.defaultProvider ? models.providers?.[settings.defaultProvider] : undefined;
    const model = settings.defaultModel ?? provider?.models?.[0]?.id;
    if (!provider || !model || provider.api !== "openai-completions" || !isSelfHostedUrl(provider.baseUrl)) return undefined;
    // Keys given as environment variable references aren't resolved here; such servers get no key.
    const apiKey = typeof provider.apiKey === "string" && !/^[$!]|^env:/.test(provider.apiKey) ? provider.apiKey : undefined;
    return { url: `${provider.baseUrl!.replace(/\/+$/, "")}/chat/completions`, model, apiKey };
  } catch {
    return undefined;
  }
}

/** Keeps a model's answer to a few plain spoken words that lead into the resumed sentence. */
export function cleanBridge(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0] ?? "";
  const words = line.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_BRIDGE_WORDS) return "";
  // A bridge that ends on "the" or "regarding" would dangle before the repeated sentence.
  while (words.length && DANGLING.has(words[words.length - 1]!.toLowerCase().replace(/[^\p{L}']/gu, ""))) words.pop();
  const text = words.join(" ").replace(/[,.!?;:…]+$/u, "");
  return /[\p{L}]/u.test(text) ? `${text},` : "";
}

export async function writeBridge(said: string, resume: string, signal: AbortSignal, model = findBridgeModel()): Promise<string> {
  if (!model) return "";
  const timeout = AbortSignal.timeout(BRIDGE_TIMEOUT_MS);
  const response = await fetch(model.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
    body: JSON.stringify({
      model: model.model,
      max_tokens: 16,
      temperature: 0.9,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            "You write the few words a speaker says to pick up again after being briefly interrupted, " +
            "such as \"as I was saying\" or \"anyway, where was I\". Vary the wording, match the tone of the " +
            "conversation, and lead naturally into the sentence they will repeat. Never use words from that " +
            "sentence: it follows in full right after. Reply with only those words, at most six, no quotes.",
        },
        { role: "user", content: `Said just before:\n${said}\n\nSentence they will now repeat:\n${resume}` },
      ],
    }),
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) return "";
  const body = await response.json() as { choices?: { message?: { content?: string } }[] };
  return cleanBridge(body.choices?.[0]?.message?.content ?? "");
}
