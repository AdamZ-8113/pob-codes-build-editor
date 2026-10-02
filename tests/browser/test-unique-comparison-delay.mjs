import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const [buildFile, outputFile] = process.argv.slice(2);
const code = (await readFile(buildFile ?? new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const faults = [];
const phases = {};
let page;
try {
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
  const until = async predicate => {
    const deadline = Date.now() + 30_000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, "Timed out waiting for unique comparison state");
      await page.waitForTimeout(20);
    }
  };
  const playerStats = async () => {
    const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
  };
  const initialStats = await playerStats();
  await page.keyboard.press("Control+3");
  await flush();
  const point = async (x, y) => {
    const canvas = page.locator("canvas"), box = await canvas.boundingBox();
    const size = await canvas.evaluate(element => [element.width, element.height]);
    return { x: box.x + x * box.width / size[0], y: box.y + y * box.height / size[1] };
  };
  const search = async text => {
    const [,,,,x,y,w,h] = (await profile()).samples.uniqueDbBounds;
    const p = await point(x + w / 2, y + h / 2);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press("Control+a");
    await page.keyboard.type(text);
    await flush();
  };
  await search("Historic");
  const before = await profile();
  assert.ok(before.samples.uniqueDbCount >= 11, "Historic filter must contain all eleven jewel families");
  const [x,y,w] = before.samples.uniqueDbBounds;
  for (let row = 0; row < 11; row++) {
    const p = await point(x + w / 2, y + 8 + row * 16);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(30); // Deliberate sub-150ms physical-style row visits.
  }
  const outside = await point(1400, 800);
  await page.mouse.move(outside.x, outside.y);
  await flush();
  await until(async () => {
    const s = (await profile()).samples.uniqueComparisons;
    return !s.pending && !s.hovered;
  });
  const rapid = await profile();
  phases.rapid = rapid.samples;
  assert.equal(rapid.samples.uniqueComparisons.completed, before.samples.uniqueComparisons.completed, "Transient rows must not run comparison calculations");
  assert.equal(rapid.samples.timelessLoadedMask, before.samples.timelessLoadedMask, "Transient rows must not load heavyweight jewel data");
  assert.ok(rapid.samples.uniqueComparisons.deferred - before.samples.uniqueComparisons.deferred >= 5, "Real frames must observe several transient rows");

  await search("Glorious Vanity");
  const [sx,sy,sw] = (await profile()).samples.uniqueDbBounds;
  const selected = await point(sx + sw / 2, sy + 8);
  const completed = (await profile()).samples.uniqueComparisons.completed;
  await page.mouse.move(selected.x, selected.y);
  await until(async () => (await profile()).samples.uniqueComparisons.pending);
  const pending = await profile();
  phases.pending = pending.samples;
  assert.equal(pending.samples.uniqueComparisons.completed, completed);
  await until(async () => {
    const s = (await profile()).samples.uniqueComparisons;
    return !s.pending && s.completed > completed;
  });
  const settled = await profile();
  phases.settled = settled.samples;
  assert.ok(settled.samples.timelessLoadedMask & 1, "Stable hover executes original Glorious Vanity comparison");
  assert.ok(settled.samples.uniqueComparisons.comparisonHeaders > 0);
  assert.ok(settled.samples.uniqueComparisons.numericLines > 0, "Settled tooltip contains calculated numeric comparisons");
  await page.mouse.move(outside.x, outside.y);
  await flush();
  await until(async () => !(await profile()).samples.uniqueComparisons.hovered);
  await page.mouse.move(selected.x, selected.y);
  await until(async () => (await profile()).samples.uniqueComparisons.completed > settled.samples.uniqueComparisons.completed);
  const repeated = await profile();
  assert.equal(repeated.samples.uniqueComparisons.tooltipHash, settled.samples.uniqueComparisons.tooltipHash, "Returning after cancellation yields identical full tooltip text and numbers");
  // Scroll at the filtered list boundary while the initial hover is pending.
  await page.mouse.move(outside.x, outside.y); await flush();
  await until(async () => !(await profile()).samples.uniqueComparisons.hovered);
  await page.mouse.move(selected.x, selected.y);
  const scrollStart = await profile();
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 80); await page.waitForTimeout(40); }
  const scrolling = await profile();
  assert.equal(scrolling.samples.uniqueComparisons.completed, scrollStart.samples.uniqueComparisons.completed, "Continuous wheel input extends the pending comparison");
  await until(async () => (await profile()).samples.uniqueComparisons.completed > scrollStart.samples.uniqueComparisons.completed);
  const stopped = await profile();
  assert.equal(stopped.samples.uniqueComparisons.tooltipHash, settled.samples.uniqueComparisons.tooltipHash, "Stopping scrolling eventually restores exact comparison content");
  assert.deepEqual(await playerStats(), initialStats);
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  const report = { passed: true, transientRows: 11, heavyweightLoadsAvoided: true, statsUnchanged: true,
    rapid: rapid.samples.uniqueComparisons, settled: settled.samples.uniqueComparisons, stopped: stopped.samples.uniqueComparisons };
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch (error) {
  const errors = await page?.evaluate(() => window.__DESKTOP_POB__?.errors ?? []).catch(() => ["Page unavailable"]);
  const profile = await page?.evaluate(() => window.__DESKTOP_POB__?.getRuntimeProfile()).catch(() => null);
  const report = { passed: false, message: error.message, faults, errors, profile, phases };
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.error(JSON.stringify(report));
  throw error;
} finally { await browser.close(); }
