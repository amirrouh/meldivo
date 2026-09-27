// Covers the "pause, then resume or interrupt" barge-in: SpeechPipeline.hold()/resume() (which
// pause a reply in place instead of the old silenceOutput()-as-interruption), cutSentence (which
// picks where a paused phrase should resume from), and fetchResumeBridge (the hub's bridge phrase,
// with a timeout and no hardcoded fallback).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechPipeline } from "../web/src/speech-pipeline.ts";
import { cutSentence } from "../web/src/cut-sentence.ts";
import { bridgeSaidChars, bridgeTimeoutMs, fetchResumeBridge, withBridge } from "../web/src/resume-bridge.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** Same PreparedSpeech-shaped stub used by tests/speech-queue.test.mjs. */
function stub(calls, text) {
  const completed = deferred();
  const playGate = deferred();
  const play = async () => {
    calls.push(`play:${text}`);
    await playGate.promise;
  };
  play.completed = completed.promise;
  return { play, completed, playGate };
}

function pipelineOf(calls, synths, reportError = (error) => { throw error; }) {
  return new SpeechPipeline(async (text) => {
    calls.push(`generate:${text}`);
    const gate = deferred();
    synths.set(text, gate);
    return gate.promise;
  }, () => {}, reportError);
}

// --- SpeechPipeline.hold()/resume() -----------------------------------------------------------

test("hold() pauses a playing phrase without treating its abort as a failure", async () => {
  const calls = [];
  const errors = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths, (error) => errors.push(error));

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one"]);

  const held = pipeline.hold();
  await tick();
  assert.equal(held, true);
  assert.equal(errors.length, 0, "aborting the held phrase must not be reported as a playback failure");
  assert.equal(pipeline.busy, true, "busy stays true for as long as the run is held");
});

test("hold() on an idle pipeline is a no-op and reports nothing was held", () => {
  const pipeline = pipelineOf([], new Map());
  assert.equal(pipeline.hold(), false);
  assert.equal(pipeline.busy, false);
});

test("resume() speaks the prefix first, then whatever was already queued, in order", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();

  pipeline.hold();
  // Enqueued while held: text queues up but nothing generates or plays yet.
  pipeline.enqueue(["and then this"]);
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one"]);
  assert.equal(pipeline.busy, true);

  pipeline.resume("sorry, as I was saying, one");
  await tick();
  // The already-queued phrase is short enough that it is folded into the same TTS request as
  // the resumed prefix (the pipeline's normal merging - see maxMergedSpeechChars), but it is
  // still spoken, in order, right after the resumed sentence: nothing behind it was lost.
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:sorry, as I was saying, one and then this"]);

  const resumed = stub(calls, "sorry, as I was saying, one and then this");
  synths.get("sorry, as I was saying, one and then this").resolve(resumed.play);
  await tick();
  resumed.playGate.resolve();
  await tick();
  assert.equal(pipeline.busy, false);
});

test("resume(\"\") with nothing queued simply releases the hold - nothing new is spoken", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();

  pipeline.hold();
  await tick();
  assert.equal(pipeline.busy, true);

  pipeline.resume("");
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one"]);
  assert.equal(pipeline.busy, false, "nothing left to resume: the turn is simply over");
});

test("resume() after cancel() (a real interruption) is a no-op: cancel already replaced the run", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();

  pipeline.hold();
  pipeline.cancel();
  pipeline.resume("should never be spoken");
  await tick();
  assert.equal(calls.some((call) => call.includes("should never be spoken")), false);
  assert.equal(pipeline.busy, false);
});

test("a phrase still buffered (prepared but not yet playing) when held is kept and replayed after resume", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one", "two"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick(); // "one" playing, "two" now dispatched
  const two = stub(calls, "two");
  synths.get("two").resolve(two.play);
  await tick(); // "two" now buffered, waiting for "one" to finish

  pipeline.hold();
  await tick();
  // "two" was never played; it must not be lost, just re-synthesized on resume.
  pipeline.resume("");
  await tick();
  assert.deepEqual(calls.slice(-1), ["generate:two"]);
});

// --- cutSentence --------------------------------------------------------------------------------

