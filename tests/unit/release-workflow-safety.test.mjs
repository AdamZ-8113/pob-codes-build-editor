import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ciCandidateArtifactName,
  selectCiCandidateArtifact,
  selectEligibleCiRun,
  verifyRequiredCiJobs,
} from "../../scripts/release/verify-ci-eligibility.mjs";
import { validateArtifactZipEntries } from "../../scripts/release/download-ci-candidate.mjs";
import { formatReleaseBrowserSummary } from "../../scripts/release/summarize-release-browser.mjs";
import ReleaseBrowserReporter, { compactSteps } from "../../scripts/release/release-browser-reporter.mjs";
import { bindPredecessorAssets } from "../../scripts/release/verify-release-assets.mjs";

const sha = "a".repeat(40);

test("drift workflow has only read authority and uploads only its data report even on conflict", async () => {
  const workflow = await readFile(".github/workflows/upstream-drift.yml", "utf8");
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/report.json/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /--ref "\$TARGET_REF"/);
  assert.doesNotMatch(workflow, /secrets\.|DISCORD|webhook|npm ci|deploy|contents: write|pull_request:/i);
  const actions = [...workflow.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  assert.equal(actions.length, 3);
  const ci = await readFile(".github/workflows/ci.yml", "utf8");
  for (const action of actions) {
    assert.match(action, /@[a-f0-9]{40}$/);
    assert.ok(ci.includes(action));
  }
});

