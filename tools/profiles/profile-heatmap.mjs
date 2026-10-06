import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startProcessMemory } from '../../scripts/lib/process-memory.mjs';
import { loadBuildInput, readCorePackage, loadSourceTransforms, rewriteCorePackage, routeCorePackage, sha256 } from './core-package-overlay.mjs';
import { comparePowerSnapshots } from './power-snapshot-parity.mjs';
import { runRestartScenarios } from './heatmap-restarts.mjs';

const args = process.argv.slice(2);
const argument = (name, fallback) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const repeated = name => args.filter(a => a.startsWith(`--${name}=`)).map(a => a.slice(name.length + 3));
const origin = argument('origin', 'http://127.0.0.1:3010/');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Heatmap experiments require a loopback server');
const metric = argument('metric', 'Hit DPS'), depth = argument('depth', '5');
const scenario = argument('scenario', 'timing');
const reportMode = argument('report', scenario === 'restarts' ? 'shown' : 'hidden');
const rounds = Number(argument('rounds', '5')), warm = Number(argument('warm', '3'));
const review = args.includes('--review'), reviewArm = argument('arm', 'candidate');
assert.ok(['5', '10', '15', 'All'].includes(depth), 'Depth must be 5, 10, 15 or All');
assert.ok(['hidden', 'shown', 'deferred'].includes(reportMode), 'Report must be hidden, shown or deferred');
assert.ok(['timing', 'restarts'].includes(scenario), 'Unknown scenario');
assert.ok(scenario !== 'restarts' || (reportMode === 'shown' && !review), 'Restart scenario requires an automated shown-report run');
assert.ok(['baseline', 'candidate'].includes(reviewArm), 'Arm must be baseline or candidate');
assert.ok(Number.isInteger(rounds) && rounds > 0 && Number.isInteger(warm) && warm >= 0, 'Invalid sample counts');
const output = resolve(argument('out', `tmp/power-report-speed/${new Date().toISOString().replaceAll(':', '-')}.json`));
const buildUrl = argument('build-url');
const buildFile = argument('build-file', buildUrl ? undefined : fileURLToPath(new URL('../../fixtures/guided import parity desktop 329.txt', import.meta.url)));
const input = await loadBuildInput({ buildFile, buildUrl });
const source = await readCorePackage(origin);
const diagnostics = await readFile(new URL('./heatmap-profile.lua', import.meta.url), 'utf8');
const arms = {};
for (const name of ['baseline', 'candidate']) {
  const transforms = await loadSourceTransforms(repeated(name === 'baseline' ? 'baseline-transform' : 'source-transform'), 'Classes/CalcsTab.lua');
  arms[name] = {
    overlay: rewriteCorePackage(source, [...transforms.transforms, { path: 'Classes/TreeTab.lua', transform: text => `${text}\n${diagnostics}` }]),
    modules: transforms.modules,
    query: argument(`${name}-query`, ''),
  };
}
const calibration = JSON.stringify(arms.baseline.overlay.evidence) === JSON.stringify(arms.candidate.overlay.evidence) && arms.baseline.query === arms.candidate.query;
const noiseReference = !calibration && !review
  ? JSON.parse(await readFile(resolve(argument('noise-floor', 'tmp/power-report-speed/noise-floor.json')), 'utf8')) : undefined;
if (noiseReference) {
  assert.ok(noiseReference.passed && noiseReference.calibration, 'Noise reference must be a successful A/A calibration');
  assert.equal(noiseReference.arms.baseline.sourceCoreHash, arms.baseline.overlay.sourceCoreHash, 'Noise reference core identity');
}
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null, p95: sorted[Math.max(0, Math.ceil(n * .95) - 1)] ?? null, max: sorted.at(-1) ?? null };
};
const browser = await chromium.launch({ headless: !review, channel: 'chrome' });
const report = {
  schemaVersion: 1, measuredAt: new Date().toISOString(), passed: false, review, calibration,
  harnessNodeVersion: process.version,
  noiseReferenceSha256: noiseReference ? sha256(JSON.stringify(noiseReference)) : undefined,
  inputXmlSha256: input.xmlHash, metric, depth, reportMode, scenario, roundsRequested: rounds, warmRequested: warm,
  environment: { browser: browser.version(), cpu: cpus()[0]?.model, logicalCores: cpus().length, viewport: { width: 1600, height: 1000, dpr: 1 } },
  harnessSha256: sha256(await readFile(new URL(import.meta.url))), diagnosticsSha256: sha256(diagnostics),
  scope: 'Same binary, new context per arm per round; cold means first target metric after discarded heatmap warm-up. Warm samples follow an alternate metric. Readiness is CPU completion, not GPU presentation. Fixed Lua hash seed in both arms; clocks used for timing remain real.',
  arms: Object.fromEntries(Object.entries(arms).map(([name, arm]) => [name, { sourceCoreHash: arm.overlay.sourceCoreHash, routedCoreHash: arm.overlay.core.sha256, fileHashes: arm.overlay.evidence, modules: arm.modules, query: arm.query }])),
  runs: [], restarts: [], errors: [],
};
let memory, stage = 'startup';
const snapshotReferences = new Map();
const freshReferences = new Set();

