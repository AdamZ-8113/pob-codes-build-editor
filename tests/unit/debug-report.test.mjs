import assert from "node:assert/strict";
import test from "node:test";
import { createDebugReportV1, sanitizeDiagnosticV1 } from "../../src/debug-report.ts";

test("debug report keeps useful aggregate evidence and excludes private strings", () => {
  const secret = "PrivateCharacter /user/Adam/Builds/secret.xml https://example.test/#token";
  const diagnostic = sanitizeDiagnosticV1({
    phase: "worker",
    event: "helpers-fallback",
    level: "error",
    data: { reason: "helper-memory", error: secret, message: secret, helperBytes: [123, 456] },
  }, 321.4);
  const report = createDebugReportV1({
    generatedAt: "2026-10-07T12:00:00.000Z",
    uptimeMs: 1234.56,
    productName: "PoB Codes Build Editor",
    appVersion: "abcdef123456",
    mode: "browser-preview",
    ready: true,
    errorCount: 2,
    browser: { name: "Chrome", major: "140", platform: "Windows" },
    capabilities: {
      hardwareConcurrency: 8,
      deviceMemoryGiB: 16,
      crossOriginIsolated: true,
      viewportWidth: 1440,
      viewportHeight: 900,
      devicePixelRatio: 1,
    },
    configuration: { calculationScheduling: "scheduled", renderReuse: true, payloadPrefetch: false },
    runtimeProfile: {
      wasmBytes: 200,
      samples: { luaKiB: 12, summary: { MAIN: { count: 2, totalMs: 4, maxMs: 3 } }, privateBuild: secret },
      helpers: {
        ready: 0,
        errors: [`Error: ${secret}`, "Helper timeout"],
        memory: { helperMaximum: 1024 },
      },
      filesystem: {
        operations: { read: 9 },
        packagedPaths: [[secret, 1]],
        payload: { loadedPackages: [secret], packageOpens: [secret] },
      },
      images: { completed: 3 },
    },
    renderStats: {
      backend: { name: "WebGL2", instances: 5, secret },
      glyphAtlas: { glyphQuads: 7 },
      layerStats: [{ secret }],
    },
    frames: [{ at: 10, duration: 4, render: 2, reused: false }],
    diagnostics: [diagnostic],
  });

  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /PrivateCharacter|secret\.xml|example\.test|\/user\/Adam/);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.memory.wasmBytes, 200);
  assert.deepEqual(report.runtime.helpers.recentErrorKinds, ["other", "timeout"]);
  assert.deepEqual(report.runtime.filesystem.operations, { read: 9 });
  assert.equal(report.runtime.filesystem.payload.loadedPackageCount, 1);
  assert.deepEqual(report.diagnostics[0].data, { reason: "helper-memory", helperBytes: [123, 456] });
  assert.ok(report.privacy.excluded.includes("build codes and XML"));
});

test("diagnostic sanitizer rejects raw messages and bounds unsafe tokens", () => {
  const value = sanitizeDiagnosticV1({
    phase: "worker",
    event: "not safe <script>",
    data: { operation: "mouse-move", message: "private", error: "private", helperBytes: [1, 2, 3, 4] },
  }, -5);
  assert.deepEqual(value, {
    atMs: 0,
    phase: "worker",
    event: "unknown",
    level: "info",
    data: { operation: "mouse-move", helperBytes: [1, 2, 3] },
  });
});
