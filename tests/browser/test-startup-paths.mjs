import { chromium } from '@playwright/test';
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010';
const code = (await readFile(new URL('../../fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const modes = [
  ['lazy', ''],
  ['eager', '?eagerPayload=1'],
  ['legacy', '?legacyPayload=1'],
  ['manifest-absent', ''],
];
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
try {
  for (const width of [1600, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      await context.route(/\/dist\/release\/driver\.mjs(?:\?|$)/, async route => {
        await gate;
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('#startup-detail').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#startup-title').textContent(), 'Loading PoB Data..');
      assert.equal(await page.locator('#startup-detail').getAttribute('role'), 'progressbar');
      assert.equal(await page.locator('#startup-detail .payload-progress-square').count(), 15);
      assert.equal(await page.locator('#launch-build').isDisabled(), true);
      assert.equal(await page.locator('.payload-progress').isHidden(), true);
      assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), false);
      const surface = await page.locator('#startup-surface').evaluate(node => ({
        position: getComputedStyle(node).position, box: node.getBoundingClientRect().toJSON(),
        controls: node.querySelectorAll('button, input, canvas').length,
      }));
      assert.equal(surface.position, 'relative');
      assert.equal(surface.controls, 0, 'Startup never imitates PoB controls');
      assert.ok(surface.box.left >= 0 && surface.box.right <= width);
      await page.locator('#about-legal').click();
      assert.equal(await page.locator('#about-dialog').isVisible(), true);
      await page.locator('#about-dialog-close').click();
      release();
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 120_000 });
      assert.equal(await page.locator('#startup-surface').count(), 0);
      assert.equal(await page.locator('#editor-window').getAttribute('aria-busy'), 'false');
      assert.equal(await page.locator('#startup-detail').count(), 0);
      assert.equal(await page.locator('canvas').first().isVisible(), true);
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { surface: rect('#window'), mount: rect('#editor-window'), canvas: rect('canvas') };
      });
      assert.equal(geometry.mount.height, geometry.surface.height, 'Driver mount must fill the editor even after its inline positioning changes');
      assert.ok(geometry.canvas.height >= geometry.surface.height - 1, 'A ready canvas must fill the visible editor');
      assert.equal(geometry.canvas.top, geometry.surface.top);
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
      console.log(`Delayed startup surface and About passed at ${width}px.`);
    } finally { release(); await context.close(); }
  }
  // Fail before driver construction: late timers must not erase the error.
  const failedContext = await browser.newContext();
  try {
    await failedContext.addInitScript(() => {
      const NativeCanvas = window.OffscreenCanvas;
      window.OffscreenCanvas = class extends NativeCanvas { getContext() { return null; } };
    });
    const page = await failedContext.newPage();
    await page.goto(origin);
    const alert = page.locator('.payload-progress-error[role="alert"]');
    await alert.waitFor({ state: 'visible' });
    assert.match(await alert.textContent(), /WebGL2/);
    await page.waitForTimeout(1200);
    assert.equal(await alert.isVisible(), true);
    assert.equal(await page.locator('#startup-detail').isHidden(), true);
    assert.equal(await page.locator('#launch-build').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), false);
    await page.locator('#about-legal').click();
    assert.equal(await page.locator('#about-dialog').isVisible(), true);
    await page.locator('#about-dialog-close').click();
    await Promise.all([page.waitForNavigation(), alert.getByRole('button', { name: 'Reload' }).click()]);
    await alert.waitFor({ state: 'visible' });
    console.log('Early startup error, persistent alert, About and Reload passed.');
  } finally { await failedContext.close(); }
  for (const [mode, query] of modes) {
    for (const fallback of [false, true]) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      try {
        let streamed = false, failed = false, mimeChanged = false, manifestMisses = 0;
        if (mode === 'manifest-absent') await context.route('**/payload/manifest.json', async route => {
          manifestMisses++;
          await route.fulfill({ status: 404, body: 'Not found' });
        });
        await context.route(/\/dist\/release\/driver\.mjs(?:\?|$)/, async route => {
          const response = await route.fetch(), source = await response.text();
          const marker = 'var instantiationResult = await WebAssembly.instantiateStreaming(response, imports);';
          assert.ok(source.includes(marker), 'Test must observe the real generated streaming path');
          await route.fulfill({ response, body: source.replace(marker, marker + ' console.info("desktop-test-streamed");') });
        });
        if (fallback) await context.route(/\/dist\/release\/driver\.wasm(?:\?|$)/, async route => {
          const response = await route.fetch(); mimeChanged = true;
          await route.fulfill({ response, headers: { ...response.headers(), 'content-type': 'application/octet-stream' } });
        });
        const page = await context.newPage();
        page.on('console', message => {
          if (message.text() === 'desktop-test-streamed') streamed = true;
          if (message.text().includes('wasm streaming compile failed')) failed = true;
        });
        await page.goto(origin + query);
        await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120000 });
        assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), true);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('contenteditable')), 'true', 'The ready editor receives initial keyboard focus');
        assert.equal(streamed, !fallback);
        assert.equal(failed, fallback);
        assert.equal(mimeChanged, fallback);
        assert.equal(manifestMisses, mode === 'manifest-absent' ? 1 : 0);
        const profile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
        if (mode === 'lazy') {
          assert.equal(profile.filesystem.payload.packagesBeforeReady, 5);
          assert.ok(profile.filesystem.payload.bytesBeforeReady < 10_000_000);
          assert.deepEqual(profile.filesystem.payload.packageOpens.filter((id, index, all) => all.indexOf(id) === index), ['core', 'timeless-shared', 'tree-3_29', 'tree-3_19', 'tree-legion']);
        } else if (mode === 'eager') {
          assert.ok(profile.filesystem.payload.packagesBeforeReady > 80);
        } else {
          assert.equal(profile.filesystem.payload, undefined);
        }
        await page.evaluate(value => window.__DESKTOP_POB__.loadBuildFromCode(value), code);
        const xml = inflateSync(Buffer.from(await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode()), 'base64url')).toString();
        assert.ok(/<PlayerStat\b/.test(xml), 'Every startup path executes real calculations');
        assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
        console.log(`Startup path passed: ${mode}/${fallback ? 'ArrayBuffer fallback' : 'streaming'}`);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
