import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { applyGemHoverPatch, blobHash, sha256 } from './gem-hover-patch.mjs';

// Local A/B tool. Only the hash-checked GemSelectControl and identical diagnostics
// differ in the in-memory packages. The shipped payload is never rewritten.
const output = resolve(process.argv[2] ?? 'tmp/gem-dropdown-hover');
const verifyOnly = process.argv.includes('--verify-only');
const origin = 'http://127.0.0.1:3010';
const app = new URL('.', import.meta.url);
const require = createRequire(new URL('./upstream/deno.json', app));
const AdmZip = require('adm-zip');
const pin = JSON.parse(await readFile(new URL('source-pin.json', app)));
const patchPin = pin.adapters.gemDropdownHover;
const patch = await readFile(new URL(patchPin.patchFile, app));
const original = await readFile(new URL('.runtime/source/src/Classes/GemSelectControl.lua', app), 'utf8');
const patched = applyGemHoverPatch(original, patch, patchPin);
const diagnostics = await readFile(new URL('gem-hover-profile.lua', app), 'utf8');
const manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', app)));
const core = manifest.packages.find(p => p.id === 'core');
const archive = await readFile(new URL(`.runtime/payload/packages/${core.sha256}.zip`, app));
assert.equal(sha256(archive), core.sha256);
assert.equal(new AdmZip(archive).readAsText('Classes/GemSelectControl.lua'), patched, 'Prepare the patched payload with pack.mjs first');
const fixture = (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', app), 'utf8')).trim();
await mkdir(output, { recursive: true });

const variants = {};
for (const [name, source] of Object.entries({ before: original, after: patched })) {
  const zip = new AdmZip(archive);
  const content = Buffer.from(source + '\n' + diagnostics);
  zip.updateFile('Classes/GemSelectControl.lua', content);
  const bytes = zip.toBuffer();
  const variant = structuredClone(manifest);
  const entry = variant.packages.find(p => p.id === 'core');
  const file = entry.files.find(f => f.path === 'Classes/GemSelectControl.lua');
  entry.uncompressedBytes += content.length - file.bytes;
  file.bytes = content.length;
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  variants[name] = { manifest: variant, bytes, hash: entry.sha256 };
}

const summarize = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))], max: sorted.at(-1), total: values.reduce((a,b) => a+b, 0) };
};
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const rounds = [];
try {
  const order = verifyOnly ? ['before', 'after'] : ['before', 'after', 'after', 'before', 'before', 'after'];
  for (const [index, name] of order.entries()) {
    console.log(`Gem hover round ${index + 1}: ${name}`);
    rounds.push(await runRound(name, index));
  }
  for (const scenario of ['slot', 'imbued']) {
    const reference = rounds[0][scenario];
    for (const round of rounds) {
      assert.deepEqual(round[scenario].lines, reference.lines, `${scenario}: identical complete tooltip lines`);
      assert.deepEqual(round[scenario].changedRow.lines, reference.changedRow.lines, `${scenario}: identical changed-row tooltip`);
      assert.deepEqual(round[scenario].gem, reference.gem);
      if (verifyOnly) assert.deepEqual(round[scenario].qualityLines, reference.qualityLines, `${scenario}: changed quality tooltip parity`);
    }
  }
  const summary = {};
  for (const name of ['before', 'after']) {
    summary[name] = {};
    for (const scenario of ['slot', 'imbued']) {
      const runs = rounds.filter(r => r.variant === name).map(r => r[scenario]);
      summary[name][scenario] = { frameMs: summarize(runs.flatMap(r => r.frames.map(f => f.duration))),
        calculationCalls: runs.map(r => r.repeated.calls), calculationMs: runs.map(r => r.repeated.calcMs),
        firstHoverMs: runs.map(r => r.firstHoverMs), transitionCalls: runs.map(r => r.changedRow.calls) };
    }
  }
  const report = { passed: true, scope: 'Worker frame CPU time, not GPU presentation or end-to-end latency',
    browser: await browser.version(), viewport: { width: 1600, height: 1000, dpr: 1 },
    sourceRevision: pin.revision, patchSha256: patchPin.patchSha256,
    sourceBlobs: { before: blobHash(original), after: blobHash(patched) },
    tooltipParity: true, statsUnchanged: true, summary, rounds };
  await writeFile(join(output, verifyOnly ? 'verification.json' : 'profile.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, summary, output }, null, 2));
} finally { await browser.close(); }

async function runRound(name, index) {
  const variant = variants[name];
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const faults = [];
  await context.route('**/payload/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(variant.manifest) }));
  await context.route(`**/payload/packages/${variant.hash}.zip`, route => route.fulfill({ contentType: 'application/octet-stream', body: variant.bytes }));
  const page = await context.newPage();
  page.on('pageerror', error => faults.push(error.message));
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const profile = () => page.evaluate(async () => (await window.__DESKTOP_POB__.getRuntimeProfile()).samples.gemHover);
  const reset = async () => { await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile(true)); await page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples()); };
  const playerStats = async () => {
    const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
    const xml = inflateSync(Buffer.from(code, 'base64url')).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(m => m[0]).sort();
  };
  const point = async (x,y) => {
    const box = await page.locator('canvas').boundingBox();
    const size = await page.locator('canvas').evaluate(c => ({ w:c.width, h:c.height }));
    return { x:box.x + x * box.width / size.w, y:box.y + y * box.height / size.h };
  };
  const until = async predicate => {
    const deadline = Date.now() + 30_000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, 'Gem hover did not settle'); await page.waitForTimeout(40); }
  };
  try {
    await page.goto(`${origin}/?payloadPrefetch=0`);
    await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout:120_000 });
    const boot = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
    assert.deepEqual(boot.filesystem.payload.packageOpens, ['core','timeless-shared','tree-3_29','tree-3_19','tree-legion']);
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), fixture);
    await page.keyboard.press('Control+2'); await flush();
    const initialStats = await playerStats();
    const clickControl = async name => {
      const [x,y,w,h] = (await profile()).controls[name];
      const p = await point(x+(name === 'quality' ? 8 : w/2),y+h/2);
      await page.mouse.click(p.x,p.y); await flush();
    };
    if ((await profile()).sortEnabled) await clickControl('sort');
    assert.equal((await profile()).sortEnabled, false);
    const result = { variant:name, round:index + 1, bootPackages:boot.filesystem.payload.packageOpens };
    for (const scenario of ['slot', 'imbued']) {
      await clickControl(scenario); await page.keyboard.press('Control+a'); await page.keyboard.type('Fire'); await flush();
      await until(async () => { const p = await profile(); return p?.dropped && !p.sorting; });
      const open = await profile();
      assert.equal(open.imbued, scenario === 'imbued');
      const [gx,gy,gw,gh] = open.bounds;
      const row = await point(gx + gw / 2, gy + gh + 2 + (gh - 4) / 2);
      await reset();
      // Three real frames satisfy PoB's unchanged two-frame hover debounce.
      for (let i=0;i<4;i++) { await page.mouse.move(row.x+i,row.y); await flush(); await page.waitForTimeout(20); }
      await until(async () => (await profile()).frameCount >= 2 && (await profile()).lines.length > 0);
      const first = await profile();
      const firstFrames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
      await reset();
      for (let i=0;i<30;i++) { await page.mouse.move(row.x + (i % 2 ? 5 : 6),row.y); await flush(); await page.waitForTimeout(16); }
      const repeated = await profile();
      const frames = await page.evaluate(() => window.__DESKTOP_POB__.frameSamples);
      assert.ok(frames.length >= 30);
      assert.equal(repeated.gem, first.gem);
      assert.deepEqual(repeated.lines, first.lines);
      if (name === 'after') assert.equal(repeated.calls, 0, 'Unchanged hover must use cached content');
      else assert.ok(repeated.calls >= 30, 'Baseline must execute per-frame comparisons');
      if (index < 2) await page.screenshot({ path:join(output, `${name}-${scenario}.png`) });
      await reset();
      const second = await point(gx + gw / 2, gy + gh + 2 + (gh - 4) * 1.5);
      for (let i=0;i<4;i++) { await page.mouse.move(second.x+i,second.y); await flush(); await page.waitForTimeout(20); }
      const changedRow = await profile();
      assert.notEqual(changedRow.gem, repeated.gem);
      assert.ok(changedRow.calls >= 1);
      assert.notDeepEqual(changedRow.lines, repeated.lines);
      result[scenario] = { gem:first.gem, lines:first.lines, firstHoverMs:summarize(firstFrames.map(f=>f.duration)).max, repeated, frames, changedRow };
      await page.keyboard.press('Escape'); await page.mouse.click(1300,800); await flush();
      assert.deepEqual(await playerStats(), initialStats, 'Cancelled gem previews preserve exported stats');
      if (verifyOnly) {
        const reopen = async () => {
          await clickControl(scenario); await page.keyboard.press('Control+a'); await page.keyboard.type('Fire'); await flush();
          await until(async () => !(await profile()).sorting);
          const [x,y,w,h] = (await profile()).bounds;
          const p = await point(x+w/2,y+h+2+(h-4)/2);
          for (let i=0;i<4;i++) { await page.mouse.move(p.x+i,p.y); await flush(); await page.waitForTimeout(20); }
          const state = await profile();
          assert.equal(state.gem, first.gem);
          await page.keyboard.press('Escape'); await page.mouse.click(1300,800); await flush();
          return state.lines;
        };
        assert.deepEqual(await reopen(), first.lines, 'Closing and reopening must retain correct tooltip content');
        await clickControl('quality'); await page.keyboard.press('Control+a'); await page.keyboard.type('20'); await page.keyboard.press('Enter'); await flush();
        assert.equal((await profile()).defaultQuality, 20);
        const qualityLines = await reopen();
        assert.notDeepEqual(qualityLines, first.lines, 'Changing default quality must invalidate the tooltip');
        await clickControl('quality'); await page.keyboard.press('Control+a'); await page.keyboard.type('0'); await page.keyboard.press('Enter'); await flush();
        assert.equal((await profile()).defaultQuality, 0);
        assert.deepEqual(await reopen(), first.lines, 'Restoring default quality must restore the original tooltip');
        assert.deepEqual(await playerStats(), initialStats);
        result[scenario].qualityLines = qualityLines;
      }
    }
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    assert.deepEqual(faults, []);
    return result;
  } catch (error) {
    await page.screenshot({ path:join(output, 'failure.png') }).catch(() => {});
    await writeFile(join(output, 'failure.json'), JSON.stringify({message:error.message,profile:await profile().catch(()=>null),faults},null,2));
    throw error;
  } finally { await context.close(); }
}
