import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2).filter(arg => arg !== '--resume');
const output = resolve(args[0] ?? 'tmp/desktop-pob-helper-workers/acceptance.json');
const privateFile = args[1];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const app = new URL('.', import.meta.url);
const identity = {
  wasmSha256: sha256(await readFile(new URL('upstream/packages/driver/dist/release/driver.wasm', app))),
  harnessSha256: sha256(await readFile(new URL('profile-unique-memory.mjs', app))),
  canonicalizerSha256: sha256(await readFile(new URL('canonical-export.mjs', app))),
  samplerSha256: sha256(await readFile(new URL('process-memory.mjs', app))),
  runtimeSourcesSha256: sha256(Buffer.concat(await Promise.all([
    'src/main.ts', 'source-pin.json', '.runtime/payload/manifest.json', 'upstream/packages/driver/unique-sort-workers.lua',
    ...['driver','worker','broker','helper-pool','helper-access','calc-helper','rpc','gc-policy'].map(name => 'upstream/packages/driver/src/js/' + name + '.ts'),
  ].map(path => readFile(new URL(path, app)))))),
};
let cached = [];
if (process.argv.includes('--resume')) {
  try { cached = JSON.parse(await readFile(output,'utf8')).reports; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const scratch = await mkdtemp(join(tmpdir(), 'pob-helper-acceptance-'));
const reports = [];
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const scores = report => report.phases.filter(p => p.name.startsWith('unique-sort-')).map(p => p.sort.values);
async function run(name, count, options = [], fixture) {
  const file = join(scratch, name + '.json');
  const fixtureSha256 = sha256(await readFile(fixture ?? new URL('./fixtures/guided import parity desktop 329.txt', app)));
  let report = cached.find(r => r.name === name && r.helperCount === count && r.fixtureSha256 === fixtureSha256 &&
    JSON.stringify(r.runOptions) === JSON.stringify(options) && Object.entries(identity).every(([key,value]) => r[key] === value));
  if (report) console.log('Reusing matching measured scenario:', name);
  else {
    await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ['profile-unique-memory.mjs', file,
      ...(fixture ? [fixture] : []), '--helpers=' + count, ...options], {stdio:'inherit', windowsHide:true});
    child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(name + ' exited ' + code)));
    });
    report = JSON.parse(await readFile(file, 'utf8'));
  }
  reports.push({name,runOptions:options,...report});
  await mkdir(resolve(output, '..'), {recursive:true});
  await writeFile(output, JSON.stringify({status:'running', reports}, null, 2) + '\n');
  assert.ok(report.memory.peakBytes <= 6 * 2 ** 30, name + ': hard 6 GiB limit');
  assert.ok(report.memory.peakBytes <= 5.5 * 2 ** 30, name + ': 5.5 GiB admission ceiling');
  assert.deepEqual(report.faults, []);
  return report;
}
function equivalent(serial, parallel) {
  for (const values of scores(parallel)) assert.deepEqual(values, scores(serial)[0], 'Every score and final position must match serial');
  for (const hash of parallel.canonicalExportHashes) assert.equal(hash, serial.canonicalExportHashes[0], 'Complete canonical build export');
}
function usedHelpers(report, count) {
  assert.equal(report.phases.at(-1).helpers.ready, count);
  assert.deepEqual(report.phases.at(-1).helpers.errors, []);
  assert.ok(report.phases.at(-1).helpers.completed >= scores(report).reduce((total, values) => total + values.length - Math.floor(values.length / (count + 1)), 0));
}
try {
  const serialTimes = [], parallelTimes = [], intervals = [];
  let baseline;
  for (let pair=0; pair<3; pair++) {
    const serial = await run('serial-' + pair, 0, ['--sort-only','--rounds=2'], privateFile);
    const parallel = await run('parallel-' + pair, 3, ['--sort-only','--rounds=2'], privateFile);
    if (baseline) equivalent(baseline, serial); else baseline = serial;
    equivalent(serial, parallel);
    usedHelpers(parallel, 3);
    serialTimes.push(serial.sortsMs.at(-1)); parallelTimes.push(parallel.sortsMs.at(-1));
    for (const frames of parallel.frames) for (let i=1;i<frames.length;i++) intervals.push(frames[i].at-frames[i-1].at);
  }
  const minion = 'fixtures/dominating blow of inspiring guardian 328.txt';
  const minionSerial = await run('minion-serial', 0, ['--sort-only','--rounds=1'], minion);
  const minionParallel = await run('minion-parallel', 2, ['--sort-only','--rounds=1'], minion);
  equivalent(minionSerial, minionParallel); usedHelpers(minionParallel, 2);
  const heavy = await run('retained-timeless-memory', 3, [], privateFile);
  equivalent(baseline, heavy); usedHelpers(heavy, 3);
  // Keep smaller-pool calibration visible without requiring it to be slow.
  // Memory improvements must not fail regression acceptance by speeding it up;
  // the existing three-helper default still has to meet every target below.
  const twoTimes = [];
  for (let trial=0; trial<3; trial++) {
    const two = await run(trial ? 'two-helpers-' + trial : 'two-helpers', 2, ['--sort-only','--rounds=2'], privateFile);
    equivalent(baseline, two); usedHelpers(two, 2);
    twoTimes.push(two.sortsMs.at(-1));
  }
  for (const fault of ['crash','timeout','cancel']) {
    const report = await run(fault, 3, [...(fault === 'timeout' ? [] : ['--sort-only']),'--rounds=2','--fault=' + fault], privateFile);
    equivalent(baseline, report);
    if (fault !== 'cancel') assert.ok(report.phases.at(-1).helpers.recycled >= 1);
  }
  await browserBoundaries();
  const summary = { serialMedianMs:median(serialTimes), parallelMedianMs:median(parallelTimes),
    speedup:1-median(parallelTimes)/median(serialTimes), medianFrameIntervalMs:median(intervals),
    peakGiB:Math.max(...reports.map(r => r.memory.peakBytes))/2 ** 30,
    parallelSamplesMs:parallelTimes, twoHelperWarmMs:median(twoTimes), twoHelperSamplesMs:twoTimes,
    sixSecondTargetMet: median(parallelTimes) <= 6000 && Math.max(...parallelTimes) <= 6000 };
  await writeFile(output, JSON.stringify({status:'measured',summary,reports},null,2)+'\n');
  assert.ok(summary.speedup >= .4, 'At least 40% faster than serial');
  assert.ok(summary.medianFrameIntervalMs <= 60, 'Responsive UI frame interval');
  if (!summary.sixSecondTargetMet) console.warn('Advisory 6-second warm-pool target missed; retaining exact relative acceptance for the live performance trial.');
  await writeFile(output, JSON.stringify({status:'passed',summary,reports},null,2)+'\n');
  console.log('Helper acceptance passed:', JSON.stringify(summary));
} finally {
  const owned = resolve(scratch);
  if (resolve(owned,'..') !== resolve(tmpdir()) || !basename(owned).startsWith('pob-helper-acceptance-')) throw new Error('Invalid scratch cleanup path');
  await rm(owned,{recursive:true,force:true});
}

