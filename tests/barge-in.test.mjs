import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acousticGateFrames,
  BargeInGuard,
  classifySpeech,
  estimatePhraseSeconds,
  findDeliberateCue,
  hasDeliberateCue,
  isBelowEchoFloor,
  isMeaningfulSpeech,
  previewFreshnessMs,
  recentPlaybackWindow,
  recordPlayedPhrase,
} from "../web/src/barge-in-guard.ts";
import { fastSpeculationFrames, LiveTranscription } from "../web/src/live-transcription.ts";

const frame = () => new Float32Array(512);
const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- Position-aware echo classification (fix 2) ---------------------------------------

test("a transcript that lines up in order with recent playback is echo, not meaningful speech", () => {
  const recent = "the weather in paris today is sunny with a light breeze from the west";
  assert.deepEqual(classifySpeech("weather in Paris today", recent), { echo: true, meaningful: false });
});

test("one misheard word in an otherwise-aligned run is still tolerated as echo", () => {
  const recent = "a light breeze from the west this afternoon";
  // "waste" instead of "west": one substitution in six words, within the ~1-per-4 budget.
  assert.deepEqual(classifySpeech("a light breeze from the waste", recent), { echo: true, meaningful: false });
});

test("words that merely overlap with recent playback, out of order, are not echo", () => {
  const recent = "the weather in paris today is sunny with a light breeze from the west";
  // Old bag-of-words matching would have called this echo (every word appears in `recent`);
  // position-aware matching requires an ordered run, so this reads as real speech.
  assert.deepEqual(classifySpeech("west breeze sunny paris", recent), { echo: false, meaningful: true });
});

test("an aligned prefix followed by a real question is not echo: too much lies outside the run", () => {
  const recent = "the first option is faster and uses less memory";
  const result = classifySpeech("the first option is faster, what about the second one", recent);
  assert.equal(result.echo, false);
  assert.equal(result.meaningful, true);
});

test("an aligned run that covers nearly the whole transcript is echo even with a couple of stray words", () => {
  const recent = "the first option is faster and uses less memory";
  // Only "is faster" is outside the aligned run "the first option" - one real word, under the threshold.
  const result = classifySpeech("the first option", recent);
  assert.deepEqual(result, { echo: true, meaningful: false });
});

test("classifySpeech with no recent playback falls back to counting real words", () => {
  assert.deepEqual(classifySpeech("um", ""), { echo: false, meaningful: false });
  assert.deepEqual(classifySpeech("wait, stop", ""), { echo: false, meaningful: true });
});

test("isMeaningfulSpeech is classifySpeech's meaningful flag", () => {
  const recent = "sure, the weather in paris today is sunny";
  assert.equal(isMeaningfulSpeech("weather in paris", recent), false);
  assert.equal(isMeaningfulSpeech("wait, what about london", recent), true);
});

// --- Deliberate stop cues (fix 3) -------------------------------------------------------

test("a stop cue not present in recent playback interrupts regardless of length", () => {
  assert.equal(hasDeliberateCue("wait", ""), true);
  assert.equal(hasDeliberateCue("hold on a second", ""), true);
  assert.equal(hasDeliberateCue("please shut up now", ""), true);
  assert.equal(hasDeliberateCue("nothing to see here", ""), false);
});

test("a cue word the assistant just said itself is not a deliberate interruption", () => {
  // The reply says "please wait a moment"; hearing "wait" back is plausibly an echo of that.
  assert.equal(hasDeliberateCue("wait", "please wait a moment"), false);
  // But a different cue word not in the reply still counts.
  assert.equal(hasDeliberateCue("stop, wait", "please wait a moment"), true);
});

test("findDeliberateCue strips the cue phrase and reports whether anything real remains", () => {
  assert.deepEqual(findDeliberateCue("stop", ""), { remainder: "" });
  assert.deepEqual(findDeliberateCue("wait wait", ""), { remainder: "" });
  assert.deepEqual(findDeliberateCue("hold on, what time is it", ""), { remainder: "what time is it" });
  assert.equal(findDeliberateCue("tell me about Paris", ""), null);
});

// --- Played-phrase ring and recent playback window (fix 2) -----------------------------

test("estimatePhraseSeconds is roughly proportional to length and never zero", () => {
  assert.equal(estimatePhraseSeconds(""), 0.2);
  assert.ok(estimatePhraseSeconds("a".repeat(150)) > 9);
});

test("recentPlaybackWindow only includes phrases overlapping the lookback/pad interval", () => {
  const ring = [
    { text: "long ago", startedAt: 0, seconds: 0.5 },
    { text: "just before", startedAt: 9_000, seconds: 1 },
    { text: "during", startedAt: 9_800, seconds: 1 },
  ];
  // Speech starts at 10_000ms: the 1.5s lookback reaches back to 8_500ms.
  const text = recentPlaybackWindow(ring, 10_000, 10_000);
  assert.equal(text.includes("long ago"), false);
  assert.equal(text.includes("just before"), true);
  assert.equal(text.includes("during"), true);
});

