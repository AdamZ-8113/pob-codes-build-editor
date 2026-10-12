import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDriftPatch, transformDriftPatch } from "./drift-patch.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blobSha1 = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

export function patchFiles(bytes, deduplicate = false) {
  const paths = [...bytes.toString().matchAll(/^diff --git a\/(.+) b\/[^\r\n]+$/gm)].map((match) => match[1]);
  return (deduplicate ? [...new Set(paths)] : paths).sort();
}

export async function validateSourceLedger(appDir, suppliedPinBytes) {
  const pinBytes = suppliedPinBytes ?? await readFile(join(appDir, "source-pin.json"));
  const pin = JSON.parse(pinBytes);
  if (pin.schemaVersion !== 2 || pin.compositePatch?.baseRevision !== pin.revision) {
    throw new Error("Unsupported desktop PoB source-pin schema or composite base");
  }
  const prNumbers = pin.overlays.filter((entry) => entry.kind === "upstream-pr").map((entry) => entry.number);
  if (JSON.stringify(prNumbers) !== JSON.stringify([10360, 10371, 10372, 10373, 10313, 10381])) {
    throw new Error("Desktop PoB upstream overlay order changed");
  }
  const sourceLocal = pin.overlays.filter((entry) => entry.kind === "local-patch" && entry.applicationStage === "source-composite");
  const relevance = sourceLocal[0];
  const environmentReuse = sourceLocal[1];
  const relevancePaths = ["spec/System/TestPowerReport_spec.lua", "src/Classes/CalcsTab.lua", "src/Classes/ModDB.lua", "src/Classes/ModList.lua", "src/Classes/ModStore.lua", "src/Modules/CalcActiveSkill.lua", "src/Modules/CalcMirages.lua", "src/Modules/CalcPerform.lua", "src/Modules/CalcRelevance.lua", "src/Modules/CalcSetup.lua", "src/Modules/CalcTriggers.lua", "src/Modules/Calcs.lua", "src/Modules/Common.lua"];
  const environmentPaths = ["spec/System/TestPowerReport_spec.lua", "src/Classes/CalcsTab.lua", "src/Modules/CalcPerform.lua", "src/Modules/CalcRelevance.lua", "src/Modules/CalcSetup.lua", "src/Modules/CalcSetupReuse.lua", "src/Modules/Calcs.lua"];
  const relevancePr = {
    number: 10383,
    url: "https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10383",
    head: "e6bc2a6322d1d3c1f268fcc2d7e06a82204b9fec",
    scope: "Power Report relevance pruning; excludes follow-on environment reuse",
  };
  if (sourceLocal.length !== 2 || relevance?.id !== "power-report-relevance-pruning" ||
      pin.overlays[6] !== relevance || relevance.patchFile !== "patches/power-report-relevance-pruning.patch" ||
      JSON.stringify(relevance.upstreamPr) !== JSON.stringify(relevancePr) ||
      JSON.stringify(relevance.files) !== JSON.stringify(relevancePaths) ||
      JSON.stringify(Object.keys(relevance.sourceBlobHashes ?? {})) !== JSON.stringify(relevancePaths) ||
      JSON.stringify(Object.keys(relevance.resultBlobHashes ?? {})) !== JSON.stringify(relevancePaths) ||
      relevancePaths.some(path => !pin.compositePatch.files.includes(path) ||
        !/^[a-f0-9]{40}$/.test(relevance.resultBlobHashes[path]) ||
        relevance.resultBlobHashes[path] !== (environmentReuse.sourceBlobHashes[path] ?? pin.compositePatch.resultBlobHashes[path])) ||
      relevancePaths.some(path => path === "src/Modules/CalcRelevance.lua"
        ? relevance.sourceBlobHashes[path] !== null : !/^[a-f0-9]{40}$/.test(relevance.sourceBlobHashes[path]))) {
    throw new Error("Power-report relevance source overlay identity or composition changed");
  }
  if (environmentReuse?.id !== "power-report-environment-reuse" || pin.overlays[7] !== environmentReuse ||
      environmentReuse.patchFile !== "patches/power-report-env-reuse.patch" ||
      JSON.stringify(environmentReuse.files) !== JSON.stringify(environmentPaths) ||
      JSON.stringify(Object.keys(environmentReuse.sourceBlobHashes ?? {})) !== JSON.stringify(environmentPaths) ||
      JSON.stringify(Object.keys(environmentReuse.resultBlobHashes ?? {})) !== JSON.stringify(environmentPaths) ||
      environmentPaths.some(path => !pin.compositePatch.files.includes(path) ||
        !/^[a-f0-9]{40}$/.test(environmentReuse.resultBlobHashes[path]) ||
        environmentReuse.resultBlobHashes[path] !== pin.compositePatch.resultBlobHashes[path]) ||
      environmentPaths.some(path => path === "src/Modules/CalcSetupReuse.lua"
        ? environmentReuse.sourceBlobHashes[path] !== null
        : !/^[a-f0-9]{40}$/.test(environmentReuse.sourceBlobHashes[path]) ||
          environmentReuse.sourceBlobHashes[path] !== relevance.resultBlobHashes[path])) {
    throw new Error("Power-report environment-reuse source overlay identity or composition changed");
  }
  const local = pin.overlays.filter((entry) => entry.kind === "local-patch" && entry.applicationStage !== "source-composite");
  if (JSON.stringify(local.map((overlay) => overlay.id)) !== JSON.stringify(["gem-dropdown-hover", "limited-unique-item-comparisons", "importtab-host-capabilities", "preferred-export-site", "calculation-only-jewel-specs", "node-power-delegation", "compact-status-text"]) ||
      local.some((overlay) => overlay.applicationStage !== "pack-time")) {
    throw new Error("Desktop PoB local overlay ownership changed");
  }
  const browserDefaults = pin.adapters.browserUiDefaults;
  const mainPath = "src/Modules/Main.lua";
  if (browserDefaults?.version !== 1 ||
      JSON.stringify(Object.keys(browserDefaults.sourceBlobHashes ?? {})) !== JSON.stringify([mainPath]) ||
      JSON.stringify(Object.keys(browserDefaults.resultBlobHashes ?? {})) !== JSON.stringify([mainPath]) ||
      browserDefaults.sourceBlobHashes[mainPath] !== pin.adapters.calculationScheduling.resultBlobHashes[mainPath] ||
      !/^[a-f0-9]{40}$/.test(browserDefaults.resultBlobHashes[mainPath])) {
    throw new Error("Browser UI defaults adapter identity changed");
  }
  const overlayBytes = [];
  for (const overlay of pin.overlays) {
    const bytes = await readFile(join(appDir, overlay.patchFile));
    if (sha256(bytes) !== overlay.patchSha256) throw new Error(`${overlay.kind} ${overlay.number ?? overlay.id} patch SHA-256 mismatch`);
    if (JSON.stringify(patchFiles(bytes)) !== JSON.stringify([...overlay.files].sort())) {
      throw new Error(`${overlay.kind} ${overlay.number ?? overlay.id} file inventory mismatch`);
    }
    overlayBytes.push(bytes);
  }
  if (pin.adapters.gemDropdownHover.patchSha256 !== local[0].patchSha256 ||
      pin.adapters.gemDropdownHover.patchFile !== local[0].patchFile) {
    throw new Error("Gem-hover overlay and pack-time adapter identities differ");
  }
  if (pin.adapters.limitedUniqueItemComparisons.patchSha256 !== local[1].patchSha256 ||
      pin.adapters.limitedUniqueItemComparisons.patchFile !== local[1].patchFile) {
    throw new Error("Item-comparison overlay and pack-time adapter identities differ");
  }
  const jewel = pin.adapters.calculationOnlyJewelSpecs;
  const importTab = pin.adapters.importTabHostCapabilities;
  if (importTab?.version !== 1 || importTab.patchSha256 !== local[2].patchSha256 || importTab.patchFile !== local[2].patchFile) {
    throw new Error("ImportTab host-capability overlay identity differs");
  }
  const preferredExportSite = pin.adapters.preferredExportSite;
  if (preferredExportSite?.version !== 1 || preferredExportSite.patchSha256 !== local[3].patchSha256 ||
      preferredExportSite.patchFile !== local[3].patchFile ||
      preferredExportSite.preparedSourceBlobHashes["src/Classes/ImportTab.lua"] !== importTab.sourceBlobHashes["src/Classes/ImportTab.lua"] ||
      preferredExportSite.sourceBlobHashes["src/Classes/ImportTab.lua"] !== importTab.resultBlobHashes["src/Classes/ImportTab.lua"]) {
    throw new Error("Preferred export-site overlay identity or chain differs");
  }
  const jewelOverlay = local[4];
  if (jewel?.version !== 1 || jewel.patchSha256 !== jewelOverlay.patchSha256 ||
      jewel.patchFile !== jewelOverlay.patchFile) {
    throw new Error("Jewel-spec overlay and pack-time adapter identities differ");
  }
  const upstreamPr = {
    number: 9863,
    url: "https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863",
    head: "5cafb7f4f05299f08f2e68e6aadfd13396c71642",
    scope: "Narrow calculation-only temporary jewel-spec subset; excludes output-cache and CompareTab changes",
  };
  const localChanges = ["Omit unused nodeCopy.power allocation only in temporary jewel-comparison clones; this addition is not part of upstream PR #9863"];
  if (JSON.stringify(jewel.upstreamPr) !== JSON.stringify(upstreamPr) ||
      JSON.stringify(jewelOverlay.upstreamPr) !== JSON.stringify(upstreamPr) ||
      JSON.stringify(jewel.localChanges) !== JSON.stringify(localChanges) ||
      JSON.stringify(jewelOverlay.localChanges) !== JSON.stringify(localChanges)) {
    throw new Error("Jewel-spec upstream subset or local allocation provenance changed");
  }
  const itemsPath = "src/Classes/ItemsTab.lua";
  const passivePath = "src/Classes/PassiveSpec.lua";
  const jewelPaths = [itemsPath, passivePath];
  for (const identities of [jewel.preparedSourceBlobHashes, jewel.sourceBlobHashes, jewel.resultBlobHashes]) {
    if (JSON.stringify(Object.keys(identities ?? {}).sort()) !== JSON.stringify(jewelPaths) ||
        Object.values(identities).some((hash) => !/^[a-f0-9]{40}$/.test(hash))) {
      throw new Error("Jewel-spec source identity inventory changed");
    }
  }
  if (jewel.preparedSourceBlobHashes[itemsPath] !== pin.adapters.limitedUniqueItemComparisons.sourceBlobHashes[itemsPath] ||
      jewel.sourceBlobHashes[itemsPath] !== pin.adapters.limitedUniqueItemComparisons.resultBlobHashes[itemsPath] ||
      jewel.preparedSourceBlobHashes[passivePath] !== jewel.sourceBlobHashes[passivePath]) {
    throw new Error("Jewel-spec pack-time overlay chain changed");
  }
  const nodePower = pin.adapters.nodePowerDelegation;
  const nodeOverlay = local[5];
  const calcsPath = "src/Classes/CalcsTab.lua";
  if (nodePower?.version !== 1 || nodePower.patchFile !== nodeOverlay.patchFile ||
      nodePower.patchSha256 !== nodeOverlay.patchSha256 ||
      nodePower.sourceBlobHashes?.[calcsPath] !== pin.compositePatch.resultBlobHashes[calcsPath] ||
      !/^[a-f0-9]{40}$/.test(nodePower.resultBlobHashes?.[calcsPath] ?? '') ||
      Object.keys(nodePower.sourceBlobHashes).length !== 1 || Object.keys(nodePower.resultBlobHashes).length !== 1) {
    throw new Error("Node-power overlay identities differ");
  }
  const compactStatus = pin.adapters.compactStatusText;
  const compactOverlay = local[6];
  const compactPaths = ["src/Classes/GemSelectControl.lua", "src/Classes/TreeTab.lua", "src/Modules/ToastNotification.lua"];
  if (compactStatus?.version !== 1 || compactStatus.patchFile !== compactOverlay.patchFile ||
      compactStatus.patchSha256 !== compactOverlay.patchSha256 ||
      JSON.stringify(Object.keys(compactStatus.preparedSourceBlobHashes ?? {}).sort()) !== JSON.stringify(compactPaths) ||
      JSON.stringify(Object.keys(compactStatus.sourceBlobHashes ?? {}).sort()) !== JSON.stringify(compactPaths) ||
      JSON.stringify(Object.keys(compactStatus.resultBlobHashes ?? {}).sort()) !== JSON.stringify(compactPaths) ||
      compactStatus.preparedSourceBlobHashes[compactPaths[0]] !== pin.compositePatch.resultBlobHashes[compactPaths[0]] ||
      compactStatus.sourceBlobHashes[compactPaths[0]] !== pin.adapters.gemDropdownHover.resultBlobHashes[compactPaths[0]] ||
      compactStatus.sourceBlobHashes[compactPaths[1]] !== pin.compositePatch.resultBlobHashes[compactPaths[1]] ||
      Object.values(compactStatus.resultBlobHashes).some((hash) => !/^[a-f0-9]{40}$/.test(hash))) {
    throw new Error("Compact status-text overlay identities differ");
  }
  const compositeBytes = await readFile(join(appDir, pin.compositePatch.patchFile));
  if (sha256(compositeBytes) !== pin.compositePatch.patchSha256) throw new Error("PoB PR composite patch SHA-256 mismatch");
  if (JSON.stringify(patchFiles(compositeBytes, true)) !== JSON.stringify([...pin.compositePatch.files].sort())) {
    throw new Error("PoB PR composite file inventory mismatch");
  }
  return { pin, pinBytes, overlayBytes, compositeBytes };
}

