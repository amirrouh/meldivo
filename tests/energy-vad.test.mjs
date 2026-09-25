import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxResampler, EnergyFrameProcessor, energyFrameSamples, energySampleRate } from "../web/src/energy-vad.ts";

// Synthetic 32 ms frames at the same 512-sample/16 kHz contract Silero v5 uses.
const frameSamples = energyFrameSamples;

function silenceFrame(amplitude = 0.0005) {
  const frame = new Float32Array(frameSamples);
  for (let i = 0; i < frameSamples; i++) frame[i] = (Math.random() * 2 - 1) * amplitude;
  return frame;
}

function toneFrame(amplitude = 0.3, freq = 220, sampleRate = energySampleRate, phaseStart = 0) {
  const frame = new Float32Array(frameSamples);
  for (let i = 0; i < frameSamples; i++) {
    frame[i] = amplitude * Math.sin((2 * Math.PI * freq * (phaseStart + i)) / sampleRate);
  }
  return frame;
}

function newProcessor(overrides = {}) {
  return new EnergyFrameProcessor({
    minSpeechMs: 160, // 5 frames @ 32ms
    redemptionMs: 320, // 10 frames @ 32ms - short, so tests run fast
    preSpeechPadMs: 64, // 2 frames
    maxSpeechMs: 2_000,
    ...overrides,
  });
}

function feedSilence(processor, count, amplitude = 0.0005) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(processor.process(silenceFrame(amplitude)));
  return results;
}

function feedSpeech(processor, count, amplitude = 0.3) {
  const results = [];
  for (let i = 0; i < count; i++) results.push(processor.process(toneFrame(amplitude, 220, energySampleRate, i * frameSamples)));
  return results;
}

test("energy VAD: silence alone produces no events and low probabilities", () => {
  const processor = newProcessor();
  const results = feedSilence(processor, 60);
  for (const result of results) {
    assert.equal(result.events.length, 0);
    assert.ok(result.probability < 0.2, `expected low probability during silence, got ${result.probability}`);
  }
  assert.equal(processor.speaking, false);
});

test("energy VAD: a sustained speech-like burst fires speech-start, speech-real-start, then speech-end after redemption", () => {
  const processor = newProcessor();
  // Warm up the noise floor with some quiet frames first.
  feedSilence(processor, 20);

  const startEvents = feedSpeech(processor, 10).flatMap((r) => r.events);
  assert.ok(startEvents.some((e) => e.type === "speech-start"), "expected speech-start");
  assert.ok(startEvents.some((e) => e.type === "speech-real-start"), "expected speech-real-start once minSpeechMs elapses");
  assert.equal(processor.speaking, true);

  // Silence long enough to exceed the redemption window should end the segment.
  const endEvents = feedSilence(processor, 15).flatMap((r) => r.events);
  const endEvent = endEvents.find((e) => e.type === "speech-end");
  assert.ok(endEvent, "expected speech-end after redemption window elapses");
  assert.ok(endEvent.samples instanceof Float32Array);
  // Segment should include the pre-speech pad, the speech frames, and the trailing silence up to redemption.
  assert.ok(endEvent.samples.length > frameSamples * 10, "recorded segment should include more than just the burst frames");
  assert.equal(processor.speaking, false);
});

test("energy VAD: a burst shorter than minSpeechMs is discarded as a misfire, not speech-end", () => {
  const processor = newProcessor({ minSpeechMs: 320 }); // 10 frames required
  feedSilence(processor, 20);

  // Only 3 frames of "speech" - well under the 10 required for a real start.
  const burstEvents = feedSpeech(processor, 3).flatMap((r) => r.events);
  assert.ok(burstEvents.some((e) => e.type === "speech-start"));
  assert.ok(!burstEvents.some((e) => e.type === "speech-real-start"));

  const tailEvents = feedSilence(processor, 15).flatMap((r) => r.events);
  assert.ok(tailEvents.some((e) => e.type === "misfire"), "expected a misfire for a too-short burst");
  assert.ok(!tailEvents.some((e) => e.type === "speech-end"), "a misfired segment must not also emit speech-end");
});

test("energy VAD: redemption tolerates a brief pause without ending the segment (false-negative recovery)", () => {
  const processor = newProcessor({ redemptionMs: 320 }); // 10 frames of grace
  feedSilence(processor, 20);
  feedSpeech(processor, 10); // real start fires

  // A short dip (3 frames, well under the 10-frame redemption window) then more speech.
  const dipEvents = feedSilence(processor, 3).flatMap((r) => r.events);
  assert.equal(dipEvents.filter((e) => e.type === "speech-end" || e.type === "misfire").length, 0);
  assert.equal(processor.speaking, true, "a brief dip under the redemption window should not end the segment");

  const resumeEvents = feedSpeech(processor, 5).flatMap((r) => r.events);
  assert.equal(resumeEvents.filter((e) => e.type === "speech-start").length, 0, "still the same segment, not a new one");
  assert.equal(processor.speaking, true);
});

