import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyPowerNodeDepthPatch } from "../../scripts/patches/power-node-depth-patch.mjs";
import { applyNodePowerPatch } from "../../scripts/patches/node-power-patch.mjs";
import { applyStatusTextPatch } from "../../scripts/patches/status-text-patch.mjs";
import { validateSourceLedger } from "../../scripts/build/source-ledger.mjs";

const root = process.cwd();
const { pin } = await validateSourceLedger(root);
const adapter = pin.adapters.powerNodeDepthDefault;
const patch = await readFile(adapter.patchFile);
const preparedRoot = `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}`;
const treePath = "src/Classes/TreeTab.lua";
const calcsPath = "src/Classes/CalcsTab.lua";
const treeSource = await readFile(`${preparedRoot}/${treePath}`, "utf8").then(async value => applyStatusTextPatch(
  value,
  await readFile(pin.adapters.compactStatusText.patchFile),
  pin.adapters.compactStatusText,
  treePath,
), error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const calcsSource = await readFile(`${preparedRoot}/${calcsPath}`, "utf8").then(async value => applyNodePowerPatch(
  value,
  await readFile(pin.adapters.nodePowerDelegation.patchFile),
  pin.adapters.nodePowerDelegation,
), error => {
  if (error.code === "ENOENT") return null;
  throw error;
});

test("power-node depth defaults to 5 when CalcsTab initializes and rejects drift", { skip: treeSource === null || calcsSource === null }, () => {
  const treeResult = applyPowerNodeDepthPatch(treeSource, patch, adapter, treePath);
  const calcsResult = applyPowerNodeDepthPatch(calcsSource, patch, adapter, calcsPath);
  assert.match(treeResult, /\{ "All", 5, 10, 15, "Custom" \}, function\(index, value\)/);
  assert.match(treeResult, /nodePowerMaxDepthSelect\.selIndex = 2/);
  assert.doesNotMatch(treeResult, /self\.build\.calcsTab\.nodePowerMaxDepth = 5/);
  assert.match(calcsResult, /self\.build = build\n\s*self\.nodePowerMaxDepth = 5/);
  assert.throws(() => applyPowerNodeDepthPatch(`${treeSource}\n`, patch, adapter, treePath), /identity/);
  assert.throws(() => applyPowerNodeDepthPatch(treeResult, patch, adapter, treePath), /identity/);
  assert.throws(() => applyPowerNodeDepthPatch(treeSource, Buffer.concat([patch, Buffer.from("\n")]), adapter, treePath), /identity/);
});
