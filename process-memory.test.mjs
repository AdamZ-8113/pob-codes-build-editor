import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProcessMemory, startProcessMemory } from './process-memory.mjs';

test('admission uses simultaneous private commit rather than non-simultaneous process peaks', () => {
  const result = summarizeProcessMemory([
    { elapsedMs: 0, processes: [{ pid: 1, privateBytes: 100, peakPrivateBytes: 100 }, { pid: 2, privateBytes: 20, peakPrivateBytes: 20 }] },
    { elapsedMs: 250, processes: [{ pid: 1, privateBytes: 30, peakPrivateBytes: 100 }, { pid: 2, privateBytes: 90, peakPrivateBytes: 90 }] },
    { elapsedMs: 750, processes: [{ pid: 1, privateBytes: 40, peakPrivateBytes: 100 }] },
  ]);
  assert.equal(result.peakBytes, 120);
  assert.equal(result.perProcessPeakSumBytes, 190);
  assert.equal(result.maximumSampleGapMs, 500);
});

test('missing or duplicated process measurements cannot establish admission', () => {
  assert.throws(() => summarizeProcessMemory([]), /No process/);
  assert.throws(() => summarizeProcessMemory([{ elapsedMs: 0, processes: [] }]), /Invalid process-tree/);
  assert.throws(() => summarizeProcessMemory([{ elapsedMs: 0, processes: [{ pid: 1, privateBytes: null }] }]), /Invalid/);
  const p = { pid: 1, privateBytes: 12, peakPrivateBytes: 12 };
  assert.throws(() => summarizeProcessMemory([{ elapsedMs: 0, processes: [p, p] }]), /Duplicate/);
});

test('sampler rejects an invalid root rather than sampling arbitrary processes', async () => {
  await assert.rejects(startProcessMemory(0), /PID|required Windows|requires Windows/);
});
