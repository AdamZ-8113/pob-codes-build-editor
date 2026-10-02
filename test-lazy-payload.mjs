import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { loadInput } from './fixture-loader.mjs';

const origin = process.env.DESKTOP_POB_ORIGIN ?? 'http://127.0.0.1:3010';
const app = new URL('.', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('./.runtime/payload/manifest.json', app), 'utf8'));
const historical = (await readFile(new URL('./fixtures/dominating blow of inspiring guardian 328.txt', app), 'utf8')).trim();
const timelessXml = loadInput(fileURLToPath(new URL('./fixtures/abyss timeless reclaimed malevolence 329.json', app))).xml;
const timeless = deflateSync(timelessXml).toString('base64url');
const byId = new Map(manifest.packages.map(pkg => [pkg.id, pkg]));
const startupHashes = new Set(manifest.packages.filter(pkg => pkg.startup).map(pkg => pkg.sha256));
const tree328Hashes = new Set([byId.get('tree-3_28').sha256]);
const timelessHashes = new Set(manifest.packages.filter(pkg => pkg.id.startsWith('abyss-11-')).map(pkg => pkg.sha256));
const outputDirectory = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
try {
  await verifyDemandAndOverlay();
  await verifyBackgroundPrefetch();
  for (const fault of ['missing', 'hash', 'truncated', 'abort', 'stall']) {
    await verifyFailure(fault, 'tree', tree328Hashes, historical);
    await verifyFailure(fault, 'timeless', timelessHashes, timeless);
  }
} finally {
  await browser.close();
}

async function verifyDemandAndOverlay() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await context.routeWebSocket('**',socket=>socket.close());
  try {
    let treeRequests = 0;
    let demandGate;
    await context.route('**/payload/packages/*.zip', async route => {
      const hash = packageHash(route.request().url());
      if (tree328Hashes.has(hash)) treeRequests++;
      if (demandGate?.hashes.has(hash)) {
        demandGate.markSeen();
        await demandGate.release;
      }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(`${origin}/?payloadPrefetch=0`);
    await waitForReady(page);
    const startup = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
    console.log('Lazy startup profile:', JSON.stringify(startup.filesystem.payload));
    assert.equal(startup.filesystem.payload.packagesBeforeReady, 5);
    assert.ok(startup.filesystem.payload.bytesBeforeReady <= 97_438_098);
    assert.deepEqual(startup.filesystem.payload.packageOpens, ['core', 'timeless-shared', 'tree-3_29', 'tree-3_19', 'tree-legion']);
    await page.waitForTimeout(1_100);
    assert.equal(await page.locator('.payload-progress').isHidden(), true);

    demandGate = createGate(tree328Hashes);
    await page.evaluate(code => { window.__lazyImport = window.__DESKTOP_POB__.loadBuildFromCode(code); }, historical);
    await demandGate.seen;
    await page.locator('.payload-progress').waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('.payload-progress-label').textContent(), 'Loading PoB Data..');
    const aria = await page.locator('.payload-progress-grid').evaluate(node => ({
      min: node.getAttribute('aria-valuemin'), max: node.getAttribute('aria-valuemax'),
      now: node.getAttribute('aria-valuenow'), text: node.getAttribute('aria-valuetext'),
    }));
    assert.deepEqual([aria.min, aria.max], ['0', '100']);
    assert.ok(Number(aria.now) >= 0 && Number(aria.now) <= 100);
    assert.match(aria.text, /\(\d+%\)$/);
    const styles = await page.evaluate(() => {
      const panel = getComputedStyle(document.querySelector('.payload-progress'));
      const label = getComputedStyle(document.querySelector('.payload-progress-label'));
      const square = getComputedStyle([...document.querySelectorAll('.payload-progress-square')].at(-1));
      const active = getComputedStyle(document.querySelector('.payload-progress-square[data-active]'));
      return {
        panelBackground: panel.backgroundColor, panelBorder: panel.borderColor, panelRadius: panel.borderRadius,
        labelColor: label.color, labelSize: label.fontSize, labelWeight: label.fontWeight,
        squareBorder: square.borderColor, activeAnimation: active.animationName,
      };
    });
    assert.deepEqual(styles, {
      panelBackground: 'rgb(17, 17, 17)', panelBorder: 'rgb(42, 42, 42)', panelRadius: '6px',
      labelColor: 'rgb(175, 128, 64)', labelSize: '12.8px', labelWeight: '600',
      squareBorder: 'rgb(42, 42, 42)', activeAnimation: 'none',
    });
    if (outputDirectory) await page.screenshot({ path: resolve(outputDirectory, 'lazy-demand-desktop.png') });
    demandGate.open();
    await page.evaluate(() => window.__lazyImport);
    assert.equal(treeRequests, 1, 'Every open in one lazy package must coalesce to one fetch');
    await page.locator('.payload-progress-label').getByText('PoB Data Ready', { exact: true }).waitFor({ state: 'visible' });

    await page.close();
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 640, height: 1000 });
    await mobile.goto(`${origin}/?payloadPrefetch=0`);
    await waitForReady(mobile);
    await mobile.waitForTimeout(1_100);
    demandGate = createGate(timelessHashes);
    await mobile.evaluate(code => { window.__lazyImport = window.__DESKTOP_POB__.loadBuildFromCode(code); }, timeless);
    await demandGate.seen;
    await mobile.locator('.payload-progress').waitFor({ state: 'visible', timeout: 10_000 });
    if (outputDirectory) await mobile.screenshot({ path: resolve(outputDirectory, 'lazy-demand-640.png') });
    demandGate.open();
    await mobile.evaluate(() => window.__lazyImport);
    console.log('Lazy payload demand, coalescing, overlay tokens, ARIA and reduced-motion behavior passed.');
  } finally { await context.close(); }
}

