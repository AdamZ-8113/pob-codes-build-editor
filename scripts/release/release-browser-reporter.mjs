import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function compactSteps(items) {
  return items.filter(step => ["hook", "fixture", "test.step"].includes(step.category)).map(step => ({
    title: step.title,
    category: step.category,
    durationMs: step.duration,
    error: step.error?.message?.slice(0, 500) ?? null,
    steps: compactSteps(step.steps ?? []),
  }));
}

export default class ReleaseBrowserReporter {
  constructor(options = {}) {
    this.outputFile = resolve(options.outputFile ?? "test-results/release-browser-summary.json");
    this.attempts = [];
  }

  onTestEnd(test, result) {
    this.attempts.push({
      title: test.title,
      timeoutMs: test.timeout,
      retry: result.retry,
      status: result.status,
      durationMs: result.duration,
      errors: result.errors.map(error => (error.message ?? String(error)).slice(0, 1000)),
      steps: compactSteps(result.steps ?? []),
    });
  }

  onEnd(result) {
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify({ schemaVersion: 1, status: result.status, attempts: this.attempts }, null, 2)}\n`);
  }
}
