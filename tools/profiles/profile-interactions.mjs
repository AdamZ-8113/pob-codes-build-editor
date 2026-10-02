import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

// Local review tool; the private build stays in the caller's file, never a fixture.
const [buildFile, outputFile] = process.argv.slice(2);
if (!buildFile) throw new Error("Usage: node profile-interactions.mjs <build-code.txt> [report.json]");
const code = (await readFile(buildFile, "utf8")).trim();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const summarize = (samples, key = "duration") => {
  const values = samples.map(sample => sample[key]).sort((a, b) => a - b);
  return { count: values.length, median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)], max: values.at(-1) };
};
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const clear = () => page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
  const samples = () => page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
  const stats = async () => {
    const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
  };
  await page.keyboard.press("Control+3");
  await flush();
  await page.mouse.move(1300, 850);
  await page.waitForTimeout(1800); // Allow original unique-list coroutine to settle.
  const initialStats = await stats();
  const hoverRounds = [];
  for (let round = 0; round < 3; round++) {
    const items = [];
    for (const [name, y] of [["weapon",214],["helmet",390],["body",310],["gloves",262],["boots",278],["amulet",294],["ring",342],["belt",230]]) {
      await page.mouse.move(1300, 850);
      await page.waitForTimeout(100);
      await clear();
      await page.mouse.move(850, y);
      await page.waitForTimeout(250);
      await flush();
      items.push({ name, ...summarize(await samples()) });
    }
    hoverRounds.push(items);
  }
  await page.mouse.move(1300, 850);
  await page.keyboard.press("Control+1");
  await flush();
  await page.waitForTimeout(500);
  const tree = [];
  for (let round = 0; round < 3; round++) {
    await clear();
    await page.mouse.move(1100, 800);
    await page.mouse.down();
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(1100 - i * 4, 800 - i * 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await flush();
    const frames = await samples();
    tree.push({ frame: summarize(frames), render: summarize(frames, "render"), backend: await page.evaluate(() => window.__DESKTOP_POB__.stats.backend) });
    // Restore the view before the next measured gesture.
    await page.mouse.down();
    await page.mouse.move(1100, 800, { steps: 20 });
    await page.mouse.up();
    await flush();
    await page.waitForTimeout(150);
  }
  assert.deepEqual(await stats(), initialStats, "Hover and pan must preserve calculated build stats");
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  const report = { viewport: { width:1600, height:1000, dpr:1 }, hoverRounds, tree, statsUnchanged:true };
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
