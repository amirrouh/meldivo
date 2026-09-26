// Loaded into the `opencode serve` process meldivo starts (never into your own OpenCode). For a
// voice turn, the first model request goes out with thinking off, so the spoken answer starts right
// away; requests after tool calls, subagents, and title generation think as usual. Only self-hosted
// OpenAI-compatible servers are touched.
import { isSelfHostedUrl, isVoicePrompt } from "./voice-turn.js";

interface ChatMessageOutput {
  message?: { id?: string };
  parts?: Array<{ type?: string; text?: string }>;
}

interface ChatParamsInput {
  agent?: string;
  message?: { id?: string };
  model?: { capabilities?: { reasoning?: boolean }; api?: { npm?: string; url?: string } };
  provider?: { options?: { baseURL?: unknown } };
}

export const MeldivoVoice = async () => {
  // Voice prompts whose first model request hasn't gone out yet.
  const pending = new Set<string>();
  return {
    "chat.message": async (_input: unknown, output: ChatMessageOutput) => {
      const id = output.message?.id;
      if (id && output.parts?.some((part) => part.type === "text" && typeof part.text === "string" && isVoicePrompt(part.text))) {
        pending.add(id);
        if (pending.size > 100) pending.delete(pending.values().next().value!);
      }
    },
    "chat.params": async (input: ChatParamsInput, output: { options: Record<string, unknown> }) => {
      const id = input.message?.id;
      if (input.agent === "title" || !id || !pending.delete(id)) return;
      const model = input.model;
      if (!model?.capabilities?.reasoning || model.api?.npm !== "@ai-sdk/openai-compatible") return;
      if (!isSelfHostedUrl(input.provider?.options?.baseURL ?? model.api?.url)) return;
      const kwargs = output.options.chat_template_kwargs;
      output.options.chat_template_kwargs = { ...(kwargs && typeof kwargs === "object" ? kwargs : {}), enable_thinking: false };
    },
  };
};
