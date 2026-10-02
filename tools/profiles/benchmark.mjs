import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, release, totalmem } from "node:os";

const output = "reports/benchmark";
await mkdir(output, { recursive: true });
const sha256 = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const identity = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  sourcePinSha256: await sha256("source-pin.json"),
  payloadManifestSha256: await sha256(".runtime/payload/manifest.json"),
  driverMjsSha256: await sha256("upstream/packages/driver/dist/release/driver.mjs"),
  driverWasmSha256: await sha256("upstream/packages/driver/dist/release/driver.wasm"),
  fixtureSha256: await sha256("fixtures/guided import parity desktop 329.txt"),
  host: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalProcessors: cpus().length, totalmem: totalmem(), freeAtStart: freemem() },
  viewport: { width: 1600, height: 1000, dpr: 1 },
  limitations: ["Frame callbacks are CPU scheduling measurements, not GPU presentation latency.", "Caller-supplied private builds are not included."],
};
await writeFile(`${output}/identity.json`, `${JSON.stringify(identity, null, 2)}\n`);

const cases = [
  ["tools/profiles/profile-startup.mjs", `${output}/startup.json`],
  ["tools/profiles/profile-item-hover.mjs", "--build-file=fixtures/guided import parity desktop 329.txt", `--out=${output}/item-hover.json`, "--rounds=3", "--memory"],
  ["tools/profiles/profile-gem-hover.mjs", `${output}/gem-hover`],
  ["tools/profiles/profile-interactions.mjs", "fixtures/guided import parity desktop 329.txt", `${output}/tree-interactions.json`],
  ["tools/profiles/profile-unique-memory.mjs", `${output}/unique-sort.json`, "--helpers=3", "--sort-only"],
];
for (const [script, ...args] of cases) {
  console.log(`Benchmark: ${script}`);
  const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${script} exited ${result.status}`);
}
console.log(`Benchmark outputs: ${output}. Review them before sharing.`);