test("release CI eligibility requires an exact successful push/main run and all three required jobs", () => {
  const repository = "AdamZ-8113/pob-codes-build-editor";
  const identity = { path: ".github/workflows/ci.yml", repository: { full_name: repository }, head_repository: { full_name: repository } };
  assert.throws(() => selectEligibleCiRun([], sha), /No completed successful/);
  assert.throws(() => selectEligibleCiRun([{ head_sha: sha, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success" }], sha), /No completed successful/);
  const eligible = { id: 41, run_attempt: 2, head_sha: sha, head_branch: "main", event: "push", status: "completed", conclusion: "success", updated_at: "2026-10-01", ...identity };
  const run = selectEligibleCiRun([eligible], sha, repository);
  assert.equal(run.id, 41);
  for (const changed of [
    { path: ".github/workflows/other.yml" },
    { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } },
  ]) assert.throws(() => selectEligibleCiRun([{ ...eligible, ...changed }], sha, repository), /No completed successful/);
  assert.throws(() => verifyRequiredCiJobs([{ name: "fast-gates", run_attempt: 2, status: "completed", conclusion: "success" }], 2), /native-and-browser/);
  const existingJobs = [
    { name: "fast-gates", run_attempt: 2, status: "completed", conclusion: "success" },
    { name: "native-and-browser", run_attempt: 2, status: "completed", conclusion: "success" },
  ];
  assert.throws(() => verifyRequiredCiJobs(existingJobs, 2), /browser-harnesses/);
  const browserJob = { name: "browser-harnesses", run_attempt: 2, status: "completed", conclusion: "success" };
  verifyRequiredCiJobs([...existingJobs, browserJob], 2);
  assert.throws(() => verifyRequiredCiJobs([...existingJobs, { ...browserJob, run_attempt: 1 }], 2), /browser-harnesses/);
  for (const invalid of [
    { ...browserJob, conclusion: "failure" },
    { ...browserJob, conclusion: "skipped" },
    { ...browserJob, conclusion: "cancelled" },
    { ...browserJob, status: "in_progress", conclusion: null },
  ]) assert.throws(() => verifyRequiredCiJobs([...existingJobs, invalid], 2), /browser-harnesses/);
  assert.throws(() => verifyRequiredCiJobs([...existingJobs, browserJob, browserJob], 2), /browser-harnesses/);

  const name = ciCandidateArtifactName(sha, 41, 2);
  const artifact = { id: 51, name, size_in_bytes: 700_000_000, expired: false, digest: `sha256:${"b".repeat(64)}`,
    workflow_run: { id: 41, head_sha: sha, head_branch: "main", repository_id: 7, head_repository_id: 7 } };
  assert.equal(selectCiCandidateArtifact([artifact], { repositoryId: 7, runId: 41, runAttempt: 2, targetSha: sha }).id, 51);
  for (const invalid of [
    { ...artifact, expired: true },
    { ...artifact, digest: null },
    { ...artifact, id: null },
    { ...artifact, size_in_bytes: 2_000_000_000 },
    { ...artifact, workflow_run: { ...artifact.workflow_run, id: 42 } },
  ]) assert.throws(() => selectCiCandidateArtifact([invalid], { repositoryId: 7, runId: 41, runAttempt: 2, targetSha: sha }), /expired|digest|ID|size|bound/);
  assert.throws(() => selectCiCandidateArtifact([artifact, artifact], { repositoryId: 7, runId: 41, runAttempt: 2, targetSha: sha }), /exactly one/);
});

test("candidate artifact zip accepts only the exact safe release tuple", () => {
  const entries = ["release-record.json", "release-inventory.json", `release-assets/pob-codes-build-editor-${"c".repeat(24)}.tar.gz`];
  assert.equal(validateArtifactZipEntries(entries).length, 3);
  for (const invalid of [
    [...entries, "extra.txt"],
    [entries[0], entries[0], entries[2]],
    ["../release-record.json", entries[1], entries[2]],
    [entries[0], entries[1], "release-assets/candidate.tar.gz"],
  ]) assert.throws(() => validateArtifactZipEntries(invalid), /unsafe|exact release candidate tuple/);
});

test("release-browser summary distinguishes a flaky success and reports finite budget utilization", () => {
  const title = "candidate acceptance";
  const markdown = formatReleaseBrowserSummary({ schemaVersion: 1, status: "passed", attempts: [
    { title, timeoutMs: 240_000, retry: 0, status: "timedOut", durationMs: 180_000, steps: [{ title: "After Hooks", durationMs: 12_000 }] },
    { title, timeoutMs: 240_000, retry: 1, status: "passed", durationMs: 150_000, steps: [{ title: "After Hooks", durationMs: 6_000 }] },
  ] }, [
    { title, retry: 0, testBudgetMs: 240_000, utilization: 0.75, phases: [{ utilization: 0.9 }] },
    { title, retry: 1, testBudgetMs: 240_000, utilization: 0.625, phases: [{ utilization: 0.7 }] },
  ]);
  assert.match(markdown, /flaky success/);
  assert.match(markdown, /75\.0%/);
  assert.match(markdown, /90\.0%/);
  assert.match(markdown, /62\.5%/);
  assert.match(markdown, /5\.0%/);
  assert.deepEqual(compactSteps([
    { title: "phase", category: "test.step", duration: 10, steps: [{ title: "Evaluate", category: "pw:api", duration: 9 }] },
    { title: "After Hooks", category: "hook", duration: 3, steps: [{ title: "context", category: "fixture", duration: 2 }] },
  ]), [
    { title: "phase", category: "test.step", durationMs: 10, error: null, steps: [] },
    { title: "After Hooks", category: "hook", durationMs: 3, error: null, steps: [{ title: "context", category: "fixture", durationMs: 2, error: null, steps: [] }] },
  ]);
});

test("two release tests passing first try are not a flaky success", () => {
  const markdown = formatReleaseBrowserSummary({ schemaVersion: 1, status: "passed", attempts: [
    { title: "pagehide", timeoutMs: 240_000, retry: 0, status: "passed", durationMs: 5_000 },
    { title: "candidate acceptance", timeoutMs: 240_000, retry: 0, status: "passed", durationMs: 150_000 },
  ] }, []);
  assert.doesNotMatch(markdown, /flaky success/);
  assert.match(markdown, /passed on the first attempt/);
});

test("release reports bind repeated runs to their own phase timings", async t => {
  const directory = await mkdtemp(join(tmpdir(), "editor-release-reporter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputFile = join(directory, "summary.json");
  const reporter = new ReleaseBrowserReporter({ outputFile });
  const title = "native acceptance";
  for (const repeatEachIndex of [0, 1]) {
    reporter.onTestEnd({ title, timeout: 240_000, repeatEachIndex }, {
      retry: 0, status: "passed", duration: 60_000, errors: [], steps: [],
    });
  }
  reporter.onEnd({ status: "passed" });
  const summary = JSON.parse(await readFile(outputFile, "utf8"));
  assert.deepEqual(summary.attempts.map(attempt => attempt.repeatEachIndex), [0, 1]);
  const timings = [0, 1].map(repeatEachIndex => ({
    title, retry: 0, repeatEachIndex, testBudgetMs: 240_000,
    phases: [{ name: "reload", outcome: "passed", budgetMs: 90_000,
      elapsedMs: (repeatEachIndex + 1) * 20_000, utilization: (repeatEachIndex + 1) * 20_000 / 90_000 }],
  }));
  const markdown = formatReleaseBrowserSummary(summary, timings);
  assert.match(markdown, /native acceptance \| 1 \| 1 \| passed \| 60\.0s \| 25\.0% \| 22\.2%/);
  assert.match(markdown, /native acceptance \| 2 \| 1 \| passed \| 60\.0s \| 25\.0% \| 44\.4%/);
  assert.match(markdown, /native acceptance \| 2 \| 1 \| reload \| passed \| 40\.0s \/ 90\.0s/);
  assert.doesNotMatch(markdown, /flaky success/);
});

test("a passing diagnostic test cannot hide a later acceptance failure", () => {
  const markdown = formatReleaseBrowserSummary({ schemaVersion: 1, status: "failed", attempts: [
    { title: "diagnostics", retry: 0, status: "passed", durationMs: 2_000 },
    { title: "native acceptance", retry: 0, status: "timedOut", durationMs: 90_000 },
  ] }, []);
  assert.match(markdown, /Result: failed; release acceptance did not pass/);
  assert.doesNotMatch(markdown, /Result: .*passed on the first attempt/);
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

test("manual release workflow promotes one exact CI artifact without rebuilding or production authority", async () => {
  const workflow = await readFile(".github/workflows/deploy-import2.yml", "utf8");
  assert.match(workflow, /verify-ci-eligibility\.mjs --sha=/);
  assert.match(workflow, /download-ci-candidate\.mjs/);
  assert.match(workflow, /verify-release-candidate\.mjs --bundle-root=/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(workflow, /name: build-editor-\$\{\{ inputs\.commit_sha \}\}/);
  assert.doesNotMatch(workflow, /setup-node|setup-deno|npm (ci|run)|materialize-import2|create-release-record|archive-release|playwright|test:e2e|test:native|\bpack\b/);
  assert.doesNotMatch(workflow, /secrets\.|CLOUDFLARE_|wrangler deploy|environment:|contents: write|publish-and-deploy|--retain/);
  assert.doesNotMatch(workflow, /inputs\.deploy|predecessor_tag:/);
});

test("push/main CI builds, verifies, tests, reverifies and publishes one canonical candidate", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const command of ["materialize-import2.mjs", "create-release-record.mjs", "archive-release.mjs", "npm run test:e2e:release"]) assert.match(workflow, new RegExp(command.replaceAll(".", "\\.")));
  assert.ok(workflow.indexOf("archive-release.mjs") < workflow.indexOf("npm run test:e2e:release"));
  assert.match(workflow, /npm run test:e2e:release -- --repeat-each=2 --retries=0/);
  assert.equal([...workflow.matchAll(/npm run verify:release/g)].length, 2);
  const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;
  assert.match(scripts["verify:release"], /verify-release-candidate\.mjs/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ci-candidate-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /compression-level: 0/);
  assert.match(workflow, /candidate-browser-diagnostics-/);
  assert.match(workflow, /release-phase-timings\.json/);
  assert.match(workflow, /release-browser-summary\.json/);
  const config = (await import("../../playwright.release.config.mjs")).default;
  assert.equal(config.timeout, 240_000);
  assert.equal(config.retries, 0);
  assert.equal(config.use.baseURL, "http://127.0.0.1:3011");
  assert.equal(config.use.channel, undefined);
  assert.equal(config.use.headless, true);
  assert.equal(config.use.serviceWorkers, "block");
  assert.equal(config.webServer.reuseExistingServer, false);
  assert.equal(config.webServer.command, "node scripts/release/serve-test-release.mjs");
});
