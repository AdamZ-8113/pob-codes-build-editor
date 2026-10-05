import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function selectEligibleCiRun(runs, targetSha) {
  if (!/^[a-f0-9]{40}$/.test(targetSha)) throw new Error("Target must be a full lowercase Git SHA");
  const eligible = runs.filter((run) => run.head_sha === targetSha && run.head_branch === "main" &&
    run.event === "push" && run.status === "completed" && run.conclusion === "success");
  if (eligible.length === 0) throw new Error(`No completed successful ci.yml push/main run exists for ${targetSha}`);
  return eligible.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
}

export function verifyRequiredCiJobs(jobs) {
  for (const name of ["fast-gates", "native-and-browser", "browser-harnesses"]) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].status !== "completed" || matches[0].conclusion !== "success") {
      throw new Error(`Required ci.yml job did not complete successfully: ${name}`);
    }
  }
}

function ghJson(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim() ?? `gh api exited ${result.status}`);
  return JSON.parse(result.stdout);
}

export function verifyCiEligibility({ repository, targetSha }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is invalid");
  const query = `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&branch=main&event=push&status=completed&per_page=100`;
  const run = selectEligibleCiRun(ghJson(query).workflow_runs ?? [], targetSha);
  const jobs = ghJson(`repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).jobs ?? [];
  verifyRequiredCiJobs(jobs);
  return run;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const targetSha = process.argv.find((argument) => argument.startsWith("--sha="))?.slice(6) ?? "";
  const run = verifyCiEligibility({ repository, targetSha });
  console.log(`Verified ci.yml push/main run ${run.id} for ${targetSha}.`);
}
