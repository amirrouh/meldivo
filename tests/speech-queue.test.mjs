// Covers the SpeechPipeline change that lets phrase N+1's /api/voice/speech request dispatch as
// soon as phrase N's audio has started arriving (its `synthesize` promise resolved), instead of
// waiting for phrase N's whole stream to finish downloading (`prepared.completed`). The hub queues
// the actual TTS backend calls FIFO (see server/src/index.ts), so the browser is free to pre-pay
// the round trip for the next phrase while the previous one is still streaming or playing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechPipeline } from "../web/src/speech-pipeline.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** A PreparedSpeech-shaped stub whose playback and "whole stream downloaded" signal are each
 * controlled independently, like the browser's real streamed player (audio-playback.ts). */
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

function pipelineOf(calls, synths) {
  return new SpeechPipeline(async (text) => {
    calls.push(`generate:${text}`);
    const gate = deferred();
    synths.set(text, gate);
    return gate.promise;
  }, () => {}, (error) => { throw error; });
}

test("the next phrase's request dispatches once audio starts arriving, not once it finishes streaming", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one", "two"]);
  await tick();
  assert.deepEqual(calls, ["generate:one"]);

  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();
  // "two" is dispatched right after "one"'s prepared audio resolved, while "one" is still playing
  // and its stream (`completed`) is deliberately never resolved in this test.
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two"]);

  const two = stub(calls, "two");
  synths.get("two").resolve(two.play);
  await tick();
  // "two" is now buffered, waiting for "one" to finish playing; nothing about "one"'s download
  // finishing was needed to get here.
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two"]);
  assert.equal(pipeline.busy, true);

  one.playGate.resolve();
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two", "play:two"]);
  two.playGate.resolve();
  await tick();
  assert.equal(pipeline.busy, false);
});

test("synthesis buffers at most one phrase ahead of the one currently playing", async () => {
  // Phrases are enqueued one at a time, each after the previous dispatch, so maxMergedSpeechChars
  // coalescing (which only merges text already queued at the moment of dispatch) never kicks in;
  // this isolates the outstanding-request cap from the separate merging behavior.
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();
  // Nothing else is queued yet, so "one" playing does not by itself trigger a second request.
  assert.deepEqual(calls, ["generate:one", "play:one"]);

  pipeline.enqueue(["two"]);
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two"]);

  pipeline.enqueue(["three"]);
  await tick();
  // "one" is playing and "two" is in flight: two outstanding already, so "three" must wait even
  // though it has been queued.
  assert.equal(synths.has("three"), false);

  const two = stub(calls, "two");
  synths.get("two").resolve(two.play);
  await tick();
  // "two" is now buffered (one prepared phrase ahead of "one", which is still playing) and that
  // frees the pipeline to go fetch "three".
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two", "generate:three"]);

  pipeline.enqueue(["four"]);
  await tick();
  // "three" is in flight and "two" is buffered: two outstanding again, so "four" must wait.
  assert.equal(synths.has("four"), false);

  one.playGate.resolve();
  await tick();
  await tick();
  assert.deepEqual(calls.slice(-1), ["play:two"]);
  assert.equal(synths.has("four"), false);

  const three = stub(calls, "three");
  synths.get("three").resolve(three.play);
  await tick();
  await tick();
  assert.deepEqual(calls.slice(-1), ["generate:four"]);
});

test("audio plays strictly in enqueue order", async () => {
  const calls = [];
  const synths = new Map();
  const pipeline = pipelineOf(calls, synths);

  pipeline.enqueue(["one", "two"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();
  const two = stub(calls, "two");
  synths.get("two").resolve(two.play);
  await tick();

  // "two" is fully ready (both its prepared audio and its stream download) well before "one"
  // finishes playing, but it must still not play out of order.
  two.completed.resolve();
  await tick();
  assert.equal(calls.includes("play:two"), false);

  one.playGate.resolve();
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two", "play:two"]);
  two.playGate.resolve();
  await tick();
  assert.equal(pipeline.busy, false);
});

test("cancel aborts every outstanding request and stale audio never plays", async () => {
  const calls = [];
  const signals = [];
  const synths = new Map();
  const pipeline = new SpeechPipeline(async (text, signal) => {
    signals.push(signal);
    calls.push(`generate:${text}`);
    const gate = deferred();
    synths.set(text, gate);
    return gate.promise;
  }, () => {}, () => {});

  pipeline.enqueue(["one"]);
  await tick();
  const one = stub(calls, "one");
  synths.get("one").resolve(one.play);
  await tick();
  pipeline.enqueue(["two"]);
  await tick();
  pipeline.enqueue(["three"]);
  await tick();
  // "one" playing, "two" in flight, "three" still queued text and never requested.
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two"]);
  assert.equal(synths.has("three"), false);

  pipeline.cancel();
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(pipeline.busy, false);

  // The in-flight "two" request resolves after the fact; it must not surface as audio for the
  // cancelled run.
  synths.get("two").resolve(stub(calls, "stale-two").play);
  await tick();
  assert.equal(calls.includes("play:stale-two"), false);

  // A fresh turn behaves normally afterwards.
  pipeline.enqueue(["fresh"]);
  await tick();
  assert.deepEqual(calls.filter((call) => call.includes("fresh")), ["generate:fresh"]);
});
