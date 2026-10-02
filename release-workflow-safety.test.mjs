import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectEligibleCiRun, verifyRequiredCiJobs } from "./scripts/verify-ci-eligibility.mjs";
import { bindPredecessorAssets } from "./scripts/verify-release-assets.mjs";

const sha = "a".repeat(40);

test("release CI eligibility requires an exact successful push/main run and both required jobs", () => {
  assert.throws(() => selectEligibleCiRun([], sha), /No completed successful/);
  assert.throws(() => selectEligibleCiRun([{ head_sha: sha, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success" }], sha), /No completed successful/);
  const run = selectEligibleCiRun([{ id: 41, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", updated_at: "2026-10-01" }], sha);
  assert.equal(run.id, 41);
  assert.throws(() => verifyRequiredCiJobs([{ name: "fast-gates", status: "completed", conclusion: "success" }]), /native-and-browser/);
  verifyRequiredCiJobs([
    { name: "fast-gates", status: "completed", conclusion: "success" },
    { name: "native-and-browser", status: "completed", conclusion: "success" },
  ]);
});

test("predecessor archive and inventory IDs must name assets of the selected release", () => {
  const release = { tag_name: "build-editor-abc", assets: [
    { id: 11, name: "pob-codes-build-editor-abc.tar.gz" },
    { id: 12, name: "release-inventory.json" },
    { id: 13, name: "release-record.json" },
  ] };
  assert.deepEqual(bindPredecessorAssets(release, { tag: release.tag_name, archiveAssetId: "11", inventoryAssetId: "12" }).record, release.assets[2]);
  assert.throws(() => bindPredecessorAssets(release, { tag: release.tag_name, archiveAssetId: "12", inventoryAssetId: "11" }), /Archive asset ID/);
  assert.throws(() => bindPredecessorAssets(release, { tag: "other", archiveAssetId: "11", inventoryAssetId: "12" }), /tag metadata/);
});

test("deployment workflow uses exact-SHA CI and numeric predecessor asset downloads", async () => {
  const workflow = await readFile(".github/workflows/deploy-import2.yml", "utf8");
  assert.match(workflow, /verify-ci-eligibility\.mjs --sha=/);
  assert.match(workflow, /predecessor_inventory_asset_id:/);
  assert.match(workflow, /releases\/assets\/\$ASSET_ID/);
  assert.match(workflow, /releases\/assets\/\$INVENTORY_ASSET_ID/);
  assert.match(workflow, /--inventory-asset-id="\$INVENTORY_ASSET_ID"/);
});