test("cutSentence at fraction 0 returns the whole phrase: nothing had played yet", () => {
  assert.equal(cutSentence("Hello there. How can I help today?", 0), "Hello there. How can I help today?");
});

test("cutSentence past the end of the phrase returns nothing left to resume", () => {
  assert.equal(cutSentence("Hello there. How can I help today?", 1), "");
  assert.equal(cutSentence("Hello there.", 0.99), "");
});

test("cutSentence picks the start of the sentence containing the estimated position", () => {
  const text = "First sentence here. Second sentence follows. Third one wraps up.";
  // Position ~55/67 chars lands inside "Third one wraps up.".
  const resume = cutSentence(text, 0.8);
  assert.equal(resume, "Third one wraps up.");
});

test("cutSentence never resumes mid-sentence: a position inside a sentence rewinds to its start", () => {
  const text = "This is one long sentence that keeps going for a good while before it ends.";
  const resume = cutSentence(text, 0.5);
  assert.equal(resume, text, "a single-sentence phrase always resumes from its own start");
});

test("cutSentence tolerates empty or blank text", () => {
  assert.equal(cutSentence("", 0.5), "");
  assert.equal(cutSentence("   ", 0.5), "");
});

test("cutSentence clamps an out-of-range or non-finite fraction instead of throwing", () => {
  const text = "One. Two. Three.";
  assert.equal(cutSentence(text, -5), text);
  assert.equal(cutSentence(text, Number.NaN), "");
  assert.equal(cutSentence(text, Infinity), "");
});

// --- fetchResumeBridge / withBridge ---------------------------------------------------------------

test("fetchResumeBridge returns the hub's bridge phrase on success", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ bridge: "sorry, as I was saying," }) };
  };
  const bridge = await fetchResumeBridge("earlier context", "the cut sentence.", { "X-Meldivo-Token": "t" }, fetchImpl);
  assert.equal(bridge, "sorry, as I was saying,");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/voice/bridge");
  assert.deepEqual(calls[0].body, { said: "earlier context", resume: "the cut sentence." });
});

test("fetchResumeBridge only sends the last bridgeSaidChars characters of what was said", async () => {
  const said = "x".repeat(bridgeSaidChars + 50);
  let sentSaid;
  const fetchImpl = async (_url, init) => {
    sentSaid = JSON.parse(init.body).said;
    return { ok: true, json: async () => ({ bridge: "" }) };
  };
  await fetchResumeBridge(said, "resume this.", {}, fetchImpl);
  assert.equal(sentSaid.length, bridgeSaidChars);
  assert.equal(sentSaid, said.slice(-bridgeSaidChars));
});

test("fetchResumeBridge never hardcodes a phrase: a non-ok response resumes with no bridge", async () => {
  const fetchImpl = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await fetchResumeBridge("said", "resume.", {}, fetchImpl), "");
});

test("fetchResumeBridge treats an empty bridge field and a malformed body the same way: no bridge", async () => {
  const empty = async () => ({ ok: true, json: async () => ({ bridge: "" }) });
  assert.equal(await fetchResumeBridge("said", "resume.", {}, empty), "");
  const malformed = async () => ({ ok: true, json: async () => { throw new Error("bad json"); } });
  assert.equal(await fetchResumeBridge("said", "resume.", {}, malformed), "");
});

test("fetchResumeBridge gives up once the request runs past its timeout", async () => {
  const fetchImpl = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  });
  const bridge = await fetchResumeBridge("said", "resume.", {}, fetchImpl);
  assert.equal(bridge, "");
  assert.ok(bridgeTimeoutMs > 0 && bridgeTimeoutMs <= 2_000);
});

test("fetchResumeBridge skips the request entirely when there is nothing to resume", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ bridge: "" }) }; };
  assert.equal(await fetchResumeBridge("said", "", {}, fetchImpl), "");
  assert.equal(called, false);
});

test("withBridge joins a bridge and the resumed sentence with a single space, and skips a blank bridge", () => {
  assert.equal(withBridge("sorry, as I was saying,", "the rest of it."), "sorry, as I was saying, the rest of it.");
  assert.equal(withBridge("", "the rest of it."), "the rest of it.");
  assert.equal(withBridge("   ", "the rest of it."), "the rest of it.");
});
