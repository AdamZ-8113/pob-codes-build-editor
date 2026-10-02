import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createPackages, sourceKind, startupPackageIds } from "./packages.ts";
import { exposeExactRebuild } from "./calculation-adapter.ts";
import { guardJewelInflate, sparseTimelessSeeds } from "./timeless-adapter.ts";
import { stalePackageHashes, validatePayloadManifest } from "../../../payload-manifest.ts";
import { applyGemHoverPatch, blobHash } from "../../../../scripts/patches/gem-hover-patch.mjs";
import { applyUniqueSortPatch } from "../../../../scripts/patches/unique-sort-patch.mjs";
const revision = "a".repeat(40);
const sourcePin = JSON.parse(await Deno.readTextFile(new URL("../../../../source-pin.json", import.meta.url)));
const preparedSource = `../../../../.runtime/source-${sourcePin.compositePatch.patchSha256.slice(0, 12)}`;
const gemSource = new URL(`${preparedSource}/src/Classes/GemSelectControl.lua`, import.meta.url);
let hasGemSource = false;
try { hasGemSource = (await Deno.stat(gemSource)).isFile; } catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
Deno.test({ name: "gem hover patch preserves pin, rejects tampering and duplicate application", ignore: !hasGemSource, fn: async () => {
  const pin = sourcePin.adapters.gemDropdownHover;
  const patch = await Deno.readFile(new URL(`../../../../${pin.patchFile}`, import.meta.url));
  const source = await Deno.readTextFile(gemSource);
  const output = applyGemHoverPatch(source, Buffer.from(patch), pin);
  assertEquals(blobHash(output), pin.resultBlobHashes['src/Classes/GemSelectControl.lua']);
  assertEquals(output.includes('self.hoverTooltip = new("Tooltip"):Tooltip()'), true);
  assertThrows(() => applyGemHoverPatch(source + '\n', Buffer.from(patch), pin));
  assertThrows(() => applyGemHoverPatch(output, Buffer.from(patch), pin));
  assertThrows(() => applyGemHoverPatch(source, Buffer.from('invalid'), pin));
  assertThrows(() => applyGemHoverPatch(source, Buffer.from(patch), { ...pin, resultBlobHashes: {} }));
} });
Deno.test({ name: 'unique delegation patch rejects changed source, patch and result identities', ignore: !hasGemSource, fn: async () => {
  const pin = sourcePin.adapters.uniqueSortDelegation;
  const patch = Buffer.from(await Deno.readFile(new URL('../../../../' + pin.patchFile, import.meta.url)));
  const source = (await Deno.readTextFile(new URL(`${preparedSource}/src/Classes/ItemDBControl.lua`, import.meta.url))).replaceAll('\r\n', '\n');
  const output = applyUniqueSortPatch(source, patch, pin);
  assertEquals(blobHash(output), pin.resultBlobHashes['src/Classes/ItemDBControl.lua']);
  assertThrows(() => applyUniqueSortPatch(output, patch, pin));
  assertThrows(() => applyUniqueSortPatch(source + '\n', patch, pin));
  assertThrows(() => applyUniqueSortPatch(source, Buffer.from('invalid'), pin));
  assertThrows(() => applyUniqueSortPatch(source, patch, {...pin, resultBlobHashes:{}}));
} });
Deno.test("jewel inflate guard precedes optional cache creation and rejects changed interfaces", async () => {
  const helper = await Deno.readTextFile(new URL("./timeless-inflate.lua", import.meta.url));
  const cache = '\tif cacheUncompressed then\n\t\tlocal file = io.open("cache.bin", "wb+")\n\t\tfile:write(jewelData)\n\tend\n';
  const source = '\tlocal jewelData = Inflate(compressedData)\n' + cache;
  const output = guardJewelInflate(source, helper);
  assertEquals(output.endsWith('\tlocal jewelData = desktopInflateTimelessData(compressedData)\n' + cache), true);
  assertThrows(() => guardJewelInflate(source + source, helper));
  assertThrows(() => guardJewelInflate(output, helper));
  assertThrows(() => guardJewelInflate(source.replace('Inflate(compressedData)', 'Inflate(otherData)'), helper));
});
// This integration case uses the separately prepared, pinned checkout. Ordinary
// packer unit tests remain runnable before that local dependency is prepared.
const timelessSource = new URL(`${preparedSource}/src/Modules/DataLegionLookUpTableHelper.lua`, import.meta.url);
let hasTimelessSource = false;
try { hasTimelessSource = (await Deno.stat(timelessSource)).isFile; } catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
Deno.test({ name: "sparse timeless adaptation preserves original readLUT and rejects source drift", ignore: !hasTimelessSource, fn: async () => {
  const source = (await Deno.readTextFile(timelessSource)).replaceAll("\r\n", "\n");
  const helper = await Deno.readTextFile(new URL("./timeless-seeds.lua", import.meta.url));
  const output = sparseTimelessSeeds(source, helper);
  const readLUT = "local function readLUT(seed, nodeID, jewelType)";
  assertEquals(output.slice(output.indexOf(readLUT)), source.slice(source.indexOf(readLUT)));
  assertEquals(output.split("= desktopSparseTimelessSeeds(").length, 3);
  assertThrows(() => sparseTimelessSeeds(output, helper));
  assertThrows(() => sparseTimelessSeeds(source.replace("local count = 0", "local count = 1"), helper));
  assertThrows(() => sparseTimelessSeeds(source + source, helper));
} });
const entries = [
  { path: "GameVersions.lua", data: new TextEncoder().encode('treeVersionList = { "3_28_ruthless", "3_29" }') },
  { path: "Launch.lua", data: new TextEncoder().encode('require("TreeData.3_28_ruthless.Assets")') },
  { path: "TreeData/3_29/tree.lua", data: new Uint8Array([1]) },
  { path: "TreeData/3_28_ruthless/tree.lua", data: new Uint8Array([2]) },
  { path: "Data/TimelessJewelData/LethalPride.zip", data: new Uint8Array([3]) },
];
Deno.test("rebuild extraction retains the exact original body and fails on interface drift", () => {
  const block = '\tif self.buildFlag then\n\t\t-- Wipe Global Cache\n'
    + '\t\twipeGlobalCache()\n\t\tself.outputRevision = self.outputRevision + 1\n'
    + '\t\tself.buildFlag = false\n\t\tself.skillsTab:UpdateSocketGroups()\n'
    + '\t\tself.calcsTab:BuildOutput()\n\t\tself:RefreshStatList()\n'
    + '\t\tself.configTab.calcFunc, self.configTab.calcBase = self.calcsTab:GetMiscCalculator()\n\tend\n';
  const input = 'function buildMode:OnFrame()\n' + block
    + '\tif main.showThousandsSeparators ~= self.lastShowThousandsSeparators then\n\tend\nend\nreturn buildMode\n';
  const output = exposeExactRebuild(input);
  assertEquals(output.includes('function buildMode:DesktopEnsureOutputs()\n' + block + 'end'), true);
  assertEquals(output.split('self.calcsTab:BuildOutput()').length, 2);
  assertThrows(() => exposeExactRebuild(output));
  assertThrows(() => exposeExactRebuild(input.replace('self:RefreshStatList()', 'self:UnknownRefresh()')));
  assertThrows(() => exposeExactRebuild(input + input));
});
Deno.test("source policy rejects unknown files rather than silently dropping them", () => {
  assertEquals(sourceKind("Assets/Items.dds.zst"), "image");
  assertEquals(sourceKind("Data/ModFoulbornMap.jsonc"), "data");
  assertEquals(sourceKind("Export/Bases/wand.txt"), "excluded");
  assertEquals(sourceKind("Assets/ascendants/witch.jpeg"), "excluded");
  assertEquals(sourceKind("TreeData/3_29/ascendancy-3.webp"), "excluded");
  assertThrows(() => sourceKind("Data/new.format"));
  assertThrows(() => sourceKind("ExportFuture/new.lua"));
  assertThrows(() => sourceKind("TreeData/3_29_future/ascendancy-3.webp"));
});
Deno.test("packages are deterministic, complete, independently content addressed", async () => {
  const first = await createPackages(entries, revision);
  const second = await createPackages([...entries].reverse(), revision);
  assertEquals(first, second);
  assertEquals(first.manifest.packages.flatMap((p) => p.files).length, 5);
  assertEquals(first.manifest.schemaVersion, 2);
  assertEquals(first.manifest.packages.filter((p) => p.startup).map((p) => p.id), [
    "core",
    "tree-3_28_ruthless",
    "tree-3_29",
  ]);
  assertEquals(startupPackageIds(entries), new Set(["core", "tree-3_28_ruthless", "tree-3_29"]));
  const changed = await createPackages(
    entries.map((e) => e.path === "Launch.lua" ? { ...e, data: new Uint8Array([4]) } : e),
    revision,
  );
  assertEquals(
    first.manifest.packages.filter((p) => p.id !== "core").map(({ startup: _startup, ...p }) => p),
    changed.manifest.packages.filter((p) => p.id !== "core").map(({ startup: _startup, ...p }) => p),
  );
  assertEquals(changed.manifest.packages.find((p) => p.id === "tree-3_28_ruthless")?.startup, false);
});
Deno.test("reject traversal, duplicate paths, unknown trees and invalid manifests", async () => {
  for (
    const path of [
      "../bad",
      "/bad",
      "TreeData/unknown/tree.lua",
      "TreeData/3_29_future/tree.lua",
      "Data/TimelessJewelData/Future.zip",
      "a\\b",
      "Future/new-data.lua",
    ]
  ) {
    await assertRejects(() => createPackages([{ path, data: new Uint8Array() }], revision));
  }
  await assertRejects(() => createPackages([entries[0], entries[0]], revision));
  const { manifest } = await createPackages(entries, revision);
  assertThrows(() => validatePayloadManifest({ ...manifest, schemaVersion: 99 }));
  assertThrows(() => validatePayloadManifest({
    ...manifest,
    packages: manifest.packages.map(({ startup: _startup, ...p }) => p),
  }));
  const version1 = validatePayloadManifest({
    ...manifest,
    schemaVersion: 1,
    packages: manifest.packages.map(({ startup: _startup, ...p }) => p),
  });
  assertEquals(version1.packages.every((p) => p.startup), true);
  assertThrows(() => validatePayloadManifest({ ...manifest, packages: [...manifest.packages, manifest.packages[0]] }));
});

Deno.test("cleanup retains current and previous generations and rejects unowned names", async () => {
  const generations = await Promise.all([1, 2, 3].map((value) =>
    createPackages(
      entries.map((e) => e.path === "Launch.lua" ? { ...e, data: new Uint8Array([value]) } : e),
      revision,
    )
  ));
  const [old, previous, current] = generations.map((g) => g.manifest);
  assertEquals(stalePackageHashes(current, previous, old), [old.packages.find((p) => p.id === "core")!.sha256]);
  assertEquals(stalePackageHashes(current, previous, previous), []);
  assertEquals(stalePackageHashes(current), []);
  const corrupt = structuredClone(old);
  corrupt.packages[0].sha256 = "../../unrelated";
  assertThrows(() => stalePackageHashes(current, previous, corrupt));
});
