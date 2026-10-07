import assert from 'node:assert/strict';

export function summarizeDurations(values) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  assert.ok(sorted.every(value => Number.isFinite(value) && value >= 0), 'Durations must be finite and nonnegative');
  return { count: n, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p95: sorted[Math.max(0, Math.ceil(n * .95) - 1)] ?? null, max: sorted.at(-1) ?? null };
}

// Frame sequence numbers belong to the shell's completed-frame callbacks. Unlike
// timestamps they also reveal samples lost from its bounded diagnostic buffer.
export function createResponsivenessCollector(firstFrame) {
  let lastFrame = firstFrame, previousCompletion, missedFrames = 0;
  const profileRpcMs = [], frameCpuMs = [], rendererCpuMs = [], completedFrameGapMs = [];
  return {
    add({ rpcMs, frames, frameSamples }) {
      profileRpcMs.push(rpcMs);
      const firstBufferedFrame = frames - frameSamples.length + 1;
      for (const [offset, sample] of frameSamples.entries()) {
        const sequence = firstBufferedFrame + offset;
        if (sequence <= lastFrame) continue;
        const missed = Math.max(0, sequence - lastFrame - 1);
        missedFrames += missed;
        const completedAt = sample.at + sample.duration;
        // A gap spanning missing callbacks is not an individual frame interval.
        if (previousCompletion !== undefined && !missed) completedFrameGapMs.push(Math.max(0, completedAt - previousCompletion));
        previousCompletion = completedAt;
        lastFrame = sequence;
        frameCpuMs.push(sample.duration);
        rendererCpuMs.push(sample.render);
      }
    },
    summary() {
      return { profileRpcMs: summarizeDurations(profileRpcMs), frameCpuMs: summarizeDurations(frameCpuMs),
        rendererCpuMs: summarizeDurations(rendererCpuMs), completedFrameGapMs: summarizeDurations(completedFrameGapMs), missedFrames,
        scope: 'Existing readiness polls only, from entry to waitRun through observed completion; excludes control-click setup. Profile RPC time is measured inside the page and includes worker/broker queueing and serialization; it is a response proxy, not input-to-paint. Frame gaps use worker CPU completion timestamps, not GPU presentation.' };
    },
  };
}
