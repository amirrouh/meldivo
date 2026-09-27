import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { cleanBridge, findBridgeModel } from "../server/src/bridge.ts";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function piHome(provider) {
  const home = mkdtempSync(path.join(tmpdir(), "bridge-home-"));
  dirs.push(home);
  const agent = path.join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "box", defaultModel: "m1" }));
  writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { box: provider } }));
  return home;
}

test("a bridge is a few plain words ending in a comma, never dangling", () => {
  assert.equal(cleanBridge("As I was saying"), "As I was saying,");
  assert.equal(cleanBridge("\"Anyway, where was I?\""), "Anyway, where was I,");
  assert.equal(cleanBridge("Now, regarding the"), "Now,");
  assert.equal(cleanBridge("So, moving on to"), "So, moving on,");
  assert.equal(cleanBridge("<think>hmm</think>Right"), "Right,");
  assert.equal(cleanBridge("one two three four five six seven eight nine"), "");
  assert.equal(cleanBridge("..."), "");
});

test("the bridge model is pi's default, and only when it runs on a private network", () => {
  const local = findBridgeModel(piHome({ baseUrl: "http://127.0.0.1:8000/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m1" }] }));
  assert.deepEqual(local, { url: "http://127.0.0.1:8000/v1/chat/completions", model: "m1", apiKey: "k" });
  assert.equal(findBridgeModel(piHome({ baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [{ id: "m1" }] })), undefined);
  assert.equal(findBridgeModel(path.join(tmpdir(), "no-such-home")), undefined);
});
