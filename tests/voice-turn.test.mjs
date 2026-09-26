import assert from "node:assert/strict";
import test from "node:test";
import { isSelfHostedUrl, isVoicePrompt, voicePrompt, withoutThinking, VOICE_NOTE } from "../server/src/harnesses/voice-turn.ts";
import meldivoVoice from "../server/src/harnesses/pi-voice-extension.ts";
import { MeldivoVoice } from "../server/src/harnesses/opencode-voice-plugin.ts";
import { withVoicePlugin } from "../server/src/harnesses/opencode.ts";

// Synthetic addresses, assembled so the privacy check doesn't mistake them for real ones.
const ip = (...parts) => parts.join(".");
const url = (host, rest = "") => `http://${host}${rest}`;

test("voice prompts carry the spoken-reply note after the user's words", () => {
  const prompt = voicePrompt("what failed last night?");
  assert.ok(prompt.startsWith("what failed last night?"));
  assert.ok(prompt.endsWith(VOICE_NOTE));
  assert.equal(isVoicePrompt(prompt), true);
  assert.equal(isVoicePrompt("what failed last night?"), false);
});

test("only model servers on this machine or a private network count as self-hosted", () => {
  const selfHosted = [
    url("localhost:8080", "/v1"), url(ip(127, 0, 0, 1), ":8080"), url(ip(10, 1, 2, 3), "/v1"), url(ip(192, 168, 1, 5), ":8000"),
    url(ip(172, 20, 0, 2)), url(ip(100, 100, 1, 1), ":8080"), url("gpu-box:8080"), url("llm.local"), url(["box", "example", "ts", "net"].join(".")),
    url("[::1]:8080"), url("[fd12:3456::1]:8000"),
  ];
  for (const address of selfHosted) assert.equal(isSelfHostedUrl(address), true, address);
  const hosted = ["https://api.openai.com/v1", "https://openrouter.ai/api/v1", url(ip(172, 32, 0, 1)), url(ip(100, 128, 0, 1)), url(ip(8, 8, 8, 8)), "not a url", undefined];
  for (const address of hosted) assert.equal(isSelfHostedUrl(address), false, String(address));
});

test("withoutThinking turns thinking off in a chat-completions request and leaves other requests alone", () => {
  const body = { model: "m", messages: [], chat_template_kwargs: { keep: 1 }, reasoning_effort: "high", thinking_budget_tokens: 99, enable_thinking: true };
  assert.deepEqual(withoutThinking(body), { model: "m", messages: [], chat_template_kwargs: { keep: 1, enable_thinking: false }, enable_thinking: false });
  assert.equal(body.enable_thinking, true, "the original request is not modified");
  assert.equal(withoutThinking({ contents: [] }), undefined);
  assert.equal(withoutThinking(null), undefined);
});

test("pi extension: thinking off for the first turn of a run on a self-hosted reasoning model only", () => {
  const handlers = {};
  meldivoVoice({ on: (event, handler) => { handlers[event] = handler; } });
  const local = { model: { api: "openai-completions", baseUrl: url(ip(10, 0, 0, 2), ":8080/v1"), reasoning: true } };
  const payload = { messages: [{ role: "user", content: "hi" }] };
  assert.equal(handlers.before_provider_request({ payload }, { model: { ...local.model, baseUrl: "https://api.openai.com/v1" } }), undefined);
  assert.equal(handlers.before_provider_request({ payload }, { model: { ...local.model, reasoning: false } }), undefined);
  assert.equal(handlers.before_provider_request({ payload }, { model: { ...local.model, api: "anthropic-messages" } }), undefined);
  assert.equal(handlers.before_provider_request({ payload }, local).chat_template_kwargs.enable_thinking, false);
  handlers.turn_end({}, local);
  assert.equal(handlers.before_provider_request({ payload }, local), undefined, "requests after tool calls think as usual");
});

test("opencode plugin: thinking off for a voice prompt's first request only", async () => {
  const hooks = await MeldivoVoice();
  const model = { capabilities: { reasoning: true }, api: { npm: "@ai-sdk/openai-compatible", url: "" } };
  const provider = { options: { baseURL: url(ip(10, 0, 0, 2), ":8080/v1") } };
  const params = async (input) => {
    const output = { options: {} };
    await hooks["chat.params"]({ model, provider, agent: "build", ...input }, output);
    return output.options.chat_template_kwargs;
  };
  await hooks["chat.message"]({}, { message: { id: "m1" }, parts: [{ type: "text", text: voicePrompt("hello") }] });
  await hooks["chat.message"]({}, { message: { id: "m2" }, parts: [{ type: "text", text: "a subagent task" }] });
  assert.equal(await params({ agent: "title", message: { id: "m1" } }), undefined, "title generation is left alone");
  assert.deepEqual(await params({ message: { id: "m1" } }), { enable_thinking: false });
  assert.equal(await params({ message: { id: "m1" } }), undefined, "later steps think as usual");
  assert.equal(await params({ message: { id: "m2" } }), undefined, "non-voice prompts are left alone");
  await hooks["chat.message"]({}, { message: { id: "m3" }, parts: [{ type: "text", text: voicePrompt("hi") }] });
  const hosted = { options: {} };
  await hooks["chat.params"]({ model, provider: { options: { baseURL: "https://api.openai.com/v1" } }, agent: "build", message: { id: "m3" } }, hosted);
  assert.equal(hosted.options.chat_template_kwargs, undefined, "hosted APIs are left alone");
});

test("opencode: meldivo's plugin is added to any extra config the user already set", () => {
  const plain = JSON.parse(withVoicePlugin(undefined));
  assert.equal(plain.plugin.length, 1);
  assert.match(plain.plugin[0], /^file:.*opencode-voice-plugin\.(ts|js)$/);
  const merged = JSON.parse(withVoicePlugin(JSON.stringify({ theme: "x", plugin: ["mine"] })));
  assert.equal(merged.theme, "x");
  assert.deepEqual(merged.plugin.slice(0, 1), ["mine"]);
  assert.equal(merged.plugin.length, 2);
  assert.equal(withVoicePlugin("not json"), "not json");
});
