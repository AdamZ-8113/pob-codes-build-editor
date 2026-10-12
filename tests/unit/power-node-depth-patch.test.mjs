import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyPowerNodeDepthPatch } from "../../scripts/patches/power-node-depth-patch.mjs";
import { applyStatusTextPatch } from "../../scripts/patches/status-text-patch.mjs";
import { validateSourceLedger } from "../../scripts/build/source-ledger.mjs";

const root = process.cwd();
const { pin } = await validateSourceLedger(root);
const adapter = pin.adapters.powerNodeDepthDefault;
const patch = await readFile(adapter.patchFile);
const prepared = `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/src/Classes/TreeTab.lua`;
const source = await readFile(prepared, "utf8").then(async value => applyStatusTextPatch(
  value,
  await readFile(pin.adapters.compactStatusText.patchFile),
  pin.adapters.compactStatusText,
  "src/Classes/TreeTab.lua",
), error => {
  if (error.code === "ENOENT") return null;
  throw error;
});

test("power-node depth defaults to 5 and rejects drift", { skip: source === null }, () => {
  const result = applyPowerNodeDepthPatch(source, patch, adapter);
  assert.match(result, /\{ "All", 5, 10, 15, "Custom" \}, function\(index, value\)/);
  assert.match(result, /nodePowerMaxDepthSelect\.selIndex = 2\n\s*self\.build\.calcsTab\.nodePowerMaxDepth = 5/);
  assert.throws(() => applyPowerNodeDepthPatch(`${source}\n`, patch, adapter), /identity/);
  assert.throws(() => applyPowerNodeDepthPatch(result, patch, adapter), /identity/);
  assert.throws(() => applyPowerNodeDepthPatch(source, Buffer.concat([patch, Buffer.from("\n")]), adapter), /identity/);
});
