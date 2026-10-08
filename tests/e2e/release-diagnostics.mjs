import { writeFile } from "node:fs/promises";
import { test } from "@playwright/test";

export function createReleaseDiagnostics(testInfo) {
  const started = Date.now();
  const phases = [];
  return {
    async phase(name, budgetMs, body) {
      const phaseStarted = Date.now();
      let outcome = "passed";
      console.log(`[release run ${testInfo.repeatEachIndex + 1}] Starting: ${name} (budget ${budgetMs}ms)`);
      try {
        return await test.step(name, body, { timeout: budgetMs });
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        const elapsedMs = Date.now() - phaseStarted;
        phases.push({ name, outcome, budgetMs, elapsedMs, remainingMs: Math.max(0, budgetMs - elapsedMs), utilization: elapsedMs / budgetMs });
        console.log(`[release run ${testInfo.repeatEachIndex + 1}] ${outcome}: ${name} (${elapsedMs}/${budgetMs}ms)`);
      }
    },
    async finish() {
      const elapsedMs = Date.now() - started;
      const report = {
        schemaVersion: 1,
        title: testInfo.title,
        repeatEachIndex: testInfo.repeatEachIndex,
        retry: testInfo.retry,
        testBudgetMs: testInfo.timeout,
        elapsedMs,
        remainingMs: Math.max(0, testInfo.timeout - elapsedMs),
        utilization: elapsedMs / testInfo.timeout,
        phases,
      };
      const path = testInfo.outputPath("release-phase-timings.json");
      await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
      await testInfo.attach("release-phase-timings", { path, contentType: "application/json" });
    },
  };
}
