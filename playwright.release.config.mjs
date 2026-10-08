import { defineConfig } from "@playwright/test";

// Deliberately fixed to loopback: this suite must never use a live deployment.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "release.spec.mjs",
  fullyParallel: false,
  workers: 1,
  // Existing Linux runs legitimately take 2.8-2.9 minutes; 240 seconds keeps
  // a finite deadline while restoring the measured 20% release headroom.
  timeout: 240_000,
  retries: process.env.CI ? 1 : 0,
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
