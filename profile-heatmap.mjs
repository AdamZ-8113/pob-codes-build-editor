import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
const fixture = (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://127.0.0.1:3010');
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120000 });
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
  await page.keyboard.press('Control+1');
  await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile(true));
  const canvas = page.locator('canvas'), bounds = await canvas.boundingBox();
  const dims = await canvas.evaluate(c => ({ width: c.width, height: c.height }));
  const begin = performance.now();
  await canvas.click({ position: { x: 930 * bounds.width / dims.width, y: (dims.height - 12) * bounds.height / dims.height } });
  let profile;
  do {
    await page.waitForTimeout(250);
    profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
    if (performance.now() - begin > 90000) throw new Error('Heatmap did not complete within the profiling deadline');
  } while (profile.samples.heatmapPending || !profile.samples.heatmap.length);
  profile.completionMs = performance.now() - begin;
  profile.environment = {
    browser: browser.version(), cpu: cpus()[0]?.model, logicalCores: cpus().length,
    viewport: { width: 1600, height: 1000, dpr: 1 },
    completionIncludesClick: true,
    provenance: JSON.parse(await readFile(new URL('./.runtime/payload/provenance.json', import.meta.url), 'utf8')),
  };
  assert.ok(profile.samples.heatmap.length, 'Heatmap control must invoke node power');
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(profile, null, 2) + '\n');
  console.log(JSON.stringify({ completionMs: profile.completionMs, summary: profile.samples.summary, wasmBytes: profile.wasmBytes }));
} finally { await browser.close(); }
