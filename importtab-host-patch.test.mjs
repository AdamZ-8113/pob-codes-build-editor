import test from "node:test"; import assert from "node:assert/strict"; import { readFile } from "node:fs/promises"; import { createHash } from "node:crypto";
import { applyImportTabHostPatch } from "./importtab-host-patch.mjs";
test("checked ImportTab overlay hides OAuth without removing public/manual imports", async (t) => {
  const pin=JSON.parse(await readFile("source-pin.json","utf8")); const patch=await readFile(pin.adapters.importTabHostCapabilities.patchFile);
  assert.equal(createHash("sha256").update(patch).digest("hex"), pin.adapters.importTabHostCapabilities.patchSha256);
  const text=patch.toString(); assert.match(text,/PobHostCapabilities\.oauth/); assert.match(text,/sectionCharSiteImport/); assert.doesNotMatch(text,/^-.*addAccountNameControls/m); assert.doesNotMatch(text,/^-.*Build Sharing/m);
  let prepared;
  try { prepared=await readFile(".runtime/prepared/src/Classes/ImportTab.lua","utf8"); }
  catch (error) { if (error?.code === "ENOENT") { t.skip("prepared PoB checkout is not present"); return; } throw error; }
  const source=prepared.replaceAll("\r\n","\n");
  assert.doesNotThrow(()=>applyImportTabHostPatch(source,patch,pin.adapters.importTabHostCapabilities));
});
