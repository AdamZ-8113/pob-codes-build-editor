import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir, cpus } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { startProcessMemory } from '../../scripts/lib/process-memory.mjs';
import { canonicalExportTree } from '../../scripts/lib/canonical-export.mjs';

// Acceptance diagnostics only: original Lua operations and checked payload data
// are unchanged. Instrumented archives are served in memory to this context.
const app = new URL('../../', import.meta.url);
const require = createRequire(new URL('./upstream/deno.json', app));
const AdmZip = require('adm-zip');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noInstrumentation = process.argv.includes('--no-instrumentation');
const sortOnly = process.argv.includes('--sort-only');
const withHeatmap = process.argv.includes('--heatmap');
const runtimeArgument = process.argv.find(arg => arg.startsWith('--runtime='));
const runtimeDirectory = runtimeArgument ? resolve(runtimeArgument.slice('--runtime='.length)) : new URL('upstream/packages/driver/dist/release/', app);
const runtimeFile = name => runtimeArgument ? join(runtimeDirectory, name) : new URL(name, runtimeDirectory);
const gcArgument = process.argv.find(arg => arg.startsWith('--gc-pause='));
const helperGcArgument = process.argv.find(arg => arg.startsWith('--helper-gc-pause='));
const gcPause = gcArgument ? Number(gcArgument.split('=')[1]) : undefined;
const helperGcPause = helperGcArgument ? Number(helperGcArgument.split('=')[1]) : undefined;
for (const value of [gcPause, helperGcPause]) assert.ok(value === undefined || Number.isInteger(value) && value >= 100 && value <= 400);
const roundsArgument = process.argv.find(arg => arg.startsWith('--rounds='));
const rounds = Number(roundsArgument?.split('=')[1] ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
const faultArgument = process.argv.find(arg => arg.startsWith('--fault='));
const fault = faultArgument?.split('=')[1];
assert.ok(!fault || ['timeout', 'crash', 'cancel'].includes(fault));
const helperArgument = process.argv.find(arg => arg.startsWith('--helpers='));
const helperCount = Number(helperArgument?.split('=')[1] ?? 0);
const helperStartArgument = process.argv.find(arg => arg.startsWith('--helper-start='));
// Failure injection needs an actual worker before the first measured sort.
// Match ordinary runtime startup unless explicitly measuring the lazy policy.
const bootFault = ['timeout', 'crash'].includes(fault);
const helperStart = helperStartArgument?.split('=')[1] ?? 'eager';
assert.ok(['eager', 'lazy'].includes(helperStart), 'helper-start must be eager or lazy');
assert.ok(!bootFault || helperStart === 'eager', 'Helper timeout/crash injection requires --helper-start=eager');
const [outputFile = 'tmp/desktop-pob-helper-workers/serial-memory.json', buildFile] = process.argv.slice(2).filter(arg => !['--no-instrumentation', '--sort-only', '--heatmap', runtimeArgument, gcArgument, helperGcArgument, helperArgument, helperStartArgument, roundsArgument, faultArgument].includes(arg));
const fixture = await readFile(buildFile ?? new URL('./fixtures/guided import parity desktop 329.txt', app));
const code = fixture.toString().trim();
const manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', app)));
const core = manifest.packages.find(p => p.id === 'core');
const archive = await readFile(new URL(`.runtime/payload/packages/${core.sha256}.zip`, app));
assert.equal(sha256(archive), core.sha256);
const zip = new AdmZip(archive);
const diagnostics = `
do
  local encode = require('dkjson').encode
  local installed, active, completed = false, nil, 0
  local draw, buildList = ItemDBClass.Draw, ItemDBClass.ListBuilder
  ItemDBClass.ListBuilder = function(self, ...)
    local result = table.pack(buildList(self, ...))
    if self.dbType == 'UNIQUE' then completed = completed + 1 end
    return table.unpack(result, 1, result.n)
  end
  ItemDBClass.Draw = function(self, ...)
    local result = table.pack(draw(self, ...))
    if self.dbType == 'UNIQUE' then active = self end
    if not installed and getRuntimeProfile then
      installed = true
      local profile = getRuntimeProfile
      getRuntimeProfile = function(reset)
        local result = profile(reset)
        local state = {completed = completed}
        if active then
          local sort = active.controls.sort
          local x, y = sort:GetPos(); local w, h = sort:GetSize()
          state.sortBounds = {x, y, w, h}
          state.dropY = sort.dropUp and y - sort.dropHeight - 4 or y + h
          state.dropHeight = sort.dropHeight
          state.scrollOffset = sort.controls.scrollBar.offset
          state.options = {}
          for i, item in ipairs(sort.list) do state.options[i] = {label = item.label, mode = item.sortMode} end
          state.mode = active.sortMode
          state.pending = active.listBuilder ~= nil or active.listBuildFlag or false
          state.count = #(active.list or {})
          if not state.pending and active.sortDetail and active.sortDetail.stat then
            state.values = {}
            for i, item in ipairs(active.list or {}) do
              state.values[i] = {item.name, item.measuredPower == -math.huge and '-inf' or string.format('%.17g', item.measuredPower)}
            end
          end
        end
        return result:sub(1, -2) .. ',"uniqueSortProbe":' .. encode(state) .. '}'
      end
    end
    return table.unpack(result, 1, result.n)
  end
end
`;
const content = Buffer.from(zip.readAsText('Classes/ItemDBControl.lua') + '\n' + diagnostics);
zip.updateFile('Classes/ItemDBControl.lua', content);
const bytes = zip.toBuffer();
const file = core.files.find(f => f.path === 'Classes/ItemDBControl.lua');
core.uncompressedBytes += content.length - file.bytes;
file.bytes = content.length; core.bytes = bytes.length; core.sha256 = sha256(bytes);
const profileDirectory = await mkdtemp(join(tmpdir(), 'pob-worker-memory-'));
let context, memory;
const phases = [], sorts = [], exports = [], exportLeaves = [], frames = [], faults = [];
let heatmapMs;
const runtimeRequests = {};
try {
  context = await chromium.launchPersistentContext(profileDirectory, { channel: 'chrome', headless: true,
    viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  // Keep the acceptance session independent of development-file reloads.
  // Runtime RPC uses MessagePorts and does not need a WebSocket connection.
  await context.routeWebSocket('**', socket => socket.close());
  const browser = context.browser();
  const cdp = await browser.newBrowserCDPSession();
  const processes = await cdp.send('SystemInfo.getProcessInfo');
  const browserPid = processes.processInfo.find(p => p.type === 'browser')?.id;
  memory = await startProcessMemory(browserPid);
  await memory.mark('blank-browser');
  if (runtimeArgument) {
    // Serve the saved native build to this isolated browser only; no HMR or
    // replacement of the maintainer's running app during an A/B comparison.
    for (const name of ['driver.mjs', 'driver.wasm']) {
      const body = await readFile(runtimeFile(name));
      await context.route('**/dist/release/' + name + '*', route => {
        runtimeRequests[name] = (runtimeRequests[name] ?? 0) + 1;
        return route.fulfill({contentType: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript', body});
      });
    }
  }
  if (!noInstrumentation) {
    await context.route('**/payload/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(manifest) }));
    await context.route(`**/payload/packages/${core.sha256}.zip`, route => route.fulfill({ contentType: 'application/octet-stream', body: bytes }));
  }
  const page = context.pages()[0];
  page.on('console', message => { if (['warning','error'].includes(message.type())) console.error(message.text().slice(0,1500)); });
  page.on('pageerror', error => { if (!(fault === 'crash' && error.message.includes('Expected helper crash'))) faults.push(error.message); });
  const parameters = new URLSearchParams({helpers:String(helperCount), helperStart});
  if (gcPause !== undefined) parameters.set('gcPause', String(gcPause));
  if (helperGcPause !== undefined) parameters.set('helperGcPause', String(helperGcPause));
  await page.goto('http://127.0.0.1:3010/?' + parameters);
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120000 });
  if (runtimeArgument) assert.ok(runtimeRequests['driver.mjs'] && runtimeRequests['driver.wasm'], 'Saved runtime must actually be served');
  const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
  const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
  const record = async name => {
    await memory.mark(name);
    const value = await profile();
    phases.push({ name, wasmBytes: value.wasmBytes, luaKiB: value.samples.luaKiB,
      gcPause: value.samples.gcPause, timelessLoadedMask: value.samples.timelessLoadedMask, sort: value.samples.uniqueSortProbe, helpers: value.helpers });
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    assert.deepEqual(faults, []);
    console.log(JSON.stringify({phase: name, privateGiB: memory.report().milestones.at(-1).privateBytes / 2 ** 30, helpers: value.helpers}));
  };
  await record('boot');
  await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  await page.keyboard.press('Control+3'); await flush();
  await record('import');
  const point = async (x, y) => {
    const canvas = page.locator('canvas'), box = await canvas.boundingBox();
    const size = await canvas.evaluate(c => [c.width, c.height]);
    return { x: box.x + x * box.width / size[0], y: box.y + y * box.height / size[1] };
  };
  const search = async text => {
    const [,,,,x,y,w,h] = (await profile()).samples.uniqueDbBounds;
    const p = await point(x + w / 2, y + h / 2);
    await page.mouse.click(p.x, p.y); await page.keyboard.press('Control+a');
    if (text) await page.keyboard.type(text); else await page.keyboard.press('Backspace');
    await flush();
  };
  const until = async predicate => {
    const deadline = Date.now() + 120000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, 'Unique sort/memory scenario did not settle');
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
      await page.waitForTimeout(100);
    }
  };
  const families = ['Glorious Vanity', 'Lethal Pride', 'Brutal Restraint', 'Militant Faith', 'Elegant Hubris', 'Heroic Tragedy',
    'Festering Vengeance', 'Extinguishing Grasp', 'Baleful Dominion', 'Destructive Aspiration', 'Reclaimed Malevolence'];
  if (helperCount) await until(async () => {
    const helpers = (await profile()).helpers;
    // Lazy sessions advertise capacity while retaining no worker interpreters;
    // their first actual delegated request, rather than this harness, boots it.
    return helpers.ready === helperCount || helperStart === 'lazy' && helpers.state === 'armed' || helpers.errors.length > 0;
  });
  if (['timeout', 'crash'].includes(fault)) {
    const worker = page.workers().find(worker => worker.url().includes('calc-helper.ts'));
    assert.ok(worker, 'Actual helper worker exists');
    await worker.evaluate(fault => {
      const original = self.onmessage;
      self.onmessage = event => {
        if (event.data.job?.items) {
          if (fault === 'crash') throw new Error('Expected helper crash');
          return;
        }
        return original(event);
      };
    }, fault);
  }
  for (const [index, name] of (sortOnly ? [] : families).entries()) {
    await search(name);
    const [x,y,w] = (await profile()).samples.uniqueDbBounds;
    const p = await point(x+w/2, y+8); await page.mouse.move(p.x,p.y); await flush();
    await until(async () => ((await profile()).samples.timelessLoadedMask & (1 << index)) !== 0);
    await record(`timeless-family-${index+1}`);
  }
  await search('');
  for (let round = 0; round < (noInstrumentation ? 0 : rounds); round++) {
    // Fresh imported build invokes normal upstream invalidation if a cache exists.
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
    await page.keyboard.press('Control+3'); await flush();
    await until(async () => !(await profile()).samples.uniqueSortProbe.pending);
    const state = (await profile()).samples.uniqueSortProbe;
    const target = state.options.findIndex(o => o.label === 'Sort by Hit DPS');
    assert.ok(target >= 0, 'Supplied PoB exposes the Hit DPS stat sort');
    const [x,y,w,h] = state.sortBounds;
    const p = await point(x+w/2, y+h/2); await page.mouse.click(p.x,p.y);
    await flush();
    const dropped = (await profile()).samples.uniqueSortProbe;
    const rowOffset = target * (h - 4) - dropped.scrollOffset;
    assert.ok(rowOffset >= 0 && rowOffset + h - 4 <= dropped.dropHeight, 'Target stat is visible in the native dropdown');
    const row = await point(x + w / 2, dropped.dropY + rowOffset + (h-4)/2);
    await page.evaluate(() => window.__DESKTOP_POB__.clearFrameSamples());
    const start = performance.now(); await page.mouse.click(row.x,row.y);
    await page.mouse.move(1450,850); await flush();
    if (fault === 'cancel' && round === 0) {
      // A fresh build has the same output revision but a different lifetime.
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
      await page.keyboard.press('Control+3'); await flush();
      await until(async () => !(await profile()).samples.uniqueSortProbe.pending);
      continue;
    }
    await until(async () => {
      const value = (await profile()).samples.uniqueSortProbe;
      return value.mode === state.options[target].mode && !value.pending && value.completed > state.completed;
    });
    sorts.push(performance.now()-start);
    frames.push(await page.evaluate(() => window.__DESKTOP_POB__.frameSamples));
    if (withHeatmap && round === rounds - 1) {
      await page.keyboard.press('Control+1'); await flush();
      await page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile(true));
      const dimensions = await page.locator('canvas').evaluate(c => [c.width,c.height]);
      const button = await point(930, dimensions[1]-12);
      const heatmapStart = performance.now(); await page.mouse.click(button.x,button.y);
      await until(async () => {
        const state = (await profile()).samples;
        return !state.heatmapPending && state.heatmap.length > 0;
      });
      heatmapMs = performance.now() - heatmapStart;
      await record('heatmap');
    }
    const exported = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
    const xml = inflateSync(Buffer.from(exported, 'base64url')).toString();
    const ordered = await page.evaluate(xml => {
      const root = new DOMParser().parseFromString(xml, 'application/xml');
      const walk = node => node.nodeType === 1 ? [node.tagName, [...node.attributes].map(a => [a.name,a.value]).sort(),
        [...node.childNodes].map(walk).filter(v => v !== null)] : node.textContent.trim() || null;
      return JSON.stringify(walk(root.documentElement));
    }, xml);
    const canonical = JSON.stringify(canonicalExportTree(JSON.parse(ordered)));
    exports.push(sha256(canonical));
    const leaves = {};
    const flatten = (node, path) => {
      if (typeof node === 'string') { leaves[path] = sha256(node); return; }
      for (const [key,value] of node[1]) leaves[path + '/@' + key] = sha256(value);
      node[2].forEach((child,index) => flatten(child, path + '/' + (typeof child === 'string' ? '#text' : child[0]) + '[' + index + ']'));
    };
    flatten(JSON.parse(canonical), 'root'); exportLeaves.push(leaves);
    await record(`unique-sort-${round+1}`);
  }
  await record('sustained-final');
  const report = { date: new Date().toISOString(), browser: browser.version(), browserPid,
    instrumentation: noInstrumentation ? 'none; unchanged served payload; Timeless memory workload only' : 'test-only ListBuilder/Draw/profile wrappers; fresh-build uncached sorts',
    cpu: cpus()[0].model,
    logicalProcessors: cpus().length, fixtureSha256: sha256(fixture), privateFixture: Boolean(buildFile),
    helperCount, helperStart, fault, gcPause, helperGcPause, heatmapMs, runtimeRequests,
    sourcePin: JSON.parse(await readFile(new URL('source-pin.json', app))),
    driverRevision: execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
    workingDiffSha256: sha256(execFileSync('git', ['diff', '--', '.'])),
    wasmSha256: sha256(await readFile(runtimeFile('driver.wasm'))),
    runtimeSourcesSha256: sha256(Buffer.concat(await Promise.all([
      'src/main.ts', 'source-pin.json', '.runtime/payload/manifest.json', 'upstream/packages/driver/unique-sort-workers.lua',
      ...['driver','worker','broker','helper-pool','helper-access','calc-helper','rpc','gc-policy'].map(name => 'upstream/packages/driver/src/js/' + name + '.ts'),
    ].map(path => readFile(new URL(path, app)))))),
    harnessSha256: sha256(await readFile(new URL('tools/profiles/profile-unique-memory.mjs', app))),
    canonicalizerSha256: sha256(await readFile(new URL('scripts/lib/canonical-export.mjs', app))),
    samplerSha256: sha256(await readFile(new URL('scripts/lib/process-memory.mjs', app))),
    phases, sortsMs: sorts, canonicalExportHashes: exports, exportLeaves, frames, faults, memory: memory.report() };
  await mkdir(resolve(outputFile, '..'), {recursive:true});
  await writeFile(outputFile, JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output:outputFile, peakGiB:report.memory.peakBytes / 2 ** 30, sortsMs:sorts}));
} finally {
  try { await memory?.stop(); } finally {
    try { await context?.close(); } finally {
      const owned = resolve(profileDirectory);
      if (resolve(owned, '..') !== resolve(tmpdir()) || !basename(owned).startsWith('pob-worker-memory-')) throw new Error('Unexpected profile cleanup path');
      await rm(owned, {recursive:true,force:true});
    }
  }
}
