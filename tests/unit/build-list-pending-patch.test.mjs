import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { applyBuildListPendingPatch } from "../../scripts/patches/build-list-pending-patch.mjs";

test("checked build-list adapter hides sentinel-bearing import folders", async (t) => {
  const pin = JSON.parse(await readFile("source-pin.json", "utf8"));
  const adapter = pin.adapters.buildListPendingFolders;
  const patch = await readFile(adapter.patchFile);
  assert.equal(createHash("sha256").update(patch).digest("hex"), adapter.patchSha256);
  assert.match(patch.toString(), /\.pob-codes-import\.pending/);
  let source;
  try {
    source = await readFile(".runtime/source-fef5c4f1ddf9/src/Modules/BuildListHelpers.lua", "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") { t.skip("pinned PoB source is not present"); return; }
    throw error;
  }
  const result = applyBuildListPendingPatch(source.replaceAll("\r\n", "\n"), patch, adapter);
  assert.match(result, /if pending then\n\s+pending:close\(\)\n\s+else/);
  assert.equal(result.match(/\.pob-codes-import\.pending/g)?.length, 1);
});
