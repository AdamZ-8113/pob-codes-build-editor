import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';

const origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010';
const fixture = (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', import.meta.url), 'utf8')).trim();
const fixtureFile = async name => (await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')).trim();
const fixtures = [
  ['current', fixture],
  ['minion-historical', await fixtureFile('dominating blow of inspiring guardian 328.txt')],
  ['alternate-historical', await fixtureFile('lightning strike daughter of oshabi 328 alternate.txt')],
  ['ruthless', deflateSync(inflateSync(Buffer.from(fixture,'base64url')).toString().replaceAll('treeVersion="3_29"','treeVersion="3_29_ruthless"')).toString('base64url')],
];
if(process.argv[2]) fixtures.push(['private-timeless',(await readFile(process.argv[2],'utf8')).trim()]);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  const expectedStats = new Map();
  for (const mode of ['packages', 'eager', 'legacy', 'manifest-absent', 'missing', 'corrupt', 'offline']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    try {
      let intercepted = 0;
      if(mode==='manifest-absent') await context.route('**/payload/manifest.json',async route=>{
        intercepted++; await route.fulfill({status:404,body:'Not found'});
      });
      if (mode === 'missing' || mode === 'corrupt') {
        await context.route('**/payload/packages/*.zip', async route => {
          intercepted++;
          await route.fulfill({ status: mode === 'missing' ? 404 : 200, body: 'invalid-package' });
        });
      }
      if (mode === 'offline') {
        await context.route('**/payload/manifest.json', async route => { intercepted++; await route.abort('internetdisconnected'); });
      }
      const page = await context.newPage();
      await page.goto(origin + (mode === 'legacy' ? '/?legacyPayload=1' : mode === 'eager' ? '/?eagerPayload=1' : '/'));
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120000 });
      const state = await page.evaluate(() => ({ ready: window.__DESKTOP_POB__.ready, errors: window.__DESKTOP_POB__.errors, frames: window.__DESKTOP_POB__.frames }));
      if (mode === 'packages' || mode === 'eager' || mode === 'legacy' || mode === 'manifest-absent') {
        assert.equal(state.ready, true);
        assert.deepEqual(state.errors, []);
        for(const [name,fixtureCode] of mode==='manifest-absent'?fixtures.slice(0,1):fixtures) {
        await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixtureCode);
        const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
        const xml = inflateSync(Buffer.from(code, 'base64url')).toString();
        // XML attribute order is unspecified across fresh Lua states. Compare
        // every attribute/value, independently of its serialization order.
        const stats = [...xml.matchAll(/<PlayerStat\b[^>]*\/>/g)].map(m =>
          JSON.stringify([...m[0].matchAll(/([\w:.-]+)="([^"]*)"/g)].map(a=>[a[1],a[2]]).sort())
        ).sort();
        assert.ok(stats.length > 20, 'Export must contain real calculated player stats');
        if (expectedStats.has(name)) assert.ok(JSON.stringify(stats)===expectedStats.get(name), `${name}: packages and legacy must produce exact identical player stats`);
        else expectedStats.set(name,JSON.stringify(stats));
        console.log(`Payload fixture passed: ${mode}/${name}`);
        }
        assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      } else {
        assert.ok(intercepted > 0);
        assert.equal(state.ready, false);
        assert.equal(state.frames, 0, 'Bad payload must stop before any Lua frame or regeneration path');
        assert.ok(state.errors.length > 0);
      }
      console.log(`Payload browser case passed: ${mode}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
