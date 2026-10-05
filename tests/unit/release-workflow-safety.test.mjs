import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectEligibleCiRun, verifyRequiredCiJobs } from "../../scripts/release/verify-ci-eligibility.mjs";
import { bindPredecessorAssets } from "../../scripts/release/verify-release-assets.mjs";

const sha = "a".repeat(40);

test("release CI eligibility requires an exact successful push/main run and all three required jobs", () => {
  assert.throws(() => selectEligibleCiRun([], sha), /No completed successful/);
  assert.throws(() => selectEligibleCiRun([{ head_sha: sha, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success" }], sha), /No completed successful/);
  const run = selectEligibleCiRun([{ id: 41, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", updated_at: "2026-10-01" }], sha);
  assert.equal(run.id, 41);
  assert.throws(() => verifyRequiredCiJobs([{ name: "fast-gates", status: "completed", conclusion: "success" }]), /native-and-browser/);
  const existingJobs = [
    { name: "fast-gates", status: "completed", conclusion: "success" },
    { name: "native-and-browser", status: "completed", conclusion: "success" },
  ];
  assert.throws(() => verifyRequiredCiJobs(existingJobs), /browser-harnesses/);
  const browserJob = { name: "browser-harnesses", status: "completed", conclusion: "success" };
  verifyRequiredCiJobs([...existingJobs, browserJob]);
  for (const invalid of [
    { ...browserJob, conclusion: "failure" },
    { ...browserJob, conclusion: "skipped" },
    { ...browserJob, conclusion: "cancelled" },
    { ...browserJob, status: "in_progress", conclusion: null },
  ]) assert.throws(() => verifyRequiredCiJobs([...existingJobs, invalid]), /browser-harnesses/);
  assert.throws(() => verifyRequiredCiJobs([...existingJobs, browserJob, browserJob]), /browser-harnesses/);
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

test("public release workflow exports verified bytes without production authority", async () => {
  const workflow = await readFile(".github/workflows/deploy-import2.yml", "utf8");
  assert.match(workflow, /verify-ci-eligibility\.mjs --sha=/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /archive-release\.mjs/);
  assert.match(workflow, /npm run verify:release/);
  assert.match(workflow, /npm run test:e2e:release/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.doesNotMatch(workflow, /secrets\.|CLOUDFLARE_|wrangler deploy|environment:|contents: write|publish-and-deploy|--retain/);
  assert.doesNotMatch(workflow, /inputs\.deploy|predecessor_tag:/);
});

test("CI and artifact browser gates test a materialized candidate using bundled Chromium", async () => {
  for (const path of [".github/workflows/ci.yml", ".github/workflows/deploy-import2.yml"]) {
    const workflow = await readFile(path, "utf8");
    assert.ok(workflow.indexOf("materialize-import2.mjs") < workflow.indexOf("npm run test:e2e:release"));
    assert.match(workflow, /playwright install --with-deps chromium/);
    assert.match(workflow, /npm run test:e2e:release/);
    assert.match(workflow, /if: failure\(\)\s+uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(workflow, /test-results\/\*\*\/test-failed-\*\.png/);
    assert.match(workflow, /test-results\/\*\*\/error-context\.md/);
  }
  const config = (await import("../../playwright.release.config.mjs")).default;
  assert.equal(config.use.baseURL, "http://127.0.0.1:3011");
  assert.equal(config.use.channel, undefined);
  assert.equal(config.use.headless, true);
  assert.equal(config.use.serviceWorkers, "block");
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.webServer.command, "node scripts/release/serve-test-release.mjs");
});
