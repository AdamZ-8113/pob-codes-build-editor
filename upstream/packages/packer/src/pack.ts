// Adapted from atty303/pob-web packages/packer/src/pack.ts (MIT).
// This entry point consumes an already pinned/patched local checkout; it never
// chooses a release or writes the existing headless Browser-PoB assets.
import { copy, ensureDir, walk } from "@std/fs";
import { dirname, relative, resolve } from "@std/path";
import * as zstd from "@bokuweb/zstd-wasm";
import AdmZip from "adm-zip";
import { parseDDSDX10 } from "dds";
import { imageDimensionsFromData } from "image-dimensions";
import { Buffer } from "node:buffer";
import { createPackages, sourceKind } from "./packages.ts";
import { exposeExactRebuild } from "./calculation-adapter.ts";
import { guardJewelInflate, sparseTimelessSeeds } from "./timeless-adapter.ts";
import { applyGemHoverPatch } from "../../../../scripts/patches/gem-hover-patch.mjs";
import { applyItemComparisonPatch } from "../../../../scripts/patches/item-comparison-patch.mjs";
import { applyJewelSpecPatch } from "../../../../scripts/patches/jewel-spec-patch.mjs";
import { applyNodePowerPatch } from "../../../../scripts/patches/node-power-patch.mjs";
import { applyStatusTextPatch } from "../../../../scripts/patches/status-text-patch.mjs";
import { applyUniqueSortPatch } from "../../../../scripts/patches/unique-sort-patch.mjs";
import { applyImportTabHostPatch } from "../../../../scripts/patches/importtab-host-patch.mjs";
import { applyPreferredExportSitePatch } from "../../../../scripts/patches/preferred-export-site-patch.mjs";
import { sha256, stalePackageHashes, validatePayloadManifest } from "../../../payload-manifest.ts";

const [source, destination] = Deno.args;
if (!source || !destination || Deno.args.length !== 2) {
  throw new Error("Usage: pack.ts <pinned-source-directory> <payload-directory>");
}
const repoDir = resolve(source);
const payloadDir = resolve(destination);
const pin = JSON.parse(await Deno.readTextFile(new URL("../../../../source-pin.json", import.meta.url)));
const gemHoverPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.gemDropdownHover.patchFile}`, import.meta.url));
const itemComparisonPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.limitedUniqueItemComparisons.patchFile}`, import.meta.url));
const jewelSpecPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.calculationOnlyJewelSpecs.patchFile}`, import.meta.url));
const nodePowerPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.nodePowerDelegation.patchFile}`, import.meta.url));
const statusTextPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.compactStatusText.patchFile}`, import.meta.url));
const uniqueSortPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.uniqueSortDelegation.patchFile}`, import.meta.url));
const importTabHostPatch = await Deno.readFile(new URL(`../../../../${pin.adapters.importTabHostCapabilities.patchFile}`, import.meta.url));
const preferredExportSitePatch = await Deno.readFile(new URL(`../../../../${pin.adapters.preferredExportSite.patchFile}`, import.meta.url));
await ensureDir(payloadDir);
await zstd.init();

