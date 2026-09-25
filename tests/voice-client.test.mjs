import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveTranscription } from "../web/src/live-transcription.ts";
import {
  isCurrentVoiceSession,
  SerializedVadTransitions,
  VoiceInputCoordinator,
} from "../web/src/input-coordinator.ts";
import { removeAssistantEcho } from "../web/src/assistant-echo.ts";
import { BargeInGuard } from "../web/src/barge-in-guard.ts";
import { SpeechPipeline } from "../web/src/speech-pipeline.ts";
import {
  vadMinSpeechMs,
  vadNegativeSpeechThreshold,
  vadOptions,
  vadPositiveSpeechThreshold,
} from "../web/src/vad-config.ts";
import { consumeSpeechChunks, hasActiveVoiceTurn } from "../web/src/voice.ts";
import {
  clearVoicePreference,
  readVoicePreference,
  voicePreferenceKey,
  writeVoicePreference,
} from "../web/src/voice-preference.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const frame = () => new Float32Array(512);

test("voice preference safely persists only provider voice IDs", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(writeVoicePreference("bf_emma", storage), true);
  assert.equal(values.get(voicePreferenceKey), "bf_emma");
  assert.equal(readVoicePreference(storage), "bf_emma");
  assert.equal(writeVoicePreference("../bad voice", storage), false);
  assert.equal(readVoicePreference(storage), "bf_emma");
  clearVoicePreference(storage);
  assert.equal(readVoicePreference(storage), undefined);
});

test("voice preference tolerates unavailable browser storage", () => {
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readVoicePreference(storage), undefined);
  assert.equal(writeVoicePreference("bf_emma", storage), false);
  assert.doesNotThrow(() => clearVoicePreference(storage));
});

test("VAD barge-in settings confirm five v5 frames without losing the echo guard", () => {
  assert.equal(vadPositiveSpeechThreshold, 0.45);
  assert.equal(vadNegativeSpeechThreshold, 0.30);
  assert.equal(vadMinSpeechMs, 160);
  assert.deepEqual(vadOptions, {
    positiveSpeechThreshold: 0.45,
    negativeSpeechThreshold: 0.30,
    minSpeechMs: 160,
    preSpeechPadMs: 320,
    redemptionMs: 1_000,
  });
});

test("speculative STT reuses a hypothesis that covers the final speech", async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => { calls++; return "Ready to send."; }, () => {});
  live.frame(0.9, frame());
  live.begin();
  live.confirm();
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  const samples = frame();
  live.end(samples);
  assert.equal(await live.finish(samples, new AbortController().signal), "Ready to send.");
  assert.equal(calls, 1);
});

test("resumed speech invalidates a speculative transcript", async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => ++calls === 1 ? "Old partial." : "Whole thought.", () => {});
  live.begin();
  live.confirm();
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  live.frame(0.9, frame());
  const samples = frame();
  live.end(samples);
  assert.equal(await live.finish(samples, new AbortController().signal), "Whole thought.");
  assert.equal(calls, 2);
});

test("a never-settling speculative STT request yields to final STT", async () => {
  let calls = 0;
  const never = new Promise(() => {});
  const live = new LiveTranscription(async () => {
    calls++;
    return calls === 1 ? never : "Authoritative final transcript.";
  }, () => {});
  live.begin();
  live.confirm();
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  const samples = frame();
  live.end(samples);
  assert.equal(await live.finish(samples, new AbortController().signal), "Authoritative final transcript.");
  assert.equal(calls, 2);
});

test("input coordinator retains a completed transcript while speech resumes", async () => {
  const first = deferred();
  const sent = [];
  const coordinator = new VoiceInputCoordinator(async ({ samples }) => {
    if (samples[0] === 1) return first.promise;
    return "second thought";
  }, async (text) => { sent.push(text); });
  const one = frame();
  one[0] = 1;
  const two = frame();
  two[0] = 2;

  coordinator.speechStarted();
  coordinator.speechEnded({ samples: one });
  await tick();
  coordinator.speechStarted();
  first.resolve("first thought");
  await tick();
  assert.deepEqual(sent, []);

  coordinator.speechEnded({ samples: two });
  await tick();
  await tick();
  assert.deepEqual(sent, ["first thought second thought"]);
  assert.equal(coordinator.busy, false);
});

