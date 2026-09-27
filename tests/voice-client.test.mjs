import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveTranscription } from "../web/src/live-transcription.ts";
import {
  isCurrentVoiceSession,
  SerializedVadTransitions,
  VoiceInputCoordinator,
} from "../web/src/input-coordinator.ts";
import { removeAssistantEcho } from "../web/src/assistant-echo.ts";
import { BargeInGuard, isMeaningfulSpeech, meaningfulSpeechMs } from "../web/src/barge-in-guard.ts";
import { maxMergedSpeechChars, SpeechPipeline } from "../web/src/speech-pipeline.ts";
import {
  freshStreamSchedule,
  scheduleStreamChunk,
  streamFirstLeadSeconds,
  streamMaxLeadSeconds,
  streamUnderrunLeadSeconds,
} from "../web/src/audio-playback.ts";
import {
  earlyEndpointQuietFrames,
  endsSentence,
  shouldEndpointEarly,
  wordCount,
} from "../web/src/endpointing.ts";
import {
  defaultVadRedemptionMs,
  vadMinSpeechMs,
  vadNegativeSpeechThreshold,
  vadOptionsFor,
  vadPositiveSpeechThreshold,
  vadRedemptionMsMax,
  vadRedemptionMsMin,
} from "../web/src/vad-config.ts";
import { readVadRedemptionMs, vadRedemptionPreferenceKey, writeVadRedemptionMs } from "../web/src/vad-preference.ts";
import { consumeSpeechChunks, hasActiveVoiceTurn } from "../web/src/voice.ts";
import {
  clearVoicePreference,
  readVoicePreference,
  voicePreferenceKey,
  writeVoicePreference,
} from "../web/src/voice-preference.ts";
import {
  beginTurn,
  cuePhrases,
  dueForCue,
  endTurn,
  freshCueState,
  noteCuePlayed,
  noteSpoken,
  pickCue,
} from "../web/src/working-cues.ts";

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
  assert.equal(defaultVadRedemptionMs, 700);
  assert.deepEqual(vadOptionsFor(), {
    positiveSpeechThreshold: 0.45,
    negativeSpeechThreshold: 0.30,
    minSpeechMs: 160,
    preSpeechPadMs: 320,
    redemptionMs: 700,
  });
  assert.deepEqual(vadOptionsFor(1_400), {
    positiveSpeechThreshold: 0.45,
    negativeSpeechThreshold: 0.30,
    minSpeechMs: 160,
    preSpeechPadMs: 320,
    redemptionMs: 1_400,
  });
  // Out-of-range and off-step values are clamped/rounded to the nearest allowed step.
  assert.equal(vadOptionsFor(50).redemptionMs, vadRedemptionMsMin);
  assert.equal(vadOptionsFor(5_000).redemptionMs, vadRedemptionMsMax);
  assert.equal(vadOptionsFor(730).redemptionMs, 700);
});

test("the VAD redemption preference persists a clamped value in this browser only", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(readVadRedemptionMs(storage), defaultVadRedemptionMs);
  assert.equal(writeVadRedemptionMs(1_250, storage), 1_300); // rounds to the nearest 100ms step
  assert.equal(values.get(vadRedemptionPreferenceKey), "1300");
  assert.equal(readVadRedemptionMs(storage), 1_300);
  assert.equal(writeVadRedemptionMs(50, storage), vadRedemptionMsMin);
  assert.equal(writeVadRedemptionMs(9_999, storage), vadRedemptionMsMax);
});

test("the VAD redemption preference tolerates unavailable browser storage", () => {
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  assert.equal(readVadRedemptionMs(storage), defaultVadRedemptionMs);
  assert.equal(writeVadRedemptionMs(900, storage), 900);
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

test("frames between the negative and positive thresholds keep the speculative transcript", async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => { calls++; return "Kept hypothesis."; }, () => {});
  live.begin();
  live.confirm();
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  // Silero only extends speech at the positive threshold; a 0.4 frame is not new speech.
  live.frame((vadNegativeSpeechThreshold + vadPositiveSpeechThreshold) / 2, frame());
  const samples = frame();
  live.end(samples);
  assert.equal(await live.finish(samples, new AbortController().signal), "Kept hypothesis.");
  assert.equal(calls, 1);
});

