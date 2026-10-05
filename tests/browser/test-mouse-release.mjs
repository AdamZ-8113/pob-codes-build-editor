import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import sharp from "sharp";

const fixture = (await readFile(new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const changedPixels = (a,b) => {
  assert.equal(a.length,b.length);
  let changed = 0;
  for (let i=0;i<a.length;i+=3) {
    if ([0,1,2].some(channel => Math.abs(a[i+channel]-b[i+channel]) > 2)) changed++;
  }
  return changed;
};
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const faults = [];
  page.on("pageerror", error => faults.push(error.message));
  await page.goto("http://127.0.0.1:3010");
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
  const position = async () => {
    const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
    const xml = inflateSync(Buffer.from(code, "base64url")).toString();
    const view = xml.match(/<[^>]*\bzoomX="[^"]*"[^>]*>/)?.[0];
    assert.ok(view);
    return ["zoomX", "zoomY"].map(key => Number(view.match(new RegExp(`\\b${key}="([^"]*)"`))[1]));
  };
  const send = async (type, x, y, buttons, outside = false) => page.evaluate(({type,x,y,buttons,outside}) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    (outside ? document.body : canvas).dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: rect.left+x, clientY: rect.top+y, button: 0, buttons,
    }));
  }, {type,x,y,buttons,outside});
  const results = [];
  for (const scenario of ["outside release", "missed release", "window blur", "double click"]) {
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
    await page.locator("canvas").click({ position: {x: 1100, y: 700} });
    await page.keyboard.press("Control+1");
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await send("mousemove", 1100,700,0);
    await send("mousedown", 1100,700,1);
    await send("mousemove", 1000,650,1);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (scenario === "outside release") await send("mouseup", 1000,650,0,true);
    if (scenario === "window blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    if (scenario === "double click") {
      await send("mouseup",1000,650,0);
      await send("dblclick",1000,650,0);
    }
    const released = await position();
    await send("mousemove",1200,750,0);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    const moved = await position();
    results.push({scenario, released, moved, passed: JSON.stringify(released) === JSON.stringify(moved)});
    // Clear state even on the old, broken implementation to inspect every case.
    await send("mouseup",1200,750,0);
  }
  console.log(JSON.stringify(results, null, 2));
  assert.ok(results.every(result => result.passed), "Released mouse must not keep panning the native tree");
  // Also exercise genuine browser input crossing from PoB into the HTML shell.
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
  await page.keyboard.press("Control+1");
  const canvasBox = await page.locator("canvas").boundingBox();
  await page.mouse.move(canvasBox.x+1100,canvasBox.y+700);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x+1000,canvasBox.y+650,{steps:5});
  await page.mouse.move(1500,25);
  await page.mouse.up();
  const toolbarReleased = await position();
  await page.mouse.move(canvasBox.x+1200,canvasBox.y+750,{steps:5});
  assert.deepEqual(await position(),toolbarReleased,"Real toolbar release must end the drag");
  console.log("Tree: real browser drag released over the toolbar passed.");
  for (const scenario of ["outside release", "missed release", "window blur"]) {
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
    await page.keyboard.press("Control+3");
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await page.waitForTimeout(500);
    const [x,,width] = (await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile())).samples.uniqueDbBounds;
    // Original ItemsTab: itemList at y112, height324, shares x/width with uniqueDB.
    // Inspect row pixels, excluding the scrollbar and its hover highlight.
    const rows = async () => sharp(await page.locator("canvas").screenshot())
      .extract({ left: Math.round(x+2), top: 114, width: Math.round(width-24), height: 320 }).raw().toBuffer();
    const before = await rows();
    await send("mousemove",x+width-9,132,0);
    await send("mousedown",x+width-9,132,1);
    await send("mousemove",x+width-9,192,1);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await page.waitForTimeout(100);
    await send("mousemove",x+width-9,192,1);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    await page.waitForTimeout(100);
    const dragged = await rows();
    assert.ok(changedPixels(dragged,before) > before.length/3*.01,"Items scrollbar must actually move the native list");
    if (scenario === "outside release") await send("mouseup",x+width-9,192,0,true);
    if (scenario === "window blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await send("mousemove",1500,850,0);
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    const after = await rows();
    const changed = changedPixels(after,dragged);
    // Match the renderer's existing visual-regression tolerance: <0.1%.
    // A handful of glyph-edge pixels can vary between GPU captures.
    assert.ok(changed < after.length/3*.001,`${scenario}: unheld movement must not scroll Items rows (${changed} changed pixels)`);
    await send("mouseup",1500,850,0);
    console.log(`Items scrollbar: ${scenario} passed (${changed} changed pixels of ${after.length/3} after unheld motion).`);
  }
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  assert.deepEqual(faults, []);
} finally {
  await browser.close();
}
