import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { applyImportTabHostPatch } from "../../scripts/patches/importtab-host-patch.mjs";
import { applyPreferredExportSitePatch } from "../../scripts/patches/preferred-export-site-patch.mjs";

test("checked ImportTab overlay defaults the browser editor to PoB.Codes", async (t) => {
  const pin = JSON.parse(await readFile("source-pin.json", "utf8"));
  const hostPatch = await readFile(pin.adapters.importTabHostCapabilities.patchFile);
  const preferredPatch = await readFile(pin.adapters.preferredExportSite.patchFile);
  assert.equal(createHash("sha256").update(preferredPatch).digest("hex"), pin.adapters.preferredExportSite.patchSha256);
  assert.match(preferredPatch.toString(), /self\.exportWebsiteSelected or "PoBCodes"/);
  assert.doesNotMatch(preferredPatch.toString(), /table\.sort|sort\(/);
  let prepared;
  try { prepared = await readFile(".runtime/prepared/src/Classes/ImportTab.lua", "utf8"); }
  catch (error) { if (error?.code === "ENOENT") { t.skip("prepared PoB checkout is not present"); return; } throw error; }
  const hosted = applyImportTabHostPatch(prepared.replaceAll("\r\n", "\n"), hostPatch, pin.adapters.importTabHostCapabilities);
  assert.doesNotThrow(() => applyPreferredExportSitePatch(hosted, preferredPatch, pin.adapters.preferredExportSite));
});
