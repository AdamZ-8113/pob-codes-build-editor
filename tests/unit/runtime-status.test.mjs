import assert from "node:assert/strict";
import test from "node:test";
import { runtimeStatusNotice } from "../../src/runtime-status.ts";

const diagnostic = (phase, event, data = {}) => ({ phase, event, data, level: "info" });

test("helper memory diagnostics explain the safe serial fallback", () => {
  assert.deepEqual(runtimeStatusNotice(diagnostic("worker", "helpers-fallback", { reason: "helper-memory" })), {
    message: "A helper exceeded the 1 GB memory cap. Memory was released; continuing with serial processing.",
    tone: "warning",
    durationMs: 9_000,
  });
  assert.match(runtimeStatusNotice(diagnostic("worker", "helpers-fallback", { reason: "aggregate-memory" })).message,
    /memory safety limit.*serial processing/i);
  assert.match(runtimeStatusNotice(diagnostic("worker", "helpers-fallback", { reason: "worker-error" })).message,
    /stopped unexpectedly.*serial processing/i);
});

test("runtime diagnostics cover recoverable graphics and background failures", () => {
  assert.equal(runtimeStatusNotice(diagnostic("webgl", "context-lost")).durationMs, 0);
  assert.match(runtimeStatusNotice(diagnostic("webgl", "context-restored")).message, /restored/i);
  assert.match(runtimeStatusNotice(diagnostic("worker", "rpc-error", { operation: "mouse-move" })).message,
    /mouse move operation failed/i);
  assert.equal(runtimeStatusNotice(diagnostic("frame", "complete")), undefined);
});
