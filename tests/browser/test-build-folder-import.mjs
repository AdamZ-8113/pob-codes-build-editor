import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.DESKTOP_POB_ORIGIN ?? "http://127.0.0.1:3010";
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
const scanHeader = Buffer.from((
  '<?xml version="1.0"?><PathOfBuilding><Build level="90" className="Witch" ascendClassName="Elementalist"/>' +
  " ".repeat(2048)
).slice(0, 2048));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function waitForReady(page) {
  await page.waitForFunction(
    () => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors?.length,
    null,
    { timeout: 120_000 },
  );
  assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), true);
}

async function showBuildList(page) {
  if (await page.evaluate(() => window.__DESKTOP_POB__.buildListState?.mode) === "LIST") return;
  await page.locator("canvas").click({ position: { x: 35, y: 16 } });
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await page.waitForFunction(() => window.__DESKTOP_POB__.buildListState?.mode === "LIST", null, { timeout: 30_000 });
}

async function memoryBytes(page) {
  return await page.evaluate(async () => {
    if (typeof performance.measureUserAgentSpecificMemory === "function") {
      return { bytes: (await performance.measureUserAgentSpecificMemory()).bytes, metric: "measureUserAgentSpecificMemory" };
    }
    return { bytes: performance.memory?.usedJSHeapSize ?? 0, metric: "usedJSHeapSize fallback" };
  });
}

async function runCapacityProbe(fileCount) {
  const scratch = await mkdtemp(join(tmpdir(), `pob-build-folder-capacity-${fileCount}-`));
  const directory = join(scratch, `Capacity ${fileCount}`);
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  try {
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < fileCount; index++) {
      await writeFile(join(directory, `build-${String(index).padStart(4, "0")}.xml`), scanHeader);
    }
    const page = await context.newPage();
    await page.goto(`${origin}/?helpers=0&eagerPayload=1`);
    await waitForReady(page);
    await showBuildList(page);
    const before = await memoryBytes(page);
    const importStarted = performance.now();
    await page.locator(".pob-build-folder-input").setInputFiles(directory);
    await page.locator(".pob-build-folder-status").waitFor({ state: "visible" });
    await page.waitForFunction(
      count => document.querySelector(".pob-build-folder-status")?.textContent?.includes(`Imported ${count} build`),
      fileCount,
      { timeout: 300_000 },
    );
    const importMs = performance.now() - importStarted;
    const after = await memoryBytes(page);
    assert.equal(after.metric, before.metric);

    const scanMs = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = page.locator("canvas");
      await page.locator('[contenteditable="true"]').focus();
      await page.keyboard.press("Control+n");
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      await page.waitForFunction(() => window.__DESKTOP_POB__.buildListState?.mode === "BUILD", null, { timeout: 30_000 });
      const started = performance.now();
      await canvas.click({ position: { x: 35, y: 16 } });
      await page.waitForFunction(() => window.__DESKTOP_POB__.buildListState?.mode === "LIST", null, { timeout: 30_000 });
      scanMs.push(performance.now() - started);
    }
    const measured = scanMs.slice(1);
    return {
      fileCount,
      importMs: Math.round(importMs),
      scanWarmupMs: Math.round(scanMs[0]),
      scanRunsMs: measured.map(Math.round),
      scanMedianMs: Math.round(median(measured)),
      scanMaxMs: Math.round(Math.max(...measured)),
      memoryMetric: after.metric,
      postImportAdditionalMiB: Math.round((after.bytes - before.bytes) / 2 ** 20 * 10) / 10,
    };
  } finally {
    await context.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(
    () => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors?.length,
    null,
    { timeout: 120_000 },
  );
  assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), true);
  const result = await page.evaluate(async () => {
    const harness = await import("/tests/browser-support/build-folder-import-harness.ts");
    return await harness.runBuildFolderImportOpfsProbe();
  });
  assert.equal(result.committedBytes, "two");
  assert.deepEqual(result.failureEntries, [".pob-codes-import.pending", "unknown.txt"]);
  assert.equal(result.recoveryQuarantined, 1);
  assert.deepEqual(faults, []);
  await context.close();
  const representative = await runCapacityProbe(250);
  const cap = await runCapacityProbe(500);
  console.log("Build-folder import OPFS and capacity evidence:", JSON.stringify({ representative, cap }));
  assert.ok(cap.scanMedianMs <= 1_000, `500-file median refresh exceeded 1 second: ${cap.scanMedianMs} ms`);
  assert.ok(cap.scanMaxMs <= 2_000, `500-file refresh exceeded 2 seconds: ${cap.scanMaxMs} ms`);
  assert.ok(cap.postImportAdditionalMiB <= 128, `Post-import memory exceeded 128 MiB: ${cap.postImportAdditionalMiB} MiB`);
  console.log("Build-folder import: real OPFS transaction and bounded 500-file capacity acceptance passed.");
} finally {
  await browser.close();
}
