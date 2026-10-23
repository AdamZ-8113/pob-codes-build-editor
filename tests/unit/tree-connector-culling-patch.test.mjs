import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyTreeConnectorCullingPatch } from "../../scripts/patches/tree-connector-culling-patch.mjs";
import { validateSourceLedger } from "../../scripts/build/source-ledger.mjs";

const { pin } = await validateSourceLedger(process.cwd());
const adapter = pin.adapters.treeConnectorCulling;
const patch = await readFile(adapter.patchFile);
const preparedRoot = `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}`;

for (const path of Object.keys(adapter.sourceBlobHashes)) {
  const source = await readFile(`${preparedRoot}/${path}`, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  test(`tree connector culling verifies ${path} and rejects source, patch and result drift`, { skip: source === null }, () => {
    const result = applyTreeConnectorCullingPatch(source, patch, adapter, path);
    assert.notEqual(result, source);
    assert.throws(() => applyTreeConnectorCullingPatch(`${source}\n`, patch, adapter, path), /identity/);
    assert.throws(() => applyTreeConnectorCullingPatch(result, patch, adapter, path), /identity/);
    assert.throws(() => applyTreeConnectorCullingPatch(source, Buffer.concat([patch, Buffer.from("\n")]), adapter, path), /identity/);
    assert.throws(() => applyTreeConnectorCullingPatch(source, patch, {
      ...adapter, resultBlobHashes: { ...adapter.resultBlobHashes, [path]: "0".repeat(40) },
    }, path), /result identity/);
  });
}