test("the energy fallback's lower speech threshold invalidates the transcript", async () => {
  let calls = 0;
  const live = new LiveTranscription(async () => ++calls === 1 ? "Old partial." : "Whole thought.", () => {});
  live.speechThreshold = vadNegativeSpeechThreshold;
  live.begin();
  live.confirm();
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  live.frame((vadNegativeSpeechThreshold + vadPositiveSpeechThreshold) / 2, frame());
  const samples = frame();
  live.end(samples);
  assert.equal(await live.finish(samples, new AbortController().signal), "Whole thought.");
  assert.equal(calls, 2);
});

test("a finished speculative sentence ends the utterance after a short pause", async () => {
  let endpoints = 0;
  const live = new LiveTranscription(async () => "Is it ready?", () => {}, () => { endpoints++; });
  live.begin();
  live.confirm();
  live.frame(0.9, frame());
  for (let index = 0; index < 6; index++) live.frame(0.01, frame());
  await tick();
  assert.equal(endpoints, 0, "the pause is still shorter than the early endpoint");
  for (let index = 6; index < earlyEndpointQuietFrames; index++) live.frame(0.01, frame());
  assert.equal(endpoints, 1);
  live.frame(0.01, frame());
  assert.equal(endpoints, 1, "fires once per utterance");
});

test("a speculative result that arrives after the pause ends the utterance at once", async () => {
  let endpoints = 0;
  const result = deferred();
  const live = new LiveTranscription(() => result.promise, () => {}, () => { endpoints++; });
  live.begin();
  live.confirm();
  for (let index = 0; index < earlyEndpointQuietFrames + 2; index++) live.frame(0.01, frame());
  assert.equal(endpoints, 0);
  result.resolve("Send it now.");
  await tick();
  assert.equal(endpoints, 1);
});

test("an unfinished or stale speculative sentence waits for the detector", async () => {
  let endpoints = 0;
  const unfinished = new LiveTranscription(async () => "and then I", () => {}, () => { endpoints++; });
  unfinished.begin();
  unfinished.confirm();
  for (let index = 0; index < earlyEndpointQuietFrames + 4; index++) unfinished.frame(0.01, frame());
  await tick();
  unfinished.frame(0.01, frame());

  const stale = new LiveTranscription(async () => "That is all.", () => {}, () => { endpoints++; });
  stale.begin();
  stale.confirm();
  for (let index = 0; index < 6; index++) stale.frame(0.01, frame());
  await tick();
  stale.frame(0.9, frame());
  for (let index = 0; index < 5; index++) stale.frame(0.01, frame());
  assert.equal(endpoints, 0);
});

test("early endpoint rules: sentence end, two words, current revision, 320 ms quiet", () => {
  const ready = { text: "Is it ready?", resultRevision: 3, revision: 3, quietFrames: earlyEndpointQuietFrames };
  assert.equal(shouldEndpointEarly(ready), true);
  assert.equal(shouldEndpointEarly({ ...ready, quietFrames: earlyEndpointQuietFrames - 1 }), false);
  assert.equal(shouldEndpointEarly({ ...ready, resultRevision: 2 }), false);
  assert.equal(shouldEndpointEarly({ ...ready, text: undefined, resultRevision: undefined }), false);
  assert.equal(shouldEndpointEarly({ ...ready, text: "Yes." }), false);
  assert.equal(shouldEndpointEarly({ ...ready, text: "So I was thinking" }), false);
  assert.equal(earlyEndpointQuietFrames * 32, 320);
  assert.equal(endsSentence('He said "stop now."'), true);
  assert.equal(endsSentence("(that is it!)"), true);
  assert.equal(endsSentence("Well, I guess..."), false);
  assert.equal(endsSentence("Well, I guess\u2026"), false);
  assert.equal(endsSentence("Really?\u201d"), true);
  assert.equal(wordCount(" Okay ... fine. "), 2);
});