async function runArm(name, round) {
  const arm = arms[name];
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  const faults = [], nativeResponses = [];
  let seededRuntimeRequests = 0;
  // Also bounds pending browser RPCs, which Playwright's ordinary action timeout does not cover.
  const watchdog = setTimeout(() => void context.close().catch(() => {}), 20 * 60 * 1000);
  try {
    await context.routeWebSocket('**', socket => socket.close());
    // Lua table iteration must be reproducible for exact floating-point snapshot parity.
    await context.route(/\/driver(?:-[\w-]+)?\.mjs(?:\?|$)/, async route => {
      const body = await (await route.fetch()).text();
      seededRuntimeRequests++;
      await route.fulfill({ contentType: 'text/javascript', body: 'Date.now = () => 1790812800000;\n' + body });
    });
    await routeCorePackage(context, arm.overlay);
    const page = await context.newPage();
    page.on('pageerror', () => faults.push('pageerror'));
    page.on('response', response => {
      if (/\/driver(?:-[\w-]+)?\.wasm(?:\?|$)/.test(response.url())) nativeResponses.push(response.body().then(sha256));
    });
    const url = new URL(origin);
    for (const [key, value] of new URLSearchParams(arm.query.replace(/^\?/, ''))) url.searchParams.set(key, value);
    stage = `${name}:${round}:boot`;
    console.log(stage);
    await page.goto(url.href);
    await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, { timeout: 120000 });
    assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.errors.length), 0, 'No startup Lua errors');
    const wasmHashes = [...new Set(await Promise.all(nativeResponses))];
    assert.equal(wasmHashes.length, 1, 'Actual Wasm identity recorded');
    assert.ok(seededRuntimeRequests > 0, 'Deterministic Lua seed installed');
    arm.wasmSha256 ??= wasmHashes[0];
    assert.equal(wasmHashes[0], arm.wasmSha256, 'Stable Wasm identity');
    report.arms[name].wasmSha256 = arm.wasmSha256;
    stage = `${name}:${round}:import`;
    await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), input.buildCode);
    const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
    const profile = (reset = false) => page.evaluate(reset => window.__DESKTOP_POB__.getRuntimeProfile(reset), reset);
    const state = async () => (await profile()).samples.nodePower;
    const errors = async () => {
      assert.deepEqual(faults, [], 'No page errors');
      assert.equal(await page.evaluate(() => window.__DESKTOP_POB__.errors.length), 0, 'No Lua errors');
    };
    await page.keyboard.press('Control+1'); await flush();
    await errors();
    assert.ok(await state(), 'Routed heatmap diagnostics loaded');
    const clickPoint = async (x, y) => {
      const canvas = page.locator('canvas'), bounds = await canvas.boundingBox();
      const dims = await canvas.evaluate(c => [c.width, c.height]);
      const startedAt = performance.now();
      await page.mouse.click(bounds.x + x * bounds.width / dims[0], bounds.y + y * bounds.height / dims[1]);
      await flush();
      return startedAt;
    };
    const clickControl = async key => {
      const [x, y, w, h] = (await state()).controls[key].bounds;
      return clickPoint(x + w / 2, y + h / 2);
    };
    // Click the actual dropdown row; arrowing through metrics starts unwanted builders.
    const select = async (key, label) => {
      let control = (await state()).controls[key];
      const index = control.options.indexOf(label);
      assert.ok(index >= 0, `${key}: requested choice exists`);
      if (control.selected === index + 1) return false;
      await clickControl(key);
      control = (await state()).controls[key];
      const [x, y, w, h] = control.bounds, line = h - 4;
      let offset = index * line - control.scrollOffset;
      for (let step = 0; (offset < 0 || offset + line > control.dropHeight) && step < 80; step++) {
        const dropY = control.dropUp ? y - control.dropHeight - 4 : y + h;
        const canvas = page.locator('canvas'), bounds = await canvas.boundingBox(), dims = await canvas.evaluate(c => [c.width, c.height]);
        await page.mouse.move(bounds.x + (x + w - 6) * bounds.width / dims[0], bounds.y + (dropY + control.dropHeight / 2) * bounds.height / dims[1]);
        await page.mouse.wheel(0, offset < 0 ? -100 : 100); await flush();
        control = (await state()).controls[key]; offset = index * line - control.scrollOffset;
      }
      assert.ok(offset >= 0 && offset + line <= control.dropHeight, 'Dropdown row visible');
      const dropY = control.dropUp ? y - control.dropHeight - 4 : y + h;
      const startedAt = await clickPoint(x + w / 2, dropY + offset + line / 2);
      assert.equal((await state()).controls[key].selected, index + 1, 'Native dropdown selected requested value');
      return startedAt;
    };
    const waitRun = async (previous, start, target, sample, { requireReport = reportMode === 'shown', expectedDepth = depth, parityGroup = 'target', deferOpen = reportMode === 'deferred' && !!sample } = {}) => {
      let heatmapWallMs, reportWallMs, current, p, earlyHeatmap, openedAt;
      let peakLuaKiB = 0, peakWasmBytes = 0;
      do {
        await page.waitForTimeout(40);
        p = await profile();
        peakLuaKiB = Math.max(peakLuaKiB, p.samples.luaKiB);
        peakWasmBytes = Math.max(peakWasmBytes, p.wasmBytes);
        await errors();
        current = p.samples.nodePower.runs.at(-1);
        if (current?.id > previous) {
          const observedAt = performance.now() - start;
          if (current.reportReadyAt != null) reportWallMs ??= observedAt;
          if (current.heatmapReadyAt != null && heatmapWallMs == null) {
            heatmapWallMs = observedAt;
            // Observe the heatmap at its own readiness boundary, before report work can alter it.
            earlyHeatmap = (await profile(true)).samples.nodePower.snapshots?.heatmap;
          }
          if (heatmapWallMs != null && deferOpen && openedAt == null) {
            assert.equal(p.samples.nodePower.reportShown, false, 'Deferred report starts hidden');
            if (current.pending) {
              assert.equal(p.samples.nodePower.reportRows, 0, 'No stale or partial deferred report rows');
              assert.equal(p.samples.nodePower.toastShown, false, 'Hidden heatmap completion clears progress toast');
            }
            openedAt = await clickControl('report');
            continue;
          }
          if (heatmapWallMs != null && (!(requireReport || deferOpen) || reportWallMs != null)) break;
        }
        assert.ok(performance.now() - start < 240000, 'Builder readiness deadline');
      } while (true);
      assert.equal(current.metric, target, 'Measured intended metric');
      assert.equal(String(current.depth), expectedDepth, 'Measured intended depth');
      // Snapshot only after readiness; retain hashes, never node text or build data.
      const captured = await profile(true);
      const snapshots = captured.samples.nodePower.snapshots;
      if (earlyHeatmap) snapshots.heatmap = earlyHeatmap;
      assert.ok(snapshots?.heatmap, 'Heatmap snapshot available');
      if (requireReport || deferOpen) assert.ok(snapshots.full, 'Completed report has full snapshot');
      assert.equal(current.reportCallbacks, current.reportReadyAt == null ? 0 : 1, 'One callback per completed report');
      if (current.token != null) {
        assert.equal(current.heatmapCallbacks, 1, 'One heatmap callback per run');
        if (current.reportReadyAt != null) assert.equal(current.publishedToken, current.token, 'Only the current run token publishes');
        for (const phase of Object.values(current.progress)) assert.equal(phase.valid, true, 'Finite monotonic phase progress');
        for (const category of ['pathAdd', 'allocatedRemove', 'removePath', 'clusterNotable']) assert.equal(current.heatmapCalculators[category].count, 0, 'Heatmap excludes report-only calculations');
        if (current.pending) {
          assert.equal(captured.samples.nodePower.reportRows, 0, 'Pending list stays empty');
          assert.equal(captured.samples.nodePower.toastShown, false, 'Pending hidden report has no toast');
        }
      }
      const snapshotHashes = Object.fromEntries(Object.entries(snapshots).map(([key, text]) => [key, sha256(text)]));
      const result = { arm: name, round, sample, parityGroup, ...current, heatmapLuaMs: current.heatmapReadyAt - current.startedAt, reportLuaMs: current.reportReadyAt == null ? null : current.reportReadyAt - current.startedAt, heatmapWallMs, reportWallMs: reportWallMs ?? null, openedReportWallMs: openedAt == null ? null : Math.max(0, start + reportWallMs - openedAt), snapshots: snapshotHashes, runtimeHeatmap: captured.samples.summary.heatmap, luaKiB: captured.samples.luaKiB, wasmBytes: captured.wasmBytes, peakLuaKiB: Math.max(peakLuaKiB, captured.samples.luaKiB), peakWasmBytes: Math.max(peakWasmBytes, captured.wasmBytes), memoryScope: 'Peak observed during readiness polling; may miss transients within a coroutine resume', errors: [] };
      if (sample) {
        report.runs.push(result);
        for (const [kind, text] of Object.entries(snapshots)) {
          const referenceKey = `${parityGroup}/${kind}`;
          const reference = snapshotReferences.get(referenceKey);
          if (!reference) snapshotReferences.set(referenceKey, { text, arm: name, round, sample });
          else {
            const mismatch = comparePowerSnapshots(reference.text, text);
            if (mismatch) {
              report.snapshotMismatch = { kind, metric: target, parityGroup, reference: { arm: reference.arm, round: reference.round, sample: reference.sample }, candidate: { arm: name, round, sample }, ...mismatch };
              assert.fail(`${kind}: identical snapshots within and across arms`);
            }
          }
        }
        console.log(JSON.stringify({ arm: name, round, sample, heatmapLuaMs: result.heatmapLuaMs, reportLuaMs: result.reportLuaMs, calculators: result.calculators }));
      }
      if (deferOpen) await clickControl('report');
      return result;
    };
    stage = `${name}:${round}:warmup`;
    let initial = await state();
    if (initial.enabled) await clickControl('heatmap');
    await select('depth', depth);
    const beforeWarmup = (await state()).runs.at(-1)?.id ?? 0;
    const warmStart = await clickControl('heatmap');
    const warmMetric = (await state()).controls.metric;
    await waitRun(beforeWarmup, warmStart, warmMetric.options[warmMetric.selected - 1], undefined, { requireReport: false });
    if (reportMode === 'shown') await clickControl('report');
    assert.equal((await state()).reportShown, reportMode === 'shown', 'Requested report visibility');
    if (scenario === 'restarts') {
      await runRestartScenarios({ arm: name, round, warm, input, page, state, profile, flush, select, clickControl, clickPoint, waitRun, freshReferences, report,
        setStage: value => { stage = value; console.log(stage); } });
      await errors();
      return;
    }
    const options = (await state()).controls.metric.options;
    const alternate = options.find(label => label !== metric);
    const measure = async (label, sample) => {
      stage = `${name}:${round}:${sample ?? 'alternate'}`;
      console.log(stage);
      const previous = (await state()).runs.at(-1)?.id ?? 0;
      await profile(true);
      const start = await select('metric', label);
      assert.notEqual(start, false, 'Selection must trigger a fresh builder');
      return waitRun(previous, start, label, sample);
    };
    if (warmMetric.options[warmMetric.selected - 1] === metric) await measure(alternate);
    await measure(metric, 'cold');
    if (review) {
      console.log(`Review ready: ${name}, ${metric}, depth ${depth}. Close Chrome to finish.`);
      clearTimeout(watchdog);
      await new Promise(resolve => browser.once('disconnected', resolve));
      return;
    }
    for (let pass = 0; pass < warm; pass++) {
      await measure(alternate);
      await measure(metric, `warm-${pass + 1}`);
    }
    if (memory) await memory.mark(`${name}-${round}-complete`);
    await errors();
  } finally { clearTimeout(watchdog); await context.close().catch(() => {}); }
}

