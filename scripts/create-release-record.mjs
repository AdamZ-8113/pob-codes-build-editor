import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileSha256, inventoryFiles, jsonBytes, sha256 } from "./release-common.mjs";

const root = resolve(".runtime/import2-release");
const runtime = resolve(".runtime");
const release = JSON.parse(await readFile(join(root, "import2/release.json"), "utf8"));
if (!release.current) throw new Error("A full release is required for a durable recovery record");
const sourcePin = JSON.parse(await readFile("source-pin.json", "utf8"));
const deploymentConfigSha256 = await fileSha256("wrangler.import2.jsonc");
const files = await inventoryFiles(root);
const inventory = {
  schemaVersion: 1,
  generation: release.current,
  files,
  totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
};
const inventoryBytes = jsonBytes(inventory);
let publicCommit = process.env.GITHUB_SHA;
if (!publicCommit) {
  try { publicCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { publicCommit = "uncommitted-snapshot"; }
}
const record = {
  schemaVersion: 1,
  contractVersion: 2,
  generation: release.current,
  predecessor: release.retained[0] ?? null,
  publicCommit,
  pob: {
    revision: sourcePin.revision,
    ledgerSha256: await fileSha256("source-pin.json"),
    compositePatchSha256: sourcePin.compositePatch.patchSha256,
    license: {
      sourcePath: "LICENSE.md",
      sha256: await fileSha256("PATH_OF_BUILDING_LICENSE.md"),
      provenanceSha256: await fileSha256("PATH_OF_BUILDING_LICENSE.provenance.json"),
    },
  },
  binaries: {
    driverMjsSha256: await fileSha256("upstream/packages/driver/dist/release/driver.mjs"),
    driverWasmSha256: await fileSha256("upstream/packages/driver/dist/release/driver.wasm"),
  },
  payload: {
    manifestSha256: release.payloadManifestSha256,
    provenanceSha256: await fileSha256(".runtime/payload/provenance.json"),
  },
  deployment: {
    resource: "pob-codes-import2",
    route: "pob.codes/import2*",
    basePath: "/import2",
    configSha256: deploymentConfigSha256,
  },
  inventorySha256: sha256(inventoryBytes),
  archive: null,
};
await mkdir(runtime, { recursive: true });
await writeFile(join(runtime, "release-inventory.json"), inventoryBytes);
await writeFile(join(runtime, "release-record.json"), jsonBytes(record));
console.log(`Recorded release ${release.current}: ${inventory.totals.files} files, ${inventory.totals.bytes} bytes.`);