test("streamed speech starts with a short lead and grows it after an underrun", () => {
  const schedule = freshStreamSchedule();
  const first = scheduleStreamChunk(schedule, 10, 0.5);
  assert.equal(first, 10 + streamFirstLeadSeconds);
  // The next chunk arrives in time: it plays back to back.
  assert.equal(scheduleStreamChunk(schedule, 10.2, 0.5), first + 0.5);
  // Audio ran dry: restart just ahead of now, and use a longer lead next time.
  assert.equal(scheduleStreamChunk(schedule, 12, 0.1), 12 + streamUnderrunLeadSeconds);
  assert.equal(scheduleStreamChunk(schedule, 13, 0.1), 13 + streamUnderrunLeadSeconds * 2);
  for (let index = 0; index < 8; index++) scheduleStreamChunk(schedule, 20 + index, 0.1);
  assert.equal(schedule.underrunLead, streamMaxLeadSeconds);
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

test("TTS coalescing preserves the 300-character request cap", async () => {
  const calls = [];
  const first = deferred();
  const second = "b".repeat(200);
  const third = "c".repeat(150);
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
  assert.equal(maxMergedSpeechChars, 300);
  assert.ok(calls.slice(1).every((text) => text.length <= maxMergedSpeechChars));
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
  assert.deepEqual(guard.speechEnd("", ""), { accepted: false, interrupt: false, send: false });
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
  assert.deepEqual(guard.speechEnd("", ""), { accepted: false, interrupt: false, send: false });
});

test("confirmed speech no longer interrupts immediately, only once it says something meaningful", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  // Real speech is confirmed, but the reply is left playing, ducked, until the
  // speaker has said enough - this used to cancel the reply immediately.
  assert.deepEqual(guard.speechRealStart(), { keepDucked: true, begin: false, accepted: true });
  assert.equal(guard.shouldInterruptNow("um", ""), false);
  assert.equal(guard.shouldInterruptNow("stop that", ""), true);
  assert.equal(guard.shouldInterruptNow("stop that now", ""), false); // already interrupted once
  assert.deepEqual(guard.speechEnd("stop that", ""), { accepted: true, interrupt: false, send: true });
});

test("a short filler at speech end never interrupts and the recording is dropped", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  assert.equal(guard.shouldInterruptNow("um", ""), false);
  assert.deepEqual(guard.speechEnd("um", ""), { accepted: true, interrupt: false, send: false });
});

test("meaningful speech only recognized at speech end still interrupts, and is sent", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  guard.speechRealStart();
  assert.equal(guard.shouldInterruptNow("uh", ""), false);
  assert.deepEqual(guard.speechEnd("wait, stop", ""), { accepted: true, interrupt: true, send: true });
});

test("a candidate that never accepts (VAD misfire) does not interrupt or send", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  assert.deepEqual(guard.speechEnd("stop that", ""), { accepted: false, interrupt: false, send: false });
});

test("speech after natural playback end starts a normal turn regardless of transcript", () => {
  const guard = new BargeInGuard();
  assert.deepEqual(guard.speechStart(false), { duck: false, begin: true, accepted: false });
  assert.deepEqual(guard.speechRealStart(), { keepDucked: false, begin: false, accepted: true });
  // No active turn to interrupt, so even filler is sent as an ordinary turn.
  assert.deepEqual(guard.speechEnd("um", ""), { accepted: true, interrupt: false, send: true });
});

test("shouldInterruptNow ignores a candidate that has not yet been confirmed", () => {
  const guard = new BargeInGuard();
  guard.speechStart(true);
  assert.equal(guard.shouldInterruptNow("stop that", ""), false);
});

