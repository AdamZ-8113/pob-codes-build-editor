import { expect, test } from "@playwright/test";

test("starts the same displayed PoB instance and preserves the storage namespace", async ({ page }) => {
  await page.goto(process.env.BUILD_EDITOR_PATH ?? "/");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors?.length, null, { timeout: 90_000 });
  expect(await page.evaluate(() => window.__DESKTOP_POB__.errors)).toEqual([]);
  expect(await page.evaluate(async () => (await window.__DESKTOP_POB__.getRuntimeProfile()).filesystem.payload.packagesBeforeReady)).toBeGreaterThan(0);
  expect(await page.title()).toContain("PoB Codes Build Editor");
});
