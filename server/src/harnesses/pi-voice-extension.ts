// Loaded into each warm `pi` process meldivo keeps for voice turns (`pi -e`). The first model
// request of every turn goes out with thinking off, so the spoken answer starts right away; requests
// after tool calls think as usual. Only self-hosted OpenAI-compatible servers are touched.
import { isSelfHostedUrl, withoutThinking } from "./voice-turn.js";

interface PiModel {
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
}

interface PiExtensionApi {
  on(event: string, handler: (event: { payload?: unknown }, ctx: { model?: PiModel }) => unknown): void;
}

export default function meldivoVoice(pi: PiExtensionApi): void {
  let firstTurn = true;
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx?.model;
    if (!firstTurn || !model?.reasoning || model.api !== "openai-completions" || !isSelfHostedUrl(model.baseUrl)) return undefined;
    return withoutThinking(event.payload);
  });
  // The process outlives a turn, so every new prompt starts with thinking off again.
  pi.on("agent_start", () => {
    firstTurn = true;
  });
  pi.on("turn_end", () => {
    firstTurn = false;
  });
}