test("input coordinator recovers from empty and failed transcriptions", async () => {
  const reports = [];
  const sent = [];
  let calls = 0;
  const coordinator = new VoiceInputCoordinator(async () => {
    calls++;
    if (calls === 1) return "  ";
    if (calls === 2) throw new Error("stt unavailable");
    return "recovered";
  }, async (text) => { sent.push(text); }, (error) => reports.push(error.message));

  coordinator.speechEnded({ samples: frame() });
  await tick();
  await tick();
  assert.equal(coordinator.busy, false);
  coordinator.speechEnded({ samples: frame() });
  coordinator.speechEnded({ samples: frame() });
  await tick();
  await tick();
  await tick();
  assert.deepEqual(reports, ["stt unavailable"]);
  assert.deepEqual(sent, ["recovered"]);
  assert.equal(coordinator.busy, false);
});

test("serialized VAD transitions do not interleave pause and start", async () => {
  const gate = deferred();
  const calls = [];
  const vad = {
    pause: async () => { calls.push("pause:start"); await gate.promise; calls.push("pause:end"); },
    start: async () => { calls.push("start"); },
  };
  const transitions = new SerializedVadTransitions();
  const pause = transitions.pause(vad);
  const start = transitions.start(vad);
  await tick();
  assert.deepEqual(calls, ["pause:start"]);
  gate.resolve();
  await Promise.all([pause, start]);
  assert.deepEqual(calls, ["pause:start", "pause:end", "start"]);
  assert.equal(transitions.acceptsCallbacks, true);
});

test("a stalled VAD operation invalidates its detector and skips queued recovery", async () => {
  const calls = [];
  const vad = {
    pause: async () => { calls.push("pause"); await new Promise(() => {}); },
    start: async () => { calls.push("start"); },
  };
  const transitions = new SerializedVadTransitions(5);
  const pause = transitions.pause(vad);
  const start = transitions.start(vad);
  await assert.rejects(pause, /VAD pause timed out/);
  await start;
  assert.deepEqual(calls, ["pause"]);
  assert.equal(transitions.acceptsCallbacks, false);
  assert.equal(transitions.isInvalid(vad), true);
  await assert.rejects(transitions.start(vad), /invalidated/);
});

test("a late old pause cannot reactivate or block a replacement VAD session", async () => {
  const gate = deferred();
  const calls = [];
  const oldVad = {
    pause: async () => { calls.push("old:pause"); await gate.promise; calls.push("old:late"); },
    start: async () => { calls.push("old:start"); },
  };
  const replacement = {
    pause: async () => { calls.push("new:pause"); },
    start: async () => { calls.push("new:start"); },
  };
  const transitions = new SerializedVadTransitions(5);
  await assert.rejects(transitions.pause(oldVad), /VAD pause timed out/);
  transitions.beginSession();
  await transitions.start(replacement);
  gate.resolve();
  await tick();
  assert.deepEqual(calls, ["old:pause", "new:start", "old:late"]);
  assert.equal(transitions.acceptsCallbacks, true);
  assert.equal(transitions.isInvalid(oldVad), true);
  assert.equal(transitions.isInvalid(replacement), false);
});

test("a watchdog flush recovers a speech-start candidate without real-start", async () => {
  const calls = [];
  const vad = {
    pause: async () => { calls.push("pause"); },
    start: async () => { calls.push("start"); },
  };
  const transitions = new SerializedVadTransitions();
  await transitions.flush(vad);
  assert.deepEqual(calls, ["pause", "start"]);
  assert.equal(transitions.acceptsCallbacks, true);
});

test("deactivated VAD session ignores queued restarts and stale callbacks", async () => {
  const gate = deferred();
  const calls = [];
  const vad = {
    pause: async () => { calls.push("pause"); await gate.promise; },
    start: async () => { calls.push("start"); },
  };
  const transitions = new SerializedVadTransitions();
  const pause = transitions.pause(vad);
  const restart = transitions.start(vad);
  transitions.deactivate();
  gate.resolve();
  await Promise.all([pause, restart]);
  assert.deepEqual(calls, []);
  assert.equal(transitions.acceptsCallbacks, false);
  assert.equal(isCurrentVoiceSession(2, 1, {}, {}, false, true), false);
  const current = {};
  assert.equal(isCurrentVoiceSession(2, 2, current, current, false, true), true);
  assert.equal(isCurrentVoiceSession(2, 2, current, current, true, true), false);
  assert.equal(isCurrentVoiceSession(2, 2, current, {}, false, true), false);
});