async function browserBoundaries() {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const mobile = await browser.newContext({userAgent:'Mozilla/5.0 (Android; Mobile)',viewport:{width:640,height:1000}});
    try {
      const page = await mobile.newPage(); await page.goto('http://127.0.0.1:3010/?helpers=3');
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, {timeout:120000});
      await page.waitForTimeout(1000);
      assert.equal((await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile())).helpers.requested, 0);
      assert.equal(page.workers().some(w => w.url().includes('calc-helper.ts')), false);
    } finally { await mobile.close(); }
    const context = await browser.newContext({viewport:{width:1600,height:1000}});
    let releasePayload;
    const payloadGate = new Promise(resolve => releasePayload = resolve);
    try {
      const manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', import.meta.url)));
      const target = manifest.packages.find(p => p.id === 'tree-3_28');
      await context.route('**/payload/packages/' + target.sha256 + '.zip', async route => {
        await page.evaluate(() => window.__helperPayloadRequested = true);
        await payloadGate;
        await route.fulfill({body:'corrupt helper-first payload'});
      });
      await context.route('**/calc-helper.ts?*', async route => {
        const response = await route.fetch();
        const hook = `\nconst originalPost = MessagePort.prototype.postMessage;
          MessagePort.prototype.postMessage = function(request,...args) {
            if(request.operation==='open') {
              request.args[1]='/root/TreeData/3_28/tree.lua';
              MessagePort.prototype.postMessage=originalPost;
            }
            return originalPost.call(this,request,...args);
          };\n`;
        await route.fulfill({response,body:(await response.text())+hook});
      });
      // This boundary probe deliberately boots a helper without sorting so its
      // first filesystem access can fail while the UI remains idle. Explicit
      // eager startup keeps the opt-in lazy policy from postponing that probe.
      const page = await context.newPage(); await page.goto('http://127.0.0.1:3010/?helpers=1&helperStart=eager&payloadPrefetch=0');
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready && window.__helperPayloadRequested, null, {timeout:120000});
      const beforeFailure = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
      assert.equal(beforeFailure.filesystem.writes.root, 0);
      releasePayload();
      await page.waitForFunction(() => window.__DESKTOP_POB__?.errors.length, null, {timeout:120000});
      const errors = await page.evaluate(() => window.__DESKTOP_POB__.errors);
      assert.match(errors.join('\n'), /payload|hash|size|asset/i);
      const failed = await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
      assert.equal(failed.helpers.ready, 0);
      assert.deepEqual(failed.filesystem.writes, beforeFailure.filesystem.writes, 'Payload failure must not trigger regeneration or user writes');
      assert.equal(await page.locator('.payload-progress-error[role="alert"]').isVisible(), true);
      console.log('Mobile serial mode and helper-first payload containment passed.');
    } finally { releasePayload(); await context.close(); }
  } finally { await browser.close(); }
}
