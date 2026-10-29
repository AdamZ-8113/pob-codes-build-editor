import { chromium } from "@playwright/test";
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { parseDriftPatch } from "../../scripts/build/drift-patch.mjs";
import { readCorePackage, rewriteCorePackage, routeCorePackage } from "../../tools/profiles/core-package-overlay.mjs";

// Compare against PoB's exact original connector path, using the same native
// binary and renderer. Reversed source and screenshots stay in memory.
const sections = parseDriftPatch(await readFile("patches/tree-connector-culling.patch"));
const core = await readCorePackage();
const baseline = rewriteCorePackage(core, sections.map(section => ({
  path: section.path.slice(4),
  transform(source) {
    for (const { before, after } of [...section.blocks].reverse()) {
      assert.equal(source.split(after).length, 2, "Reverse patch must match exactly once");
      source = source.replace(after, () => before);
    }
    return source;
  },
})));
const live = rewriteCorePackage(core, [{
  path: "Classes/PassiveTreeView.lua",
  transform(source) {
    assert.ok(source.includes("local canRetainArtwork = CaptureDrawCache"));
    return source.replace("local canRetainArtwork = CaptureDrawCache", "local canRetainArtwork = false and CaptureDrawCache");
  },
}]);
const code = (await readFile("fixtures/guided import parity desktop 329.txt", "utf8")).trim();
const playerStats = code => [...inflateSync(Buffer.from(code, "base64url")).toString().matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  const report = [];
  for (const dpr of [1, 2]) {
    const results = [];
    for (const mode of ["original", "live", "retained"]) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
      if (mode === "original") await routeCorePackage(context, baseline);
      if (mode === "live") await routeCorePackage(context, live);
      // Freeze only PoB's animation clock; worker/render CPU clocks stay real.
      await context.route(/\/driver(?:-[\w-]+)?\.(?:mjs|js)(?:\?|$)/, async route => {
        const response = await route.fetch(), source = await response.text();
        const clock = "performance.now()";
        assert.equal(source.split(clock).length, 2, 'One native animation clock in development or bundled runtime');
        await route.fulfill({ response, body: source.replace(clock, "1000") });
      });
      const page = await context.newPage();
      const faults = [];
      page.on("pageerror", error => faults.push(error.message));
      await page.goto(process.env.DESKTOP_POB_ORIGIN || "http://127.0.0.1:3010");
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
      await page.keyboard.press("Control+1");
      await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      await page.evaluate(() => window.__DESKTOP_POB__.configureRenderReuse(false));
      const initialStats = playerStats(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()));
      const states = [];
      for (let zoom = 0; zoom < 3; zoom++) {
        if (zoom) {
          await page.mouse.move(1050, 600);
          for (let i = 0; i < 3; i++) {
            await page.mouse.wheel(0, -100);
            await page.waitForTimeout(100);
          }
        }
        // Several camera positions exercise connectors crossing screen edges.
        await page.mouse.move(1100, 700);
        await page.mouse.down();
        await page.mouse.move(1100 + zoom * 90, 700 - zoom * 60, { steps: 10 });
        await page.mouse.up();
        await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
        await page.mouse.move(1590, 25);
        await page.waitForTimeout(800);
        const pixels = await sharp(await page.locator("canvas").screenshot()).removeAlpha().raw().toBuffer();
        const profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
        const dragPixels = [];
        // Capture during a drag, including artwork entering view after capture.
        // Screenshots after mouse-up only exercise the uncached drawing path.
        await page.mouse.move(1100, 700);
        await page.mouse.down();
        for (const [x, y] of [[1320, 520], [870, 790], [1100, 700]]) {
          await page.mouse.move(x, y, { steps: 16 });
          await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
          dragPixels.push(await sharp(await page.locator("canvas").screenshot()).removeAlpha().raw().toBuffer());
        }
        await page.mouse.up();
        await page.evaluate(() => window.__DESKTOP_POB__.flushInput());
        assert.equal((await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile())).draw.drawCache.allocatedBytes, 0,
          "Mouse release must free retained native storage");
        const rounds = [];
        // Deliberately dispatch inside the page, avoiding Playwright RPC latency
        // between moves. This measures worker work, not input-to-photon latency.
        for (let round = 0; round < 3; round++) {
          await page.evaluate(async () => {
            const app = window.__DESKTOP_POB__, canvas = document.querySelector("canvas"), rect = canvas.getBoundingClientRect();
            const send = (type, x, y, buttons) => canvas.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, button: 0, buttons,
            }));
            send("mousemove", 1100, 700, 0);
            send("mousedown", 1100, 700, 1);
            await app.flushInput();
            app.clearFrameSamples();
            for (let i = 1; i <= 225; i++) {
              const angle = i / 225 * Math.PI * 2;
              send("mousemove", 1100 + Math.sin(angle) * 240, 700 + Math.sin(angle * 2) * 140, 1);
              await new Promise(resolve => setTimeout(resolve, 8));
            }
            send("mousemove", 1100, 700, 1);
            send("mouseup", 1100, 700, 0);
            await app.flushInput();
          });
          const frames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
          assert.ok(frames.length > 20, "Pan must produce real frames");
          rounds.push({ frameMs: median(frames.map(frame => frame.duration)), renderMs: median(frames.map(frame => frame.render)) });
        }
        const cache = (await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile())).draw.drawCache;
        if (mode === "retained") assert.ok(cache.replays > 20, "Dragging must actually reuse artwork");
        states.push({ pixels, dragPixels, drawBytes: profile.draw.bytes, rounds, cache });
      }
      assert.deepEqual(playerStats(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode())), initialStats);
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
      assert.deepEqual(faults, []);
      results.push(states);
      await context.close();
      console.log(`DPR ${dpr}: ${mode} tree captures and drag rounds complete`);
    }
    for (let zoom = 0; zoom < 3; zoom++) {
      const before = results[0][zoom], uncached = results[1][zoom], after = results[2][zoom];
      assert.equal(before.pixels.length, after.pixels.length);
      let changed = 0;
      for (let i = 0; i < before.pixels.length; i += 3) {
        if ([0, 1, 2].some(channel => Math.abs(before.pixels[i + channel] - after.pixels[i + channel]) > 2)) changed++;
      }
      assert.ok(changed / (before.pixels.length / 3) < .001, `DPR ${dpr}, zoom ${zoom}: ${changed} visible pixels changed`);
      const dragChanges = [];
      for (let shot = 0; shot < after.dragPixels.length; shot++) {
        const a = uncached.dragPixels[shot], b = after.dragPixels[shot];
        let different = 0;
        for (let i = 0; i < a.length; i += 3) {
          if ([0, 1, 2].some(channel => Math.abs(a[i + channel] - b[i + channel]) > 2)) different++;
        }
        assert.ok(different / (a.length / 3) < .001, `DPR ${dpr}, zoom ${zoom}, drag ${shot}: ${different} retained pixels changed`);
        dragChanges.push(different);
      }
      assert.ok(after.drawBytes < before.drawBytes, "Culling must remove native commands");
      report.push({ dpr, zoom, changedPixels: changed, dragChanges, before: { bytes: before.drawBytes, rounds: before.rounds },
        live: { rounds: uncached.rounds }, after: { bytes: after.drawBytes, rounds: after.rounds, cache: after.cache } });
    }
  }
  console.log(JSON.stringify({ browser: browser.version(), report }));
} finally { await browser.close(); }