test("an interrupted assistant echo is not sent back as a user turn", () => {
  const assistant = "It seems like the connection briefly stalled, so let me try that again.";
  assert.equal(removeAssistantEcho("It seems like the connection briefly stalled", assistant), "");
});

test("assistant echo is removed without losing the user's interruption", () => {
  const assistant = "The first option is faster and uses less memory.";
  assert.equal(
    removeAssistantEcho("The first option is faster, what is the second option?", assistant),
    "what is the second option?",
  );
});

test("unrelated and very short interruptions are preserved", () => {
  const assistant = "The first option is faster and uses less memory.";
  assert.equal(removeAssistantEcho("Please stop and tell me your name.", assistant), "Please stop and tell me your name.");
  assert.equal(removeAssistantEcho("Yes", assistant), "Yes");
  assert.equal(removeAssistantEcho("first option is faster", assistant), "first option is faster");
  assert.equal(removeAssistantEcho("It seems like rain", "It seems like rain is likely today."), "It seems like rain");
});

test("only the observed short incomplete echo receives the narrow exception", () => {
  assert.equal(removeAssistantEcho("It seems like.", "It seems like the connection stalled."), "");
  assert.equal(removeAssistantEcho("It looks like", "It looks like the connection stalled."), "It looks like");
});

test("TTS generation overlaps ordered playback", async () => {
  const calls = [];
  const generated = new Map();
  const played = new Map();
  const pipeline = new SpeechPipeline(async (text) => {
    calls.push(`generate:${text}`);
    const gate = deferred();
    generated.set(text, gate);
    return gate.promise;
  }, () => {}, (error) => { throw error; });
  const audio = (text) => async () => {
    calls.push(`play:${text}`);
    const gate = deferred();
    played.set(text, gate);
    await gate.promise;
  };

  pipeline.enqueue(["one", "two"]);
  generated.get("one").resolve(audio("one"));
  await tick();
  assert.deepEqual(calls, ["generate:one", "play:one", "generate:two"]);
  generated.get("two").resolve(audio("two"));
  await tick();
  assert.equal(calls.includes("play:two"), false);
  played.get("one").resolve();
  await tick();
  assert.equal(calls.at(-1), "play:two");
  played.get("two").resolve();
  await tick();
  assert.equal(pipeline.busy, false);
});

test("TTS dispatches the first early phrase and coalesces later queued phrases", async () => {
  const calls = [];
  const first = deferred();
  const pipeline = new SpeechPipeline(async (text) => {
    calls.push(text);
    if (text === "First early phrase.") return first.promise;
    return async () => {};
  }, () => {}, (error) => { throw error; });

  pipeline.enqueue(["First early phrase."]);
  pipeline.enqueue(["Second phrase.", "Third phrase."]);
  assert.deepEqual(calls, ["First early phrase."]);

  first.resolve(async () => {});
  await tick();
  await tick();
  assert.deepEqual(calls, ["First early phrase.", "Second phrase. Third phrase."]);
});

test("TTS coalescing preserves the 600-character request cap", async () => {
  const calls = [];
  const first = deferred();
  const second = "b".repeat(400);
  const third = "c".repeat(250);
  const fourth = "d".repeat(100);
  const pipeline = new SpeechPipeline(async (text) => {
    calls.push(text);
    if (text === "First early phrase.") return first.promise;
    return async () => {};
  }, () => {}, (error) => { throw error; });

  pipeline.enqueue(["First early phrase."]);
  pipeline.enqueue([second, third, fourth]);
  first.resolve(async () => {});
  await tick();
  await tick();
  await tick();

  assert.deepEqual(calls, ["First early phrase.", second, `${third} ${fourth}`]);
  assert.ok(calls.slice(1).every((text) => text.length <= 600));
});

test("barge-in aborts current speech and rejects stale prepared audio", async () => {
  const late = deferred();
  const signals = [];
  const played = [];
  const pipeline = new SpeechPipeline(async (text, signal) => {
    signals.push(signal);
    if (text === "two") return late.promise;
    return async (playbackSignal) => {
      played.push(text);
      if (text === "one") await new Promise((resolve) => playbackSignal.addEventListener("abort", resolve, { once: true }));
    };
  }, () => {}, () => {});

  pipeline.enqueue(["one", "two", "three"]);
  await tick();
  pipeline.cancel();
  assert.ok(signals.every((signal) => signal.aborted));
  pipeline.enqueue(["new"]);
  late.resolve(async () => { played.push("stale"); });
  await tick();
  assert.deepEqual(played, ["one", "new"]);
});

