import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: "release.spec.mjs",
  fullyParallel: false,
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.BUILD_EDITOR_ORIGIN ?? "http://127.0.0.1:3010",
    browserName: "chromium",
    channel: "chrome",
    headless: true,
    viewport: { width: 1600, height: 1000 }
  },
  webServer: process.env.BUILD_EDITOR_EXTERNAL_SERVER ? undefined : {
    command: "npm run dev",
    url: "http://127.0.0.1:3010",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
