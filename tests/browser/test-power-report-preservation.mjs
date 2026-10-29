import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const retained = option('out-dir');
const directory = retained ? resolve(retained) : await mkdtemp(join(tmpdir(), 'pob-preservation-'));
await mkdir(directory, {recursive:true});
const origin = process.env.DESKTOP_POB_ORIGIN || 'http://127.0.0.1:3010/';
const cases = {
  scalar: ['Hit DPS', 'guided import parity desktop 329.txt'],
  defensive: ['Effective Hit Pool', 'guided import parity desktop 329.txt'],
  minion: ['Full DPS', 'dominating blow of inspiring guardian 328.txt'],
  kitava: ['Full DPS', 'kitava-trigger-preservation.xml'],
  foulborn: ['Full DPS', 'foulborn-trigger-preservation.xml'],
};
const selected = (option('cases') || 'scalar').split(',');
assert.ok(selected.length && selected.every(name => Object.hasOwn(cases, name)), 'Known preservation cases');
try {
 for (const name of selected) {
  const [metric, fixture] = cases[name];
  let input = `fixtures/${fixture}`;
  if (name === 'defensive') {
    // The ordinary guided fixture has no Full DPS skills. Enable its first
    // active group identically in both arms so skipping that roll-up has work
    // to omit; the EHP stage must still execute.
    const xml = inflateSync(Buffer.from((await readFile(input, 'utf8')).trim(), 'base64url')).toString();
    assert.match(xml, /includeInFullDPS="nil"/);
    input = join(directory, 'defensive-full-dps.txt');
    await writeFile(input, deflateSync(xml.replace('includeInFullDPS="nil"', 'includeInFullDPS="true"')).toString('base64url'));
  }
  for (const [layer, transform, counter] of [
    ['relevance', 'disable-only-relevance', 'relevanceSkipped'],
    ['reuse', 'disable-only-setup-reuse', 'setupReused'],
    ['stages', 'disable-only-stages', 'ehpSkipped'],
    ...(['kitava','foulborn'].includes(name) ? [['trigger-cache', 'disable-trigger-source-cache', 'triggerCacheHits']] : []),
  ]) {
    const output = join(directory, `${name}-${layer}.json`);
    const result = spawnSync(process.execPath, ['tools/profiles/profile-heatmap.mjs',
      `--origin=${origin}`, `--browser=${browserChannel() ? 'chrome' : 'chromium'}`,
      `--build-file=${input}`, `--metric=${metric}`,
      '--depth=5', '--rounds=1', '--warm=0', '--direct', '--report=shown',
      '--expect-delegation=serial', '--baseline-query=helpers=0', '--candidate-query=helpers=0',
      `--baseline-transform=tools/profiles/${transform}.mjs`,
      '--source-transform=tools/profiles/preservation-transforms.mjs',
      '--noise-floor=none', `--out=${output}`],
    { stdio: 'inherit', windowsHide: true, timeout: 240000 });
    assert.equal(result.status, 0, `${layer}: ${result.error?.message ?? 'profiling failed'}`);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.ok(report.passed && report.snapshotParity, 'Exact complete report and heatmap parity');
    const baseline = report.runs.filter(run => run.arm === 'baseline');
    const candidate = report.runs.filter(run => run.arm === 'candidate');
    assert.ok(baseline.length > 0 && candidate.length > 0, 'Both arms executed');
    // Defensive metrics require EHP, so Full DPS skipping is their stage signal.
    const signal = layer === 'stages' && name === 'defensive' ? 'fullSkipped' : counter;
    for (const run of baseline) assert.equal(run.optimizations?.[signal], 0, `${layer} opt-out took effect`);
    for (const run of candidate) assert.ok(run.optimizations?.[signal] > 0, `${layer} actually engaged`);
    for (const run of [...baseline, ...candidate]) {
      if (layer !== 'relevance') assert.ok(run.optimizations.relevanceSkipped > 0, 'Pruning remains enabled in the other ablations');
      if (layer !== 'reuse') assert.ok(run.optimizations.setupReused > 0, 'Setup reuse remains enabled in the other ablations');
    }
    console.log(JSON.stringify({case:name, layer, parity:true, runs:report.runs.map(run => ({arm:run.arm, ...run.optimizations}))}));
  }
 }
 if (process.argv.includes('--helpers')) {
  const output = join(directory, 'helpers.json');
  const result = spawnSync(process.execPath, ['tools/profiles/profile-heatmap.mjs',
    `--origin=${origin}`, `--browser=${browserChannel() ? 'chrome' : 'chromium'}`,
    '--build-file=fixtures/guided import parity desktop 329.txt', '--metric=Hit DPS',
    '--depth=5', '--rounds=1', '--warm=0', '--direct', '--report=shown',
    '--baseline-query=helpers=3&nodePowerHelpers=1', '--candidate-query=helpers=3&nodePowerHelpers=1',
    '--baseline-transform=tools/profiles/disable-only-relevance.mjs',
    '--source-transform=tools/profiles/preservation-transforms.mjs', '--helper-preservation',
    '--noise-floor=none', `--out=${output}`], {stdio:'inherit', windowsHide:true, timeout:240000});
  assert.equal(result.status, 0, 'Helper preservation profiler');
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(report.passed && report.snapshotParity, 'Complete helper report parity');
  assert.equal(report.helperPreservation.filter(row => row.arm === 'baseline').length, 0, 'Disabled helper pruning cannot emit engagement proof');
  const expected = new Set(report.helperInstrumentation.filter(row => row.arm === 'candidate').map(row => row.workerId));
  const observed = new Set(report.helperPreservation.filter(row => row.arm === 'candidate').map(row => row.workerId));
  assert.ok(expected.size > 0, 'Helper modules were instrumented');
  assert.deepEqual(observed, expected, 'Every instrumented helper actually prunes and reuses setup');
  for (const row of report.helperPreservation) assert.ok(row.counters.relevanceSkipped > 0 && row.counters.setupReused > 0);
  console.log(`Helper preservation: ${observed.size} distinct workers engaged; opt-out negative control and exact report parity passed`);
 }
} finally {
  if (!retained) await rm(directory, { recursive: true, force: true });
}
