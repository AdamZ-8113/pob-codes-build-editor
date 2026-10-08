import { defineConfig } from "@playwright/test";

// Deliberately fixed to loopback: this suite must never use a live deployment.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "release.spec.mjs",
  fullyParallel: false,
  workers: 1,
  // Keep the established outer deadline and the smaller per-phase budgets.
  timeout: 240_000,
  retries: 0,
  reporter: [
    ["line"],
    ["./scripts/release/release-browser-reporter.mjs", { outputFile: "test-results/release-browser-summary.json" }],
  ],
  use: {
    baseURL: "http://127.0.0.1:3011",
    browserName: "chromium",
    headless: true,
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    viewport: { width: 1600, height: 1000 },
  },
  webServer: {
    command: "node scripts/release/serve-test-release.mjs",
    url: "http://127.0.0.1:3011/import2/",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