// Prove the prepared composite contains each local source patch in order,
// including every intermediate source identity. Never edit the prepared tree.
export async function validatePreparedRelevance(appDir, sourceDir, pin) {
  const overlays = pin.overlays.filter(entry => entry.kind === "local-patch" && entry.applicationStage === "source-composite");
  const source = new Map();
  for (const path of new Set(overlays.flatMap(overlay => overlay.files))) {
    source.set(path, await readFile(join(sourceDir, path), "utf8"));
  }
  for (const overlay of [...overlays].reverse()) {
    const patch = await readFile(join(appDir, overlay.patchFile), "utf8");
    const sections = parseDriftPatch(patch);
    const positions = patch.split(/^diff --git /m).slice(1).map(section =>
      [...section.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)].map(match => Number(match[1]) - 1));
    for (const [index, section] of sections.entries()) {
      const current = source.get(section.path);
      if (current === undefined || blobSha1(current) !== overlay.resultBlobHashes[section.path]) {
        throw new Error(`Power-report source composition changed: ${section.path}`);
      }
      if (section.added) {
        if (overlay.sourceBlobHashes[section.path] !== null || current !== section.blocks[0].after) {
          throw new Error(`Power-report source composition changed: ${section.path}`);
        }
        source.delete(section.path);
        continue;
      }
      const reversed = {
        ...section,
        blocks: [...section.blocks].reverse().map(({ before, after }) => ({ before: after, after: before })),
      };
      let original;
      try {
        // Follow-on patches can retain exact unique context at a line offset
        // when an earlier PR changed an unrelated part of the same file.
        original = transformDriftPatch({ [section.path]: current }, [reversed])[section.path];
      } catch (error) {
        if (error.message !== "patch-context") throw error;
        // Fixed positions handle repeated modifier-store boilerplate without
        // fuzzy matching. Complete pre/post blobs remain identity checked.
        const lines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        for (let i = section.blocks.length - 1; i >= 0; i--) {
          const { before, after } = section.blocks[i];
          const count = (after.match(/[^\n]*\n|[^\n]+$/g) ?? []).length;
          const start = positions[index][i];
          if (lines.slice(start, start + count).join("") !== after) {
            throw new Error(`Power-report patch context changed: ${section.path}`);
          }
          lines.splice(start, count, ...(before.match(/[^\n]*\n|[^\n]+$/g) ?? []));
        }
        original = lines.join("");
      }
      if (blobSha1(original) !== overlay.sourceBlobHashes[section.path]) {
        throw new Error(`Power-report source composition changed: ${section.path}`);
      }
      source.set(section.path, original);
    }
  }
}