async function verifyBackgroundPrefetch() {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.routeWebSocket('**',socket=>socket.close());
  try {
    const lazyRequests = [];
    await context.route('**/payload/packages/*.zip', async route => {
      const hash = packageHash(route.request().url());
      if (!startupHashes.has(hash)) lazyRequests.push(hash);
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await waitForReady(page);
    await page.waitForFunction(() => performance.now() > 0, null, { timeout: 1_000 });
    for (let attempts = 0; attempts < 40 && !lazyRequests.length; attempts++) await page.waitForTimeout(100);
    assert.ok(lazyRequests.length > 0, 'Idle prefetch must begin after the shell is ready');
    const noAbyssCount=manifest.packages.filter(pkg=>!pkg.id.startsWith('abyss-')).length;
    await page.waitForFunction(async count=>(await window.__DESKTOP_POB__.getRuntimeProfile()).filesystem.payload.loadedPackages.length===count,noAbyssCount,{timeout:120_000});
    const abyssHashes=new Set(manifest.packages.filter(pkg=>pkg.id.startsWith('abyss-')).map(pkg=>pkg.sha256));
    assert.equal(lazyRequests.some(hash=>abyssHashes.has(hash)),false,'Default desktop prefetch must never fetch Abyss shards');
    assert.equal(await page.locator('.payload-progress-label').textContent(), 'PoB Data Ready');
    console.log('Lazy payload background prefetch passed.');
  } finally { await context.close(); }
}

async function verifyFailure(fault, family, targetHashes, buildCode) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.routeWebSocket('**',socket=>socket.close());
  let enabled = true;
  let intercepted = 0;
  try {
    await context.route('**/payload/packages/*.zip', async route => {
      const hash = packageHash(route.request().url());
      if (!enabled || !targetHashes.has(hash)) { await route.continue(); return; }
      intercepted++;
      if (fault === 'missing') { await route.fulfill({ status: 404, body: 'missing' }); return; }
      if (fault === 'abort') { await route.abort('connectionaborted'); return; }
      if (fault === 'stall') {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 16_000));
        await route.abort('timedout').catch(() => {});
        return;
      }
      const response = await route.fetch();
      const body = Buffer.from(await response.body());
      if (fault === 'hash') body[Math.floor(body.length / 2)] ^= 0xff;
      await route.fulfill({ response, body: fault === 'truncated' ? body.subarray(0, Math.max(1, Math.floor(body.length / 2))) : body });
    });
    const page = await context.newPage();
    await page.goto(`${origin}/?payloadPrefetch=0`);
    await waitForReady(page);
    await page.evaluate(code => { void window.__DESKTOP_POB__.loadBuildFromCode(code); }, buildCode);
    await page.waitForFunction(() => window.__DESKTOP_POB__.errors.length > 0, null, { timeout: 110_000 });
    assert.ok(intercepted > 0, `${fault}/${family} must reach the target package`);
    const failedProfile = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
    const framesAtFailure = await page.evaluate(() => window.__DESKTOP_POB__.frames);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.frames), framesAtFailure, 'Lua frames must stop at terminal payload failure');
    const after = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
    assert.deepEqual(after.filesystem.writes, failedProfile.filesystem.writes, 'No root or user write may follow payload failure');
    assert.equal(await page.locator('.payload-progress-error[role="alert"]').isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Reload' }).isVisible(), true);
    enabled = false;
    await Promise.all([page.waitForEvent('domcontentloaded'),page.getByRole('button', { name: 'Reload' }).click()]);
    await waitForReady(page);
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    console.log(`Lazy payload failure containment passed: ${fault}/${family}`);
  } finally { await context.close(); }
}

function packageHash(url) {
  return basename(new URL(url).pathname, '.zip');
}

function createGate(hashes) {
  let markSeen;
  let open;
  return {
    hashes,
    seen: new Promise(resolveSeen => { markSeen = resolveSeen; }),
    release: new Promise(resolveRelease => { open = resolveRelease; }),
    markSeen,
    open,
  };
}

async function waitForReady(page) {
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120_000 });
  assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.ready), true, await page.locator('#status').textContent());
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
}
