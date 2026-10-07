import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function patchFiles(bytes) {
  return [...bytes.toString().matchAll(/^diff --git a\/(.+) b\/[^\r\n]+$/gm)].map((match) => match[1]).sort();
}

export async function validateSourceLedger(appDir, suppliedPinBytes) {
  const pinBytes = suppliedPinBytes ?? await readFile(join(appDir, "source-pin.json"));
  const pin = JSON.parse(pinBytes);
  if (pin.schemaVersion !== 2 || pin.compositePatch?.baseRevision !== pin.revision) {
    throw new Error("Unsupported desktop PoB source-pin schema or composite base");
  }
  const prNumbers = pin.overlays.filter((entry) => entry.kind === "upstream-pr").map((entry) => entry.number);
  if (JSON.stringify(prNumbers) !== JSON.stringify([10360, 10371, 10372, 10373, 10313])) {
    throw new Error("Desktop PoB upstream overlay order changed");
  }
  const local = pin.overlays.filter((entry) => entry.kind === "local-patch");
  if (JSON.stringify(local.map((overlay) => overlay.id)) !== JSON.stringify(["gem-dropdown-hover", "limited-unique-item-comparisons", "importtab-host-capabilities", "preferred-export-site", "calculation-only-jewel-specs", "node-power-delegation", "compact-status-text"]) ||
      local.some((overlay) => overlay.applicationStage !== "pack-time")) {
    throw new Error("Desktop PoB local overlay ownership changed");
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
  if (JSON.stringify(patchFiles(compositeBytes)) !== JSON.stringify([...pin.compositePatch.files].sort())) {
    throw new Error("PoB PR composite file inventory mismatch");
  }
  return { pin, pinBytes, overlayBytes, compositeBytes };
}
