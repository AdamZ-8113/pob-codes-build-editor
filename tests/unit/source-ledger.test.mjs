import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSourceLedger } from "../../scripts/build/source-ledger.mjs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("desktop PoB overlay ledger owns six ordered PRs, relevance pruning and seven pack-time local patches", async () => {
  const { pin, compositeBytes } = await validateSourceLedger(appDir);
  assert.deepEqual(pin.overlays.map((entry) => entry.number ?? entry.id), [10360, 10371, 10372, 10373, 10313, 10381, "power-report-relevance-pruning", "gem-dropdown-hover", "limited-unique-item-comparisons", "importtab-host-capabilities", "preferred-export-site", "calculation-only-jewel-specs", "node-power-delegation", "compact-status-text"]);
  assert.equal(pin.compositePatch.files.includes("src/Classes/GemSelectControl.lua"), true);
  assert.equal(compositeBytes.includes(Buffer.from("GemSelectControl.lua")), true);
  assert.equal(pin.compositePatch.resultBlobHashes["src/Classes/GemSelectControl.lua"], pin.adapters.gemDropdownHover.sourceBlobHashes["src/Classes/GemSelectControl.lua"]);
  assert.equal(pin.compositePatch.resultBlobHashes["src/Classes/ItemDBControl.lua"], pin.adapters.uniqueSortDelegation.sourceBlobHashes["src/Classes/ItemDBControl.lua"]);
  assert.equal(pin.compositePatch.resultBlobHashes["src/Classes/ItemsTab.lua"], pin.adapters.limitedUniqueItemComparisons.sourceBlobHashes["src/Classes/ItemsTab.lua"]);
  assert.equal(pin.adapters.calculationOnlyJewelSpecs.preparedSourceBlobHashes["src/Classes/ItemsTab.lua"], pin.adapters.limitedUniqueItemComparisons.sourceBlobHashes["src/Classes/ItemsTab.lua"]);
  assert.equal(pin.adapters.calculationOnlyJewelSpecs.sourceBlobHashes["src/Classes/ItemsTab.lua"], pin.adapters.limitedUniqueItemComparisons.resultBlobHashes["src/Classes/ItemsTab.lua"]);
  assert.equal(pin.adapters.preferredExportSite.sourceBlobHashes["src/Classes/ImportTab.lua"], pin.adapters.importTabHostCapabilities.resultBlobHashes["src/Classes/ImportTab.lua"]);
  assert.equal(pin.adapters.browserUiDefaults.sourceBlobHashes["src/Modules/Main.lua"], pin.adapters.calculationScheduling.resultBlobHashes["src/Modules/Main.lua"]);
});

test("browser UI defaults adapter rejects changed Main.lua identities", async () => {
  const pin = JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8"));
  for (const mutate of [
    candidate => { candidate.adapters.browserUiDefaults.version = 2; },
    candidate => { candidate.adapters.browserUiDefaults.sourceBlobHashes["src/Modules/Main.lua"] = "0".repeat(40); },
    candidate => { candidate.adapters.browserUiDefaults.resultBlobHashes["src/Modules/Other.lua"] = "0".repeat(40); },
  ]) {
    const candidate = structuredClone(pin);
    mutate(candidate);
    await assert.rejects(validateSourceLedger(appDir, Buffer.from(JSON.stringify(candidate))), /Browser UI defaults adapter identity changed/);
  }
});

test("bundled PoB changes document covers every overlay and adapter identity", async () => {
  const pin = JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8"));
  const inventory = await readFile(join(appDir, "docs/BUNDLED_POB_CHANGES.md"), "utf8");
  for (const overlay of pin.overlays) {
    assert.equal(inventory.includes(`\`${overlay.number ?? overlay.id}\``), true, `Missing bundled overlay ${overlay.number ?? overlay.id}`);
  }
  for (const adapter of Object.keys(pin.adapters)) {
    assert.equal(inventory.includes(`\`${adapter}\``), true, `Missing bundled adapter ${adapter}`);
  }
});