test("long confirmed speech without real words never interrupts: the mic may be hearing the reply", () => {
  let now = 0;
  const guard = new BargeInGuard(() => now);
  guard.speechStart(true);
  guard.speechRealStart();
  now += meaningfulSpeechMs * 5;
  assert.equal(guard.shouldInterruptNow("", ""), false);
  assert.equal(guard.shouldInterruptNow("wait stop", ""), true);
});

test("a few words of the reply's own voice, even misheard, are echo rather than an interruption", () => {
  const reply = "Sure. The weather in Paris today is sunny with a light breeze from the west.";
  assert.equal(isMeaningfulSpeech("weather in Paris", reply), false);
  assert.equal(isMeaningfulSpeech("a light breeze from the waste", reply), false);
  assert.equal(isMeaningfulSpeech("wait what about London", reply), true);
});

test("isMeaningfulSpeech drops filler words and assistant echo before counting real words", () => {
  assert.equal(isMeaningfulSpeech("um", ""), false);
  assert.equal(isMeaningfulSpeech("uh huh", ""), false);
  assert.equal(isMeaningfulSpeech("um yes wait", ""), true);
  assert.equal(isMeaningfulSpeech("", ""), false);
  const assistant = "The first option is faster and uses less memory.";
  assert.equal(isMeaningfulSpeech("The first option is faster", assistant), false);
  assert.equal(isMeaningfulSpeech("The first option is faster, what about the second", assistant), true);
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

test("the first phrase goes out as soon as a two-word sentence ends; a lone word or short clause waits", () => {
  assert.deepEqual(consumeSpeechChunks("Sure thing. Here is", false, true).chunks, ["Sure thing."]);
  assert.deepEqual(consumeSpeechChunks("Sure. Here", false, true).chunks, []);
  assert.deepEqual(consumeSpeechChunks("Okay, so the", false, true).chunks, []);
  assert.deepEqual(consumeSpeechChunks("Okay, so the answer, then", false, true).chunks, ["Okay, so the answer,"]);
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

test("a working cue is never due before the turn has spoken, or before it started", () => {
  let state = freshCueState();
  assert.equal(dueForCue(state, 10_000, 10_000), false); // no active turn at all
  state = beginTurn(state);
  assert.equal(dueForCue(state, 10_000, 10_000), false); // active, but nothing spoken yet this turn
  state = noteSpoken(state);
  assert.equal(dueForCue(state, 100, 100), false); // spoken, but not silent for long enough yet
  assert.equal(dueForCue(state, 1_500, 1_500), true);
});

test("a working cue respects the cooldown and stops once the turn ends", () => {
  let state = noteSpoken(beginTurn(freshCueState()));
  assert.equal(dueForCue(state, 1_500, 1_000), true);
  state = noteCuePlayed(state, "One moment.", 1_000);
  assert.equal(dueForCue(state, 1_500, 2_000), false); // inside the cooldown window
  assert.equal(dueForCue(state, 1_500, 7_001), true); // cooldown has elapsed
  state = endTurn(state);
  assert.equal(dueForCue(state, 10_000, 20_000), false);
});

test("a new turn clears the previous turn's cue history", () => {
  let state = noteCuePlayed(noteSpoken(beginTurn(freshCueState())), "Still on it.", 0);
  state = beginTurn(state);
  assert.equal(state.hasSpokenThisTurn, false);
  assert.equal(state.lastCueAt, null);
});

test("pickCue never repeats the immediately preceding cue", () => {
  let state = freshCueState();
  for (let i = 0; i < 20; i++) {
    const text = pickCue(state, () => 0); // a biased RNG that would always pick the first option
    assert.ok(cuePhrases.includes(text));
    if (state.lastCueText) assert.notEqual(text, state.lastCueText);
    state = noteCuePlayed(state, text, i);
  }
});