test("VAD candidate ducks an active assistant turn and a misfire leaves it alive", async () => {
  const started = deferred();
  let signal;
  const pipeline = new SpeechPipeline(async (_text, nextSignal) => {
    signal = nextSignal;
    return async () => { await started.promise; };
  }, () => {}, () => {});

  pipeline.enqueue(["assistant reply"]);
  await tick();
  assert.equal(hasActiveVoiceTurn(false, pipeline.busy, false), true);
  const guard = new BargeInGuard();
  assert.deepEqual(guard.speechStart(true), { duck: true, begin: true, accepted: false });
  guard.reset(); // Mirrors onVADMisfire: output resumes without cancelling the run.
  assert.equal(signal.aborted, false);
});

test("VAD candidate ducks audible output and begins a pending transcript", () => {
  const guard = new BargeInGuard();
  assert.deepEqual(guard.speechStart(true), { duck: true, begin: true, accepted: false });
  assert.equal(guard.speechEnd(), false);
});

test("a short VAD misfire discards its pending transcript without an STT request", async () => {
  let requests = 0;
  const live = new LiveTranscription(async () => { requests++; return "should not send"; }, () => {});
  const guard = new BargeInGuard();
  guard.speechStart(true);
  live.begin();
  for (let index = 0; index < 8; index++) live.frame(0.1, frame());
  guard.reset(); // Mirrors onVADMisfire.
  live.discard();
  await tick();
  assert.equal(requests, 0);
  assert.equal(guard.speechEnd(), false);
});

test("confirmed speech interrupts an audible-output candidate", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  assert.deepEqual(guard.speechRealStart(), { interrupt: true, begin: false, accepted: true });
  assert.equal(guard.speechEnd(), true);
});

test("speech after natural playback end starts a normal turn", () => {
  const guard = new BargeInGuard();
  assert.deepEqual(guard.speechStart(false), { duck: false, begin: true, accepted: false });
  assert.deepEqual(guard.speechRealStart(), { interrupt: false, begin: false, accepted: true });
  assert.equal(guard.speechEnd(), true);
});

test("generation-only turns wait for VAD confirmation before cancelling", () => {
  const guard = new BargeInGuard();
  assert.deepEqual(guard.speechStart(true), { duck: true, begin: true, accepted: false });
  assert.deepEqual(guard.speechRealStart(), { interrupt: true, begin: false, accepted: true });
});

test("speech chunking joins tiny fragments and emits early stable phrases", () => {
  const result = consumeSpeechChunks("Yes. This is the first useful sentence. Next words", false);
  assert.deepEqual(result.chunks, ["Yes. This is the first useful sentence."]);
  assert.equal(result.rest, " Next words");
  assert.deepEqual(consumeSpeechChunks(result.rest, true).chunks, ["Next words"]);
});

test("the first chunk of a turn breaks at a clause instead of waiting for a full sentence", () => {
  const text = "This is a fairly long opening clause that keeps going, and only ends here. Then a second sentence follows.";
  const result = consumeSpeechChunks(text, false, true);
  assert.deepEqual(result.chunks, [
    "This is a fairly long opening clause that keeps going,",
    "and only ends here.",
  ]);
  assert.equal(result.rest, " Then a second sentence follows.");
});

test("the early first-chunk boundary only applies once per call, not to every later chunk", () => {
  const text = "Short start, but this sentence keeps rolling on and on. Second sentence is also long enough. Third one too, here.";
  const first = consumeSpeechChunks(text, false, true);
  // The first phrase may break early at a clause; every later phrase in the
  // same call still needs a full sentence boundary before it is emitted.
  assert.ok(first.chunks.length >= 1);
  for (const chunk of first.chunks.slice(1)) {
    assert.ok(/[.!?]\s*$/.test(chunk), `expected a sentence-ending chunk, got: ${chunk}`);
  }
});

test("a short turn opener without punctuation is not split into a premature fragment", () => {
  const result = consumeSpeechChunks("Hi there", false, true);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.rest, "Hi there");
});

test("consumeSpeechChunks without `first` keeps the original full-sentence behavior", () => {
  const text = "This is a fairly long opening clause that keeps going, and only ends here. Then a second sentence follows.";
  const result = consumeSpeechChunks(text, false);
  assert.deepEqual(result.chunks, ["This is a fairly long opening clause that keeps going, and only ends here."]);
});