test("recordPlayedPhrase appends and drops phrases too old to ever matter again", () => {
  let ring = [];
  ring = recordPlayedPhrase(ring, "first phrase", 0);
  ring = recordPlayedPhrase(ring, "second phrase", 500);
  ring = recordPlayedPhrase(ring, "much later phrase", 50_000);
  assert.equal(ring.some((phrase) => phrase.text === "first phrase"), false);
  assert.equal(ring.some((phrase) => phrase.text === "second phrase"), false);
  assert.equal(ring.some((phrase) => phrase.text === "much later phrase"), true);
});

// --- Acoustic gate (fix 5) ---------------------------------------------------------------

test("isBelowEchoFloor never gates when no floor has been learned yet", () => {
  assert.equal(isBelowEchoFloor(0.001, null), false);
});

test("isBelowEchoFloor gates a candidate too close to the known echo floor", () => {
  assert.equal(isBelowEchoFloor(0.01, 0.01), true); // 1x the floor, well under the 2.5x bar
  assert.equal(isBelowEchoFloor(0.03, 0.01), false); // 3x the floor clears it
  assert.equal(acousticGateFrames, 8);
});

// --- BargeInGuard.speechEnd: never silently drop on a stale/empty preview (fix 1) ------

test("a stale or empty preview at speech end defers to the final transcript instead of dropping", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  // No preview arrived yet (freshPreview: false): must still be sent for transcription.
  const decision = guard.speechEnd("", "", false);
  assert.deepEqual(decision, { accepted: true, interrupt: false, send: true, deferDecision: true, wordPathBlocked: false });
});

test("a fresh preview that is clearly not meaningful is still dropped immediately", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  const decision = guard.speechEnd("um", "", true);
  assert.deepEqual(decision, { accepted: true, interrupt: false, send: false, deferDecision: false, wordPathBlocked: false });
});

test("a fresh preview with a deliberate cue interrupts even though it is short", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  const decision = guard.speechEnd("stop", "", true);
  assert.deepEqual(decision, { accepted: true, interrupt: true, send: true, deferDecision: false, wordPathBlocked: false });
});

test("the acoustic gate blocks the word path but a cue still gets through", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  guard.blockWordPath();
  assert.equal(guard.shouldInterruptNow("what about london today", ""), false); // word path gated
  assert.equal(guard.shouldInterruptNow("stop", ""), true); // cue bypasses the gate
});

test("a gated candidate never interrupts via ordinary words even at speech end", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  guard.blockWordPath();
  const decision = guard.speechEnd("what about london today", "", true);
  assert.deepEqual(decision, { accepted: true, interrupt: false, send: false, deferDecision: false, wordPathBlocked: true });
});

test("BargeInGuard.idle reflects whether a candidate is currently open", () => {
  const guard = new BargeInGuard();
  assert.equal(guard.idle, true);
  guard.speechStart(true);
  assert.equal(guard.idle, false);
  guard.speechEnd("hello there", "", true);
  assert.equal(guard.idle, true);
});

test("previewFreshnessMs is a sane, small window relative to expected STT latency", () => {
  assert.ok(previewFreshnessMs >= 400 && previewFreshnessMs <= 1_000);
});

// --- LiveTranscription: faster first speculation over an active turn (fix 4) -----------

test("a segment that begins over an active turn speculates well before the normal schedule", async () => {
  const requests = [];
  const live = new LiveTranscription(async (samples) => {
    requests.push(samples.length);
    return "hello";
  }, () => {});
  live.begin(true);
  live.confirm();
  for (let index = 0; index < fastSpeculationFrames - 1; index++) live.frame(0.9, frame());
  assert.equal(requests.length, 0); // not yet due
  live.frame(0.9, frame());
  await tick();
  assert.equal(requests.length, 1); // due right at fastSpeculationFrames after confirm
});

test("a segment that begins with no active turn waits for the normal quiet/timeout schedule", async () => {
  const requests = [];
  const live = new LiveTranscription(async () => { requests.push(1); return "hello"; }, () => {});
  live.begin(false);
  live.confirm();
  for (let index = 0; index < fastSpeculationFrames + 5; index++) live.frame(0.9, frame());
  await tick();
  assert.equal(requests.length, 0); // far short of the 63-frame / 6-quiet-frame schedule
});

test("begin() defaults to not-over-an-active-turn when the flag is omitted", async () => {
  const requests = [];
  const live = new LiveTranscription(async () => { requests.push(1); return "hello"; }, () => {});
  live.begin();
  live.confirm();
  for (let index = 0; index < fastSpeculationFrames + 5; index++) live.frame(0.9, frame());
  await tick();
  assert.equal(requests.length, 0);
});