test("item comparison overlay rejects changed stage, adapter identity and patch inventory", async () => {
  const pin = JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8"));
  for (const mutate of [
    candidate => { candidate.overlays.find(entry => entry.id === "limited-unique-item-comparisons").applicationStage = "checkout"; },
    candidate => { candidate.overlays.find(entry => entry.id === "limited-unique-item-comparisons").files.push("src/Classes/Other.lua"); },
    candidate => { candidate.adapters.limitedUniqueItemComparisons.patchSha256 = "0".repeat(64); },
    candidate => { candidate.adapters.limitedUniqueItemComparisons.patchFile = "patches/other.patch"; },
  ]) {
    const candidate = structuredClone(pin);
    mutate(candidate);
    await assert.rejects(validateSourceLedger(appDir, Buffer.from(JSON.stringify(candidate))), /ownership changed|inventory mismatch|identities differ/);
  }
});

test("jewel spec overlay rejects changed provenance, identities, stage and application order", async () => {
  const pin = JSON.parse(await readFile(join(appDir, "source-pin.json"), "utf8"));
  for (const mutate of [
    candidate => { candidate.overlays.find(entry => entry.id === "calculation-only-jewel-specs").applicationStage = "checkout"; },
    candidate => { candidate.overlays.find(entry => entry.id === "calculation-only-jewel-specs").files.push("src/Classes/Other.lua"); },
    candidate => { candidate.adapters.calculationOnlyJewelSpecs.patchSha256 = "0".repeat(64); },
    candidate => { candidate.adapters.calculationOnlyJewelSpecs.patchFile = "patches/other.patch"; },
    candidate => { candidate.adapters.calculationOnlyJewelSpecs.upstreamPr.head = "0".repeat(40); },
    candidate => { candidate.overlays.find(entry => entry.id === "calculation-only-jewel-specs").localChanges = []; },
    candidate => { candidate.adapters.calculationOnlyJewelSpecs.sourceBlobHashes["src/Classes/ItemsTab.lua"] = candidate.adapters.calculationOnlyJewelSpecs.preparedSourceBlobHashes["src/Classes/ItemsTab.lua"]; },
    candidate => { candidate.adapters.calculationOnlyJewelSpecs.preparedSourceBlobHashes["src/Classes/PassiveSpec.lua"] = "0".repeat(40); },
    candidate => { delete candidate.adapters.calculationOnlyJewelSpecs.resultBlobHashes["src/Classes/PassiveSpec.lua"]; },
    candidate => { const last = candidate.overlays.pop(); candidate.overlays.splice(-1, 0, last); },
  ]) {
    const candidate = structuredClone(pin);
    mutate(candidate);
    await assert.rejects(validateSourceLedger(appDir, Buffer.from(JSON.stringify(candidate))), /ownership changed|inventory mismatch|identities differ|provenance changed|overlay chain changed|identity inventory changed/);
  }
});

test("unique delegation fills the upstream cache from cache misses only", async () => {
  const patch = await readFile(join(appDir, "patches/unique-sort-delegation.patch"), "utf8");
  assert.match(patch, /function ItemDBClass:EvaluateItemPower/);
  assert.match(patch, /and slot\.shown\(\)/);
  assert.match(patch, /local missing = \{ \}/);
  assert.match(patch, /statCache\[item\] = measuredPower/);
  assert.match(patch, /#missing > 0 and self\.evaluateItemBatch/);
  assert.match(patch, /self:evaluateItemBatch\(missing\)/);
});

test("helper selects the imported weapon set before creating its calculator", async () => {
  const boot = await readFile(join(appDir, "upstream/packages/driver/helper-boot.lua"), "utf8");
  const selectWeaponSet = boot.indexOf("build.itemsTab.activeItemSet.useSecondWeaponSet = job.weaponSet");
  const createCalculator = boot.indexOf("calc = build.calcsTab:GetMiscCalculator(db.build)");
  assert.ok(selectWeaponSet >= 0, "helper weapon-set selection is missing");
  assert.ok(createCalculator > selectWeaponSet, "helper calculator was created before weapon-set selection");
});
