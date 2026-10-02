import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010';
const code = (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const modes = [
  ['lazy', ''],
  ['eager', '?eagerPayload=1'],
  ['legacy', '?legacyPayload=1'],
  ['manifest-absent', ''],
];
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
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
