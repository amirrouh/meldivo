import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bufferedDurationSeconds,
  freshStreamSchedule,
  scheduleStreamChunk,
  shouldHoldForUnderrun,
  shouldReleaseJitterBuffer,
  streamJitterBufferSeconds,
  streamMaxLeadSeconds,
  streamUnderrunLeadSeconds,
} from "../web/src/audio-playback.ts";

test("scheduleStreamChunk stays contiguous when audio hasn't actually run dry yet", () => {
  const schedule = freshStreamSchedule();
  const first = scheduleStreamChunk(schedule, 10, 0.5);
  assert.equal(schedule.nextTime, first + 0.5);
  // nextTime (10.6) is still ahead of "now" (10.59): not an underrun, even though it is within the
  // old (buggy) "about to run dry" window of now + streamUnderrunLeadSeconds (10.61).
  const now = schedule.nextTime - 0.01;
  const startAt = scheduleStreamChunk(schedule, now, 0.3);
  assert.equal(startAt, first + 0.5, "should schedule right after the previous chunk, with no gap");
  assert.equal(schedule.restarted, false);
});

test("scheduleStreamChunk only restarts once audio has actually run dry", () => {
  const schedule = freshStreamSchedule();
  scheduleStreamChunk(schedule, 10, 0.5); // nextTime = 10.6
  const startAt = scheduleStreamChunk(schedule, 11, 0.2); // now is past nextTime: real underrun
  assert.equal(startAt, 11 + streamUnderrunLeadSeconds);
  assert.equal(schedule.restarted, true);
});

test("scheduleStreamChunk marks the very first chunk of a phrase as a restart", () => {
  const schedule = freshStreamSchedule();
  scheduleStreamChunk(schedule, 5, 0.4);
  assert.equal(schedule.restarted, true);
});

test("scheduleStreamChunk caps the growing underrun lead", () => {
  const schedule = freshStreamSchedule();
  scheduleStreamChunk(schedule, 0, 0.1);
  let now = 1;
  for (let i = 0; i < 10; i++) {
    scheduleStreamChunk(schedule, now, 0.1);
    now += 1; // comfortably past nextTime (lead is capped well under 1s): keep forcing real underruns
  }
  assert.equal(schedule.underrunLead, streamMaxLeadSeconds);
});

test("bufferedDurationSeconds sums queued chunk lengths at the given sample rate", () => {
  const chunks = [new Float32Array(100), new Float32Array(50)];
  assert.equal(bufferedDurationSeconds(chunks, 1000), 0.15);
  assert.equal(bufferedDurationSeconds([], 1000), 0);
});

test("the jitter buffer holds a phrase from starting until enough audio is buffered, or the stream ends", () => {
  assert.equal(shouldReleaseJitterBuffer(streamJitterBufferSeconds - 0.01, false), false);
  assert.equal(shouldReleaseJitterBuffer(streamJitterBufferSeconds, false), true);
  assert.equal(shouldReleaseJitterBuffer(streamJitterBufferSeconds + 0.5, false), true);
  // A short phrase that ends before the jitter buffer fills up still releases immediately.
  assert.equal(shouldReleaseJitterBuffer(0, true), true);
});

test("after a real underrun, playback holds until enough audio has re-buffered instead of restarting chunk-by-chunk", () => {
  const schedule = freshStreamSchedule();
  scheduleStreamChunk(schedule, 0, 0.5); // started, nextTime = 0.1 + 0.5 = 0.6
  const now = 1; // past nextTime: audio has actually run dry
  // Only a sliver buffered so far: hold rather than restart with a chunk that will immediately underrun again.
  assert.equal(shouldHoldForUnderrun(schedule, now, 0.001, false), true);
  // Enough has now buffered to ride out the lead: stop holding.
  assert.equal(shouldHoldForUnderrun(schedule, now, schedule.underrunLead, false), false);
});

test("holding for an underrun never blocks flushing everything once the stream has ended", () => {
  const schedule = freshStreamSchedule();
  scheduleStreamChunk(schedule, 0, 0.5);
  const now = 1;
  assert.equal(shouldHoldForUnderrun(schedule, now, 0, true), false);
});

test("a phrase that never underran is never held, no matter how little is pending", () => {
  const schedule = freshStreamSchedule();
  // Before the first chunk has even been scheduled, there is nothing to "hold" for.
  assert.equal(shouldHoldForUnderrun(schedule, 0, 0, false), false);
  scheduleStreamChunk(schedule, 0, 0.5); // nextTime = 0.6, well ahead of "now"
  assert.equal(shouldHoldForUnderrun(schedule, 0.1, 0, false), false);
});
