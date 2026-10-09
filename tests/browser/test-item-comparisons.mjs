import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';

const origin = process.env.DESKTOP_POB_ORIGIN || 'http://127.0.0.1:3010';
const code = (await readFile(new URL('../../fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const manifest = JSON.parse(await readFile(new URL('../../.runtime/payload/manifest.json', import.meta.url)));
const amanamu = new Set(manifest.packages.filter(p => p.id.startsWith('timeless-abyssamanamu')).map(p => p.sha256));
const browser = await chromium.launch({headless: true, channel: browserChannel()});
const names = ['Goldrim', "Atziri's Promise", 'Thread of Hope', 'Glorious Vanity', 'Destructive Aspiration'];
const baseline = new Map();
try {
  for (const background of [false, true]) {
    const context = await browser.newContext({viewport: {width: 1600, height: 1000}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    if (background) await context.route('**/payload/packages/*.zip', async route => {
      const hash = route.request().url().split('/').at(-1).slice(0, -4);
      if (amanamu.has(hash)) { held = true; await gate; }
      await route.continue();
    });
    try {
      await page.goto(`${origin}/?payloadPrefetch=0&helpers=0&itemComparisons=${background ? 1 : 0}`);
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, {timeout: 120_000});
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
      const stats = async () => {
        const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
        const xml = inflateSync(Buffer.from(code, 'base64url')).toString();
        return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(match => match[0]).sort();
      };
      const initial = await stats();
      await page.keyboard.press('Control+3');
      const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
      const until = async (predicate, label) => {
        const deadline = Date.now() + 120_000;
        while (!await predicate()) {
          assert(Date.now() < deadline, `${label}: ${JSON.stringify(await profile())}`);
          await page.waitForTimeout(30);
        }
      };
      const point = async (x, y) => {
        const canvas = page.locator('canvas'), box = await canvas.boundingBox();
        const [w, h] = await canvas.evaluate(c => [c.width, c.height]);
        return {x: box.x + x * box.width / w, y: box.y + y * box.height / h};
      };
      const search = async name => {
        await flush();
        const [,,,,x,y,w,h] = (await profile()).samples.uniqueDbBounds;
        const p = await point(x + w / 2, y + h / 2);
        await page.mouse.click(p.x, p.y);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(name);
        await flush();
        const state = await profile();
        assert(state.samples.uniqueDbCount > 0, name);
        const [dx,dy,dw] = state.samples.uniqueDbBounds;
        const hover = await point(dx + dw / 2, dy + 8);
        await page.mouse.move(hover.x, hover.y);
      };
      await flush();
      for (const name of ['Demon Barb', "Kalandra's Touch", 'Wildfire Phloem']) {
        const [,,,,x,y,w,h] = (await profile()).samples.itemListTooltip.bounds;
        const p = await point(x + w / 2, y + h / 2);
        await page.mouse.click(p.x, p.y);
        await page.keyboard.press('Control+a'); await page.keyboard.type(name); await flush();
        const before = (await profile()).samples.itemComparisons;
        const [dx,dy,dw] = (await profile()).samples.itemListTooltip.bounds;
        const hover = await point(dx + dw / 2, dy + 8);
        await page.mouse.move(hover.x, hover.y); await flush();
        await until(async () => {
          const s = (await profile()).samples;
          assert.equal(s.itemComparisons.failed, 0, `${name}: owned item comparison failed`);
          return s.itemListTooltip.hovered && s.itemListTooltip.lines > 0 && !s.itemListTooltip.pending &&
            (!background || s.itemComparisons.completed > before.completed || s.itemComparisons.hits > before.hits);
        }, `${name} owned item`);
        const hash = (await profile()).samples.itemListTooltip.hash;
        if (background) assert.equal(hash, baseline.get(`owned:${name}`), `${name}: owned tooltip parity`);
        else baseline.set(`owned:${name}`, hash);
        console.log(JSON.stringify({background, owned: name, hash}));
      }
      for (const name of names) {
        let before = await profile();
        const at = Date.now();
        await search(name);
        if (background && name === 'Destructive Aspiration') {
          await until(() => held, 'Amanamu request');
          assert.equal((await profile()).filesystem.payload.requestReasons.find(p => p.id.startsWith('timeless-abyssamanamu')).reason, 'comparison');
          assert.equal(await page.locator('.payload-progress').isVisible(), false,
            `Hover downloads do not show the global overlay: ${await page.locator('.payload-progress').innerText()}`);
          // A main-worker RPC and an actual tab change must complete while the
          // package remains held. This would deadlock on the old UI read path.
          await page.keyboard.press('Control+1');
          await Promise.race([flush(), new Promise((_, reject) => setTimeout(() => reject(new Error('UI blocked by comparison download')), 3_000))]);
          await page.keyboard.press('Control+3'); await flush();
          await search('Goldrim');
          release();
          await until(async () => (await profile()).samples.uniqueComparisons.comparisonHeaders > 0, 'Returning to cached Goldrim');
          assert.equal((await profile()).samples.uniqueComparisons.tooltipHash, baseline.get('Goldrim').hash, 'Late Amanamu result cannot replace Goldrim');
          before = await profile();
          await search(name);
        }
        await until(async () => {
          const s = (await profile()).samples;
          assert.equal(s.itemComparisons?.failed ?? 0, 0, `${name}: helper comparison failed`);
          return s.uniqueComparisons.completed > before.samples.uniqueComparisons.completed && !s.uniqueComparisons.pending;
        }, `${name} comparison`);
        const state = await profile();
        if (background) assert(state.samples.itemComparisons?.requested > 0, 'Background comparison adapter is active');
        const result = {hash: state.samples.uniqueComparisons.tooltipHash,
          headers: state.samples.uniqueComparisons.comparisonHeaders, ms: Date.now() - at};
        // The aggregate header counter covers equip/remove; flask comparisons
        // use PoB's activate/deactivate wording instead.
        if (name !== "Atziri's Promise") assert(result.headers > 0, `${name}: expected stat comparisons`);
        if (background) assert.equal(result.hash, baseline.get(name).hash, `${name}: exact tooltip parity`);
        else baseline.set(name, result);
        console.log(JSON.stringify({background, name, ...result}));
      }
      if (background) {
        const corrupt = manifest.packages.find(p => p.id === 'timeless-abysszorath-zip-part0');
        const pattern = `**/payload/packages/${corrupt.sha256}.zip`;
        const fault = route => route.fulfill({status: 200, body: Buffer.alloc(corrupt.bytes)});
        await context.route(pattern, fault);
        await search('Reclaimed Malevolence');
        await until(async () => (await profile()).samples.itemComparisons.failed === 1, 'Isolated corrupt comparison package');
        assert.equal(await page.locator('.payload-progress').isVisible(), false, 'Comparison failure stays out of the global overlay');
        await search('Goldrim');
        await until(async () => (await profile()).samples.uniqueComparisons.tooltipHash === baseline.get('Goldrim').hash,
          'UI and cached comparisons survive a helper failure');
        await context.unroute(pattern, fault);
        const completed = (await profile()).samples.itemComparisons.completed;
        await search('Reclaimed Malevolence');
        await until(async () => (await profile()).samples.itemComparisons.completed > completed, 'Retry after a comparison download failure');
        assert.equal((await profile()).samples.itemComparisons.failed, 1);
      }
      assert.deepEqual(await stats(), initial, 'Comparisons do not change player stats');
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    } finally { release(); await context.close(); }
  }
} finally { await browser.close(); }
