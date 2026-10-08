import { appendFile, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function phaseFiles(root) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "release-phase-timings.json") found.push(path);
    }
  }
  await visit(root);
  return found;
}

export function formatReleaseBrowserSummary(summary, timings) {
  if (summary?.schemaVersion !== 1 || !Array.isArray(summary.attempts) || !summary.attempts.length) throw new Error("Release-browser reporter produced no attempts");
  const lines = ["### Release-browser acceptance", "", `Overall outcome: **${summary.status}**`, "", "| Attempt | Outcome | Duration | Test budget utilization | Highest phase utilization | Teardown budget utilization |", "| --- | --- | ---: | ---: | ---: | ---: |"];
  for (const attempt of summary.attempts) {
    const timing = timings.find(item => item.retry === attempt.retry && item.title === attempt.title);
    const testBudgetMs = timing?.testBudgetMs ?? attempt.timeoutMs;
    const phase = timing?.phases?.reduce((maximum, item) => Math.max(maximum, item.utilization ?? 0), 0) ?? 0;
    const teardownMs = attempt.steps?.find(step => step.title === "After Hooks")?.durationMs;
    const testUtilization = Number.isFinite(testBudgetMs) ? `${(attempt.durationMs / testBudgetMs * 100).toFixed(1)}%` : "unavailable";
    const teardown = Number.isFinite(testBudgetMs) && Number.isFinite(teardownMs) ? `${(teardownMs / testBudgetMs * 100).toFixed(1)}%` : "unavailable";
    lines.push(`| ${attempt.retry + 1} | ${attempt.status} | ${(attempt.durationMs / 1000).toFixed(1)}s | ${testUtilization} | ${timing ? `${(phase * 100).toFixed(1)}%` : "unavailable"} | ${teardown} |`);
  }
  const flaky = summary.attempts.some(attempt => attempt.retry > 0 && attempt.status === "passed");
  lines.push("", flaky ? "Result: flaky success after a failed first attempt." : `Result: ${summary.attempts[0].status} on the first attempt.`);
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve("test-results");
  const summary = JSON.parse(await readFile(join(root, "release-browser-summary.json"), "utf8"));
  const timings = await Promise.all((await phaseFiles(root)).map(async path => JSON.parse(await readFile(path, "utf8"))));
  const markdown = formatReleaseBrowserSummary(summary, timings);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}
