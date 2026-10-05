import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

// The optional private build stays in the caller's file. Reports contain only
// public database names, timings and aggregate diagnostics, never build XML.
const [buildFile, outputFile] = process.argv.slice(2);
const fixture = buildFile ?? new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url);
const code = (await readFile(fixture, "utf8")).trim();
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
const faults = [];
let diagnosticPage;
const families = [
  "Glorious Vanity", "Lethal Pride", "Brutal Restraint", "Militant Faith", "Elegant Hubris", "Heroic Tragedy",
  "Festering Vengeance", "Extinguishing Grasp", "Baleful Dominion", "Destructive Aspiration", "Reclaimed Malevolence",
];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  diagnosticPage = page;
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
  const stats = async () => {
    const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), "base64url")).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
  };
  const initialStats = await stats();
  await page.keyboard.press("Control+3");
  await flush();
  const before = await profile();
  assert.equal(before.samples.uniqueDbBounds.length, 8, "Native Items database bounds must be available");
  const point = async (x, y) => {
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    const dimensions = await canvas.evaluate(element => [element.width, element.height]);
    return { x: box.x + x * box.width / dimensions[0], y: box.y + y * box.height / dimensions[1] };
  };
  const search = async text => {
    const [,,, ,x,y,w,h] = (await profile()).samples.uniqueDbBounds;
    const p = await point(x + w / 2, y + h / 2);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press("Control+a");
    if (text) await page.keyboard.type(text);
    else await page.keyboard.press("Backspace");
    await flush();
  };
  const hovered = [];
  for (let index = 0; index < families.length; index++) {
    await search(families[index]);
    let state = await profile();
    assert.ok(state.samples.uniqueDbCount > 0, `Database contains ${families[index]}`);
    const [x,y,w] = state.samples.uniqueDbBounds;
    const p = await point(x + w / 2, y + 8);
    await page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
    await page.mouse.move(p.x, p.y);
    await flush();
    const deadline = Date.now() + 30_000;
    while (!((await profile()).samples.timelessLoadedMask & (1 << index))) {
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
      assert.ok(Date.now() < deadline, `Timed out waiting for family ${index + 1}`);
      await page.waitForTimeout(20);
    }
    state = await profile();
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    assert.ok(state.samples.timelessLoadedMask & (1 << index), `Hover must load family ${index + 1}`);
    const frames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
    hovered.push({ family: index + 1, maxFrameMs: Math.max(0, ...frames.map(frame => frame.duration)),
      luaKiB: state.samples.luaKiB, wasmBytes: state.wasmBytes });
  }
  await search("");
  const [x,y,w,h] = (await profile()).samples.uniqueDbBounds;
  const p = await point(x + w / 2, y + h / 2);
  await page.mouse.move(p.x, p.y);
  for (const direction of [1, -1]) {
    for (let step = 0; step < 60; step++) {
      await page.mouse.wheel(0, 240 * direction);
      await flush();
    }
  }
  assert.deepEqual(await stats(), initialStats, "Unique database hover/scroll must preserve every exported player stat");
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
  const after = await profile();
  assert.equal(after.samples.timelessLoadedMask, 2047, "All eleven exact jewel-family tables remain loaded");
  const report = { allElevenFamiliesLoaded: true, scrollSteps: 120, statsUnchanged: true, faults,
    before: { luaKiB: before.samples.luaKiB, wasmBytes: before.wasmBytes }, hovered,
    after: { luaKiB: after.samples.luaKiB, wasmBytes: after.wasmBytes } };
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch (error) {
  const errors = await diagnosticPage?.evaluate(() => window.__DESKTOP_POB__?.errors ?? []).catch(() => ["Page unavailable"]);
  const failure = { passed: false, message: error.message, faults, errors };
  if (outputFile) await writeFile(outputFile, JSON.stringify(failure, null, 2) + "\n");
  console.error(JSON.stringify(failure));
  throw error;
} finally {
  await browser.close();
}