const zip = new AdmZip();
const imageIndex: string[] = [];
const basePath = `${repoDir}/src`;
const timelessSeedHelper = await Deno.readTextFile(new URL("./timeless-seeds.lua", import.meta.url));
const timelessInflateHelper = await Deno.readTextFile(new URL("./timeless-inflate.lua", import.meta.url));
// Stable traversal makes the metadata and archive ordering reproducible.
const entries = [];
for await (const entry of walk(basePath, { includeDirs: true, followSymlinks: false })) entries.push(entry);
entries.sort((a, b) => a.path.localeCompare(b.path));
for (const entry of entries) {
  const relPath = relative(basePath, entry.path).replaceAll("\\", "/");
  if (relPath === "Export" || relPath.startsWith("Export/")) continue;
  if (entry.isDirectory) {
    if (relPath) zip.addFile(`${relPath}/`, Buffer.alloc(0));
    continue;
  }
  const kind = sourceKind(relPath);
  const isDDS = entry.path.endsWith(".dds.zst");
  if (kind === "image") {
    const dimensions = isDDS
      ? ddsSize(await Deno.readFile(entry.path))
      : imageDimensionsFromData(await Deno.readFile(entry.path));
    if (!dimensions) throw new Error(`Unsupported or invalid image: ${entry.path}`);
    imageIndex.push(`${relPath}\t${dimensions.width}\t${dimensions.height}`);
    zip.addFile(relPath, Buffer.alloc(0));
    const assetPath = `${payloadDir}/root/${relPath}`;
    await ensureDir(dirname(assetPath));
    await copy(entry.path, assetPath, { overwrite: true });
  }
  if (kind === "data") {
    const content = await Deno.readFile(entry.path);
    const newRelPath = relPath.replaceAll("Specific_Skill_Stat_Descriptions", "specific_skill_stat_descriptions");
    const newContent = relPath.endsWith("StatDescriber.lua")
      ? new TextEncoder().encode(
        new TextDecoder().decode(content).replaceAll(
          "Specific_Skill_Stat_Descriptions",
          "specific_skill_stat_descriptions",
        ),
      )
      : content;
    const comparisonInput = relPath === "Classes/ItemsTab.lua"
      ? new TextEncoder().encode(applyItemComparisonPatch(new TextDecoder().decode(newContent), Buffer.from(itemComparisonPatch), pin.adapters.limitedUniqueItemComparisons))
      : newContent;
    const adapted = relPath === "Modules/Build.lua"
      ? new TextEncoder().encode(exposeExactRebuild(new TextDecoder().decode(newContent)))
      : relPath === "Classes/GemSelectControl.lua"
      ? new TextEncoder().encode(applyStatusTextPatch(
        applyGemHoverPatch(new TextDecoder().decode(newContent), Buffer.from(gemHoverPatch), pin.adapters.gemDropdownHover),
        Buffer.from(statusTextPatch), pin.adapters.compactStatusText, `src/${relPath}`,
      ))
      : relPath === "Classes/TreeTab.lua" || relPath === "Modules/ToastNotification.lua"
      ? new TextEncoder().encode(applyStatusTextPatch(
        new TextDecoder().decode(newContent), Buffer.from(statusTextPatch), pin.adapters.compactStatusText, `src/${relPath}`,
      ))
      : relPath === "Classes/CalcsTab.lua"
      ? new TextEncoder().encode(applyNodePowerPatch(new TextDecoder().decode(newContent), Buffer.from(nodePowerPatch), pin.adapters.nodePowerDelegation))
      : relPath === "Classes/ItemDBControl.lua"
      ? new TextEncoder().encode(applyUniqueSortPatch(new TextDecoder().decode(newContent), Buffer.from(uniqueSortPatch), pin.adapters.uniqueSortDelegation))
      : relPath === "Classes/ItemsTab.lua"
      ? new TextEncoder().encode(applyJewelSpecPatch(new TextDecoder().decode(comparisonInput), Buffer.from(jewelSpecPatch), pin.adapters.calculationOnlyJewelSpecs, `src/${relPath}`))
      : relPath === "Classes/PassiveSpec.lua"
      ? new TextEncoder().encode(applyJewelSpecPatch(new TextDecoder().decode(newContent), Buffer.from(jewelSpecPatch), pin.adapters.calculationOnlyJewelSpecs, `src/${relPath}`))
      : relPath === "Classes/ImportTab.lua"
      ? new TextEncoder().encode(applyPreferredExportSitePatch(
        applyImportTabHostPatch(new TextDecoder().decode(newContent), Buffer.from(importTabHostPatch), pin.adapters.importTabHostCapabilities),
        Buffer.from(preferredExportSitePatch),
        pin.adapters.preferredExportSite,
      ))
      : relPath === "Modules/DataLegionLookUpTableHelper.lua"
      ? new TextEncoder().encode(sparseTimelessSeeds(new TextDecoder().decode(newContent), timelessSeedHelper))
      : relPath === "Modules/DataJewelFileLoader.lua"
      ? new TextEncoder().encode(guardJewelInflate(new TextDecoder().decode(newContent), timelessInflateHelper)) : newContent;
    zip.addFile(newRelPath, Buffer.from(adapted));
  }
}
const luaPath = `${repoDir}/runtime/lua`;
for await (const entry of walk(luaPath, { includeDirs: false, exts: [".lua"] })) {
  zip.addFile(
    `lua/${relative(luaPath, entry.path).replaceAll("\\", "/")}`,
    Buffer.from(await Deno.readFile(entry.path)),
  );
}
zip.addFile(".image.tsv", Buffer.from(imageIndex.join("\n")));
let versionElements = 0;
const manifest = (await Deno.readTextFile(`${repoDir}/manifest.xml`)).replace(
  /<Version\b([^>]*?)\s*\/>/g,
  (_tag, attributes: string) => {
    versionElements++;
    if (!/\bnumber\s*=\s*(?:"[^"]+"|'[^']+')/.test(attributes)) {
      throw new Error("PoB manifest Version is missing its version number");
    }
    // Beta numbers include a commit suffix. Preserve that exact number while
    // marking this as an installed beta, so saves use /app/user rather than
    // the source ZIP filesystem selected by PoB's developer mode.
    const preserved = attributes.replace(/\s+(?:platform|branch)\s*=\s*(?:"[^"]*"|'[^']*')/g, "").trim();
    return `<Version ${preserved} platform="win32" branch="beta" />`;
  },
);
if (versionElements !== 1) throw new Error(`Expected one PoB manifest Version element, found ${versionElements}`);
zip.addFile("installed.cfg", Buffer.alloc(0));
zip.addFile("manifest.xml", Buffer.from(manifest));
for (const file of ["changelog.txt", "help.txt", "LICENSE.md"]) {
  zip.addFile(file, Buffer.from(await Deno.readFile(`${repoDir}/${file}`)));
}
// AdmZip otherwise records the wall clock for every entry.
for (const entry of zip.getEntries()) entry.header.time = new Date(2000, 0, 1);
const { manifest: payloadManifest, archives } = await createPackages(
  zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => ({
    path: entry.entryName,
    data: entry.getData(),
  })),
  pin.revision,
  zip.getEntries().filter((entry) => entry.isDirectory).map((entry) => entry.entryName.replace(/\/$/, "")),
);
let previous, predecessor;
try {
  previous = validatePayloadManifest(JSON.parse(await Deno.readTextFile(`${payloadDir}/manifest.json`)));
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
try {
  predecessor = validatePayloadManifest(JSON.parse(await Deno.readTextFile(`${payloadDir}/manifest.previous.json`)));
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
}
await ensureDir(`${payloadDir}/packages`);
for (const [hash, bytes] of archives) {
  const target = `${payloadDir}/packages/${hash}.zip`;
  try {
    if (await sha256(await Deno.readFile(target)) === hash) continue;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  // Do not truncate a content-addressed object an existing session may read.
  const next = `${payloadDir}/packages/${hash}.next.zip`;
  await Deno.writeFile(next, bytes);
  await Deno.rename(next, target);
}
// Keep the explicit legacy regeneration path until migration acceptance is complete.
await Deno.writeFile(`${payloadDir}/root.next.zip`, zip.toBuffer());
await Deno.rename(`${payloadDir}/root.next.zip`, `${payloadDir}/root.zip`);
await Deno.writeTextFile(`${payloadDir}/manifest.next.json`, JSON.stringify(payloadManifest));
if (previous) await Deno.writeTextFile(`${payloadDir}/manifest.previous.json`, JSON.stringify(previous));
await Deno.rename(`${payloadDir}/manifest.next.json`, `${payloadDir}/manifest.json`);
// Only previous manifest-owned hashes are eligible; never enumerate/delete the directory.
for (const hash of stalePackageHashes(payloadManifest, previous, predecessor)) {
  await Deno.remove(`${payloadDir}/packages/${hash}.zip`).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
}
console.log(`Packed ${zip.getEntries().length} entries and ${imageIndex.length} local images into ${payloadDir}`);

function ddsSize(bytes: Uint8Array) {
  const texture = parseDDSDX10(zstd.decompress(bytes));
  return { width: texture.extent[0], height: texture.extent[1] };
}
