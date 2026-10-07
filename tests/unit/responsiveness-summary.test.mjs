import test from 'node:test';
import assert from 'node:assert/strict';
import { createResponsivenessCollector, summarizeDurations } from '../../tools/profiles/responsiveness-summary.mjs';

test('response distributions handle empty observations and nearest-rank percentiles', () => {
  assert.deepEqual(summarizeDurations([]), { count: 0, median: null, p95: null, max: null });
  assert.deepEqual(summarizeDurations([100, 0, 50, 10]), { count: 4, median: 30, p95: 100, max: 100 });
  assert.throws(() => summarizeDurations([NaN]), /finite/);
});

test('overlapping frame buffers count each frame once and use completion gaps', () => {
  const collector = createResponsivenessCollector(2);
  const frame = (at, duration) => ({ at, duration, render: 1 });
  collector.add({ rpcMs: 21, frames: 4, frameSamples: [frame(0, 10), frame(20, 10), frame(40, 50), frame(100, 10)] });
  collector.add({ rpcMs: 1, frames: 5, frameSamples: [frame(40, 50), frame(100, 10), frame(120, 20)] });
  const result = collector.summary();
  assert.deepEqual(result.profileRpcMs, { count: 2, median: 11, p95: 21, max: 21 });
  assert.equal(result.frameCpuMs.count, 3);
  assert.equal(result.frameCpuMs.max, 50);
  assert.deepEqual(result.completedFrameGapMs, { count: 2, median: 25, p95: 30, max: 30 });
  assert.equal(result.missedFrames, 0);
});

test('buffer truncation is explicit and cannot masquerade as one long frame', () => {
  const collector = createResponsivenessCollector(0);
  collector.add({ rpcMs: 1, frames: 1, frameSamples: [{ at: 0, duration: 10, render: 1 }] });
  collector.add({ rpcMs: 1, frames: 5, frameSamples: [{ at: 100, duration: 10, render: 1 }, { at: 120, duration: 10, render: 1 }] });
  const result = collector.summary();
  assert.equal(result.missedFrames, 2);
  assert.equal(result.completedFrameGapMs.count, 1);
  assert.equal(result.completedFrameGapMs.max, 20);
});
