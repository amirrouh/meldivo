// Loaded into each `pi` process meldivo starts for a voice turn (`pi -e`). The first model
// request of the turn goes out with thinking off, so the spoken answer starts right away; requests
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
  pi.on("turn_end", () => {
    firstTurn = false;
  });
}