test("energy VAD: max segment length forces a speech-end even without silence", () => {
  const processor = newProcessor({ maxSpeechMs: 320, redemptionMs: 10_000 }); // cap after ~10 frames
  feedSilence(processor, 20);
  const events = feedSpeech(processor, 40).flatMap((r) => r.events);
  assert.ok(events.some((e) => e.type === "speech-end"), "expected a forced speech-end at the max-length cap");
  assert.equal(processor.speaking, false, "processor should reset to silence after the forced end");
});

test("energy VAD: noise floor adapts upward with sustained ambient noise, raising the bar for detection", () => {
  const quietProcessor = newProcessor();
  feedSilence(quietProcessor, 40, 0.0005);
  const quietFloor = quietProcessor.noiseFloor;

  const noisyProcessor = newProcessor();
  feedSilence(noisyProcessor, 40, 0.02);
  const noisyFloor = noisyProcessor.noiseFloor;

  assert.ok(noisyFloor > quietFloor, `expected the noise floor to track ambient level (${noisyFloor} vs ${quietFloor})`);

  // The same absolute tone that would trigger against a quiet floor should
  // need to work harder (or simply may not trigger) against a noisy floor -
  // demonstrated here by checking probabilities are consistently lower.
  const quietProbe = quietProcessor.process(toneFrame(0.05)).probability;
  const noisyProbe = noisyProcessor.process(toneFrame(0.05)).probability;
  assert.ok(noisyProbe < quietProbe, "the same signal should read as less speech-like against a noisier floor");
});

test("energy VAD: pause with submitUserSpeechOnPause flushes the in-progress segment", () => {
  const processor = newProcessor({ submitUserSpeechOnPause: true });
  feedSilence(processor, 20);
  feedSpeech(processor, 10); // real start fires, still speaking
  assert.equal(processor.speaking, true);

  const events = processor.pause();
  assert.ok(events.some((e) => e.type === "speech-end"), "pause should flush the in-progress segment as speech-end");
  assert.equal(processor.speaking, false);

  // While paused, frames are ignored entirely.
  const ignored = processor.process(toneFrame(0.3));
  assert.deepEqual(ignored, { probability: 0, events: [] });

  processor.resume();
  const afterResume = processor.process(silenceFrame());
  assert.equal(afterResume.events.length, 0);
});

test("energy VAD: pause without submitUserSpeechOnPause silently discards the in-progress segment", () => {
  const processor = newProcessor({ submitUserSpeechOnPause: false });
  feedSilence(processor, 20);
  feedSpeech(processor, 10);
  assert.equal(processor.speaking, true);

  const events = processor.pause();
  assert.equal(events.length, 0, "no speech-end/misfire should be emitted when discarding on pause");
  assert.equal(processor.speaking, false);
});

test("energy VAD: setOptions updates thresholds and frame-count derived timers", () => {
  const processor = newProcessor({ minSpeechMs: 320 });
  feedSilence(processor, 20);
  // 3 frames would not be enough to hit real-start at 320ms/10 frames.
  const before = feedSpeech(processor, 3).flatMap((r) => r.events);
  assert.ok(!before.some((e) => e.type === "speech-real-start"));
  feedSilence(processor, 15); // let it misfire/reset

  processor.setOptions({ minSpeechMs: 64 }); // now only 2 frames needed
  feedSilence(processor, 20);
  const after = feedSpeech(processor, 3).flatMap((r) => r.events);
  assert.ok(after.some((e) => e.type === "speech-real-start"), "updated minSpeechMs should take effect immediately");
});

test("BoxResampler: downsamples to the exact target frame size and preserves overall duration", () => {
  const nativeRate = 48_000;
  const targetRate = 16_000;
  const targetFrameSize = 512;
  const resampler = new BoxResampler(nativeRate, targetRate, targetFrameSize);

  // One second of a constant-amplitude signal at the native rate.
  const input = new Float32Array(nativeRate);
  for (let i = 0; i < input.length; i++) input[i] = 0.5;

  const frames = resampler.process(input);
  for (const frame of frames) assert.equal(frame.length, targetFrameSize);

  const totalOutputSamples = frames.reduce((sum, frame) => sum + frame.length, 0);
  const expectedSamples = Math.round(nativeRate * (targetRate / nativeRate));
  // Box-average downsampling should account for very close to the full second of audio.
  assert.ok(Math.abs(totalOutputSamples - expectedSamples) < targetFrameSize);

  // The averaged signal should preserve the constant amplitude (within floating point tolerance).
  for (const frame of frames) {
    for (const sample of frame) assert.ok(Math.abs(sample - 0.5) < 1e-6);
  }
});
