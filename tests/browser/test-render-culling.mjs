import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import sharp from "sharp";

// Compare the real renderer against its unculled submission path in isolated
// browser contexts; disable only the new rejection condition in the baseline.
const code = (await readFile(new URL("../../fixtures/guided import parity desktop 329.txt", import.meta.url), "utf8")).trim();
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const reviewDirectory = process.argv[2];
if (reviewDirectory) await mkdir(reviewDirectory, { recursive:true });
try {
  const results = [];
  for (const culling of [false, true]) {
    const context = await browser.newContext({ viewport: { width:1600, height:1000 } });
    // PoB rotates jewel-radius artwork using GetTime(). Pin only the native
    // animation clock so identical scenes can be compared across contexts.
    await context.route(/\/dist\/release\/driver\.mjs(?:\?|$)/, async route => {
      const response = await route.fetch();
      const source = await response.text();
      const clock = "var _emscripten_get_now = () => performance.now();";
      assert.ok(source.includes(clock), "Visual baseline must freeze PoB's animation clock");
      await route.fulfill({ response, body:source.replace(clock, "var _emscripten_get_now = () => 1000;") });
    });
    let intercepted = culling;
    if (!culling) await context.route(/\/renderer\/webgl_backend\.ts(?:\?|$)/, async route => {
      const response = await route.fetch();
      const source = await response.text();
      assert.ok(source.includes("quadOutsideViewport("), "Baseline must disable the actual culling call");
      intercepted = true;
      await route.fulfill({ response, body: source.replace("quadOutsideViewport(", "false && quadOutsideViewport(") });
    });
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:3010");
    await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout:120_000 });
    // Measure submissions themselves; identical-frame reuse would report zero.
    await page.evaluate(() => window.__DESKTOP_POB__.configureRenderReuse(false));
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
    await page.keyboard.press("Control+1");
    await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    const states = [];
    for (let zoom = 0; zoom < 3; zoom++) {
      if (zoom) {
        await page.mouse.move(1050, 600);
        for (let step = 0; step < 4; step++) {
          await page.mouse.wheel(0, -100);
          await page.waitForTimeout(70);
        }
      }
      await page.mouse.move(1590, 25);
      await page.waitForTimeout(800);
      const png = await page.locator("canvas").screenshot(reviewDirectory ? { path:`${reviewDirectory}/${culling ? "after" : "before"}-${zoom}.png` } : {});
      states.push({ pixels:await sharp(png).removeAlpha().raw().toBuffer(), backend:await page.evaluate(() => window.__DESKTOP_POB__.stats.backend) });
    }
    assert.ok(intercepted);
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    results.push(states);
    await context.close();
  }
  const report = results[0].map((before, index) => {
    const after = results[1][index];
    assert.equal(before.pixels.length, after.pixels.length);
    let changed = 0;
    for (let i = 0; i < before.pixels.length; i += 3) {
      if ([0,1,2].some(channel => Math.abs(before.pixels[i+channel] - after.pixels[i+channel]) > 2)) changed++;
    }
    const fraction = changed / (before.pixels.length / 3);
    assert.ok(fraction < .001, `Zoom ${index}: visible pixels changed (${fraction})`);
    assert.ok(after.backend.instances <= before.backend.instances);
    return { zoom:index, changedPixels:changed, before:before.backend.instances, after:after.backend.instances };
  });
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
