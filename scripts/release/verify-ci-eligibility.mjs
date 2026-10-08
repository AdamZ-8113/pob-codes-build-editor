import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const REQUIRED_CI_JOBS = ["fast-gates", "native-and-browser", "browser-harnesses"];
const MAX_CANDIDATE_ARTIFACT_BYTES = 1_400 * 1024 * 1024;

const fullSha = value => /^[a-f0-9]{40}$/.test(value);

export function ciCandidateArtifactName(targetSha, runId, runAttempt) {
  if (!fullSha(targetSha)) throw new Error("Target must be a full lowercase Git SHA");
  if (!Number.isInteger(Number(runId)) || Number(runId) < 1) throw new Error("CI run ID is invalid");
  if (!Number.isInteger(Number(runAttempt)) || Number(runAttempt) < 1) throw new Error("CI run attempt is invalid");
  return `ci-candidate-${targetSha}-${runId}-${runAttempt}`;
}

export function selectEligibleCiRun(runs, targetSha, repository) {
  if (!fullSha(targetSha)) throw new Error("Target must be a full lowercase Git SHA");
  const eligible = runs.filter((run) => run.head_sha === targetSha && run.head_branch === "main" &&
    run.event === "push" && run.status === "completed" && run.conclusion === "success" &&
    (!repository || (run.path === CI_WORKFLOW_PATH && run.repository?.full_name === repository &&
      run.head_repository?.full_name === repository)));
  if (eligible.length === 0) throw new Error(`No completed successful ci.yml push/main run exists for ${targetSha}`);
  return eligible.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || Number(b.id) - Number(a.id))[0];
}

export function verifyRequiredCiJobs(jobs, runAttempt) {
  if (!Number.isInteger(Number(runAttempt)) || Number(runAttempt) < 1) throw new Error("CI run attempt is invalid");
  for (const name of REQUIRED_CI_JOBS) {
    const matches = jobs.filter((job) => job.name === name && Number(job.run_attempt) === Number(runAttempt));
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`Required ci.yml job did not complete successfully in attempt ${runAttempt}: ${name}`);
    }
  }
}

export function selectCiCandidateArtifact(artifacts, { repositoryId, runId, runAttempt, targetSha }) {
  const expectedName = ciCandidateArtifactName(targetSha, runId, runAttempt);
  const matches = artifacts.filter(artifact => artifact.name === expectedName);
  if (matches.length !== 1) throw new Error(`CI run must contain exactly one candidate artifact named ${expectedName}`);
  const artifact = matches[0];
  if (!Number.isInteger(Number(artifact.id)) || Number(artifact.id) < 1) throw new Error("CI candidate artifact ID is invalid");
  if (!Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_CANDIDATE_ARTIFACT_BYTES) {
    throw new Error("CI candidate artifact size is missing or exceeds the transfer budget");
  }
  if (artifact.expired) throw new Error("CI candidate artifact has expired; run a new full push/main CI producer before promotion");
  if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")) throw new Error("CI candidate artifact digest is missing or invalid");
  if (Number(artifact.workflow_run?.id) !== Number(runId) || artifact.workflow_run?.head_sha !== targetSha ||
      artifact.workflow_run?.head_branch !== "main" ||
      (repositoryId && Number(artifact.workflow_run?.repository_id) !== Number(repositoryId)) ||
      (repositoryId && Number(artifact.workflow_run?.head_repository_id) !== Number(repositoryId))) {
    throw new Error("CI candidate artifact is not bound to the selected repository, run, branch, and SHA");
  }
  return artifact;
}

function ghJson(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? `gh api exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function ghItems(path, key) {
  const items = [];
  for (let page = 1; ; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = ghJson(`${path}${separator}per_page=100&page=${page}`)[key] ?? [];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export function verifyCiEligibility({ repository, targetSha }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is invalid");
  const repositoryMetadata = ghJson(`repos/${repository}`);
  const runs = ghItems(`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&branch=main&event=push&status=completed`, "workflow_runs");
  const run = selectEligibleCiRun(runs, targetSha, repository);
  const jobs = ghItems(`repos/${repository}/actions/runs/${run.id}/jobs?filter=all`, "jobs");
  verifyRequiredCiJobs(jobs, run.run_attempt);
  const artifacts = ghItems(`repos/${repository}/actions/runs/${run.id}/artifacts`, "artifacts");
  const artifact = selectCiCandidateArtifact(artifacts, {
    repositoryId: repositoryMetadata.id,
    runId: run.id,
    runAttempt: run.run_attempt,
    targetSha,
  });
  return { run, artifact };
}

function writeOutputs(file, run, artifact) {
  for (const [name, value] of Object.entries({
    "source-run-id": run.id,
    "source-run-attempt": run.run_attempt,
    "source-artifact-id": artifact.id,
    "source-artifact-name": artifact.name,
    "source-artifact-digest": artifact.digest,
    "source-artifact-size": artifact.size_in_bytes,
  })) appendFileSync(file, `${name}=${value}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const targetSha = process.argv.find((argument) => argument.startsWith("--sha="))?.slice(6) ?? "";
  const output = process.argv.find((argument) => argument.startsWith("--github-output="))?.slice(16);
  const { run, artifact } = verifyCiEligibility({ repository, targetSha });
  if (output) writeOutputs(resolve(output), run, artifact);
  console.log(`Verified ci.yml push/main run ${run.id} attempt ${run.run_attempt} and artifact ${artifact.id} for ${targetSha}.`);
}