try {
  if (args.includes('--memory')) {
    const cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send('SystemInfo.getProcessInfo');
    memory = await startProcessMemory(info.processInfo.find(p => p.type === 'browser').id);
    await cdp.detach();
  }
  if (review) await runArm(reviewArm, 0);
  else {
    for (let round = 0; round < rounds; round++) for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await runArm(name, round);
    assert.equal(arms.baseline.wasmSha256, arms.candidate.wasmSha256, 'Same binary in both arms');
    if (noiseReference) {
      assert.equal(noiseReference.arms.baseline.wasmSha256, arms.baseline.wasmSha256, 'Noise reference Wasm identity');
      assert.deepEqual(noiseReference.environment, report.environment, 'Noise reference browser and machine identity');
    }
    for (const group of new Set(report.runs.map(run => run.parityGroup))) for (const kind of ['heatmap', 'full']) {
      const runs = report.runs.filter(run => run.parityGroup === group);
      const hashes = runs.map(run => run.snapshots[kind]).filter(Boolean);
      assert.ok(kind !== 'heatmap' || hashes.length === runs.length, 'Every run has heatmap parity evidence');
      assert.ok(new Set(hashes).size <= 1, `${group}/${kind}: identical snapshots within and across arms`);
    }
    report.snapshotParity = true;
    report.summary = {};
    report.comparisons = [];
    for (const group of new Set(report.runs.map(run => run.parityGroup))) for (const sample of ['cold', 'warm']) {
      const matching = run => run.parityGroup === group && (sample === 'cold' ? run.sample === 'cold' || run.sample.startsWith('cold:') : run.sample.startsWith('warm-'));
      for (const field of ['heatmapLuaMs', 'reportLuaMs', 'heatmapWallMs', 'reportWallMs', 'resumes', 'maxResumeMs']) {
        const byArm = {};
        for (const name of ['baseline', 'candidate']) {
          byArm[name] = summarize(report.runs.filter(run => run.arm === name && matching(run)).map(run => run[field]).filter(value => value != null));
          report.summary[`${scenario === 'timing' ? '' : `${group}.`}${name}.${sample}.${field}`] = byArm[name];
        }
        if (!byArm.baseline.count || !byArm.candidate.count) continue;
        const paired = [];
        for (let round = 0; round < rounds; round++) {
          const medians = ['baseline', 'candidate'].map(name => summarize(report.runs.filter(run => run.arm === name && run.round === round && matching(run)).map(run => run[field]).filter(value => value != null)).median);
          if (medians[0] > 0 && medians[1] != null) paired.push(Math.abs((medians[1] / medians[0] - 1) * 100));
        }
        const medianAbsolutePairedDeltaPercent = summarize(paired).median;
        const referenceRow = noiseReference?.comparisons.find(row => row.sample === sample && row.field === field);
        assert.ok(calibration || referenceRow, 'Noise reference covers requested sample and measurement');
        const noiseFloorPercent = calibration ? Math.max(3, 2 * (medianAbsolutePairedDeltaPercent ?? 0)) : referenceRow.noiseFloorPercent;
        const changePercent = byArm.baseline.median ? (byArm.candidate.median / byArm.baseline.median - 1) * 100 : null;
        report.comparisons.push({ group, sample, field, baselineMedian: byArm.baseline.median, candidateMedian: byArm.candidate.median, changePercent, medianAbsolutePairedDeltaPercent, noiseFloorPercent, beatsNoiseFloor: changePercent != null && -changePercent > noiseFloorPercent, snapshotParity: true });
      }
    }
  }
  report.passed = true;
} catch (error) {
  // Hash exception text: browser/Lua exceptions can include private build contents.
  report.errors.push({ stage, kind: error.name, messageSha256: sha256(String(error.message)) });
  if (error.name === 'AssertionError') console.error(error.message.split('\n')[0]);
  console.error(`Heatmap harness failed at ${stage} (${error.name}); error hash ${report.errors.at(-1).messageSha256}`);
  process.exitCode = 1;
} finally {
  if (memory) { const { samples, ...summary } = memory.report(); report.memory = summary; await memory.stop(); }
  await browser.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, output, comparisons: report.comparisons }));
}
