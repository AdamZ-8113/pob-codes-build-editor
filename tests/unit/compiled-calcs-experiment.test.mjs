import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSourceIdentity,
  calculationUnion,
  decideProfile,
  geometricMean,
  manifest,
  needsConfirmation,
  summarizeRound,
} from '../../tools/experiments/compiled-calcs/manifest.mjs';
import {
  artifactKey,
  featureInventory,
  runControlledEvolution,
} from '../../tools/experiments/compiled-calcs/architecture-maintenance-probe.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

function opportunityPair(fixture, round, conservativeEngineCeiling) {
  return {
    fixture,
    round,
    conservativeEngineCeiling,
    simpleControlEngineCeiling: conservativeEngineCeiling,
    adjustedControlEngineCeiling: conservativeEngineCeiling,
  };
}

function completeRound(round, ceilings) {
  return summarizeRound(manifest.primaryFixtureIds.map((fixture, index) =>
    opportunityPair(fixture, round, ceilings[index])), round);
}

test('profile rounds use an equal-weight geometric mean across fixtures', () => {
  const ceilings = [1, 4, 9];
  const summary = completeRound(1, ceilings);
  const expected = Math.cbrt(ceilings.reduce((product, value) => product * value, 1));

  assert.equal(manifest.stopBelowEngineCeiling, 1.5);
  assert.equal(manifest.denominatorAllowance, 0.1);
  assert.equal(manifest.primaryFixtureIds.length, 3);
  assert.ok(Math.abs(geometricMean(ceilings) - expected) < 1e-12);
  assert.ok(Math.abs(summary.conservativeEngineCeilingGeometricMean - expected) < 1e-12);
  assert.notEqual(summary.conservativeEngineCeilingGeometricMean,
    ceilings.reduce((sum, value) => sum + value, 0) / ceilings.length);
});

test('profile decision requires two sequential below-threshold rounds', () => {
  const oneLowRound = completeRound(1, [1.49, 1.49, 1.49]);
  assert.equal(needsConfirmation(oneLowRound), true);
  assert.equal(decideProfile([oneLowRound]).outcome, 'confirmation-required');

  const secondLowRound = completeRound(2, [1.2, 1.3, 1.4]);
  assert.equal(decideProfile([oneLowRound, secondLowRound]).outcome, 'negative-feasibility');
  assert.throws(() => decideProfile([oneLowRound, { ...secondLowRound, round: 3 }]),
    /Profile rounds must be sequential/);
});

test('threshold and mixed rounds cannot produce a negative feasibility result', () => {
  const exactThreshold = completeRound(1, [1.5, 1.5, 1.5]);
  const aboveThreshold = completeRound(1, [1.51, 1.6, 1.7]);
  const lowSecondRound = completeRound(2, [1.1, 1.2, 1.3]);
  const thresholdSecondRound = completeRound(2, [1.5, 1.5, 1.5]);

  assert.equal(needsConfirmation(exactThreshold), false);
  assert.equal(decideProfile([exactThreshold]).outcome, 'continue-or-inconclusive');
  assert.equal(decideProfile([aboveThreshold]).outcome, 'continue-or-inconclusive');
  assert.equal(decideProfile([aboveThreshold, lowSecondRound]).outcome, 'continue-or-inconclusive');
  assert.equal(decideProfile([completeRound(1, [1.2, 1.3, 1.4]), thresholdSecondRound]).outcome,
    'continue-or-inconclusive');
});

test('profile summaries reject incomplete, duplicate, and invalid fixture measurements', () => {
  const [first, second, third] = manifest.primaryFixtureIds;
  assert.throws(() => summarizeRound([
    opportunityPair(first, 1, 1.2),
    opportunityPair(second, 1, 1.3),
  ], 1), /Every primary fixture must appear exactly once/);
  assert.throws(() => summarizeRound([
    opportunityPair(first, 1, 1.2),
    opportunityPair(first, 1, 1.3),
    opportunityPair(second, 1, 1.4),
    opportunityPair(third, 1, 1.5),
  ], 1), /Every primary fixture must appear exactly once/);
  assert.throws(() => completeRound(1, [1.2, Number.NaN, 1.4]), /Invalid opportunity ceiling/);
  assert.throws(() => summarizeRound([
    opportunityPair(first, 1, 1.2),
    opportunityPair(second, 1, 1.3),
    { fixture: third, round: 1 },
  ], 1), /Invalid opportunity ceiling/);
});

test('calculation union rejects incomplete or missing measurements and ignores nested diagnostics', () => {
  const complete = {
    stackDepthAtReport: 0,
    regions: {
      calculation: { outerCalls: 1, inclusiveMs: 23 },
      MAIN: { outerCalls: 4, inclusiveMs: 999 },
      CALCS: { outerCalls: 8, inclusiveMs: 888 },
    },
  };
  assert.equal(calculationUnion(complete), 23);
  assert.throws(() => calculationUnion({ ...complete, stackDepthAtReport: 1 }),
    /Incomplete calculation\/profile stack/);
  assert.throws(() => calculationUnion({
    stackDepthAtReport: 0,
    regions: { calculation: { outerCalls: 0, inclusiveMs: 23 } },
  }), /Missing first-import calculation/);
  assert.throws(() => calculationUnion({
    stackDepthAtReport: 0,
    regions: { calculation: { outerCalls: 1, inclusiveMs: Number.NaN } },
  }), /Invalid calculation union/);
  assert.throws(() => calculationUnion({
    stackDepthAtReport: 0,
    regions: { calculation: { outerCalls: 1 } },
  }), /Invalid calculation union/);
});

test('source locks detect drift while treating LF and CRLF as identical', async () => {
  const path = 'upstream/packages/driver/helper-boot.lua';
  const source = await readFile(resolve(root, path), 'utf8');
  const lf = source.replaceAll('\r\n', '\n');
  const crlf = lf.replaceAll('\n', '\r\n');

  assert.doesNotThrow(() => assertSourceIdentity(path, lf));
  assert.doesNotThrow(() => assertSourceIdentity(path, crlf));
  assert.throws(() => assertSourceIdentity(path, `${lf}\n-- drift\n`), /Experiment source drift/);
  assert.throws(() => assertSourceIdentity('upstream/packages/driver/unregistered.lua', source),
    /Unregistered experiment source/);
});

test('cold profile sends one target import before post-result diagnostics', async () => {
  const browserSource = await readFile(resolve(root, 'tools/experiments/compiled-calcs/profile-browser.ts'), 'utf8');
  const probeSource = await readFile(resolve(root, 'tools/experiments/compiled-calcs/probe.lua'), 'utf8');
  const targetRequests = browserSource.match(/kind:\s*'compiled-calcs-profile'/g) ?? [];
  const targetIndex = browserSource.indexOf("kind: 'compiled-calcs-profile'");
  const resultBoundaryIndex = browserSource.indexOf('phases.headlessEngineColdFirstResultMs', targetIndex);
  const diagnosticIndex = browserSource.indexOf("kind: 'compiled-calcs-profile-report'", targetIndex);

  assert.equal(targetRequests.length, 1, 'A target warm-up or discarded target request was added');
  assert.ok(targetIndex >= 0 && resultBoundaryIndex > targetIndex && diagnosticIndex > resultBoundaryIndex,
    'Diagnostics must follow the first complete target result');
  assert.match(probeSource,
    /function getCompiledCalcsProfile\(build\)\s+if not calibration then calibrate\(\) end/,
    'Profiler calibration must remain lazy until the post-result report');
  assert.equal((probeSource.match(/\bcalibrate\(\)/g) ?? []).length, 2,
    'Calibration must have one definition and one lazy post-result invocation');
});

test('architecture diagnostic keeps a paired coarse control and phase-scoped attribution', async () => {
  const runner = await readFile(resolve(root, 'tools/experiments/compiled-calcs/expanded/run.mjs'), 'utf8');
  const targetPhase = runner.indexOf("expandedDetailedPhase = 'target-import'");
  const catalogPhase = runner.indexOf("expandedDetailedPhase = 'catalog-drain'", targetPhase);
  const gcPhase = runner.indexOf("expandedDetailedPhase = 'explicit-gc'", catalogPhase);
  const resultPhase = runner.indexOf("expandedDetailedPhase = 'post-result'", gcPhase);

  assert.match(runner, /'baseline', 'baseline-repeat', 'architecture-profile'/);
  assert.match(runner, /variant === 'architecture-profile'/);
  assert.match(runner, /speedEvidenceClass: 'diagnostic-instrumentation-only'/);
  assert.ok(targetPhase >= 0 && catalogPhase > targetPhase && gcPhase > catalogPhase && resultPhase > gcPhase,
    'Detailed spans must be attributed to the cold-path phase that owns their work');
  assert.match(runner, /expandedWrapMethod\(value, 'Init', 'main:Init'\)/);
  assert.match(runner, /'constructor:Item:' \.\. tostring\(source or 'unspecified'\)/);
  assert.match(runner, /bootProfile = \{ totalMs = expandedLuaBootMs, files = expandedDofileTimes, loadfile = expandedBootLoadfileProfile, detailed =/);
});

test('architecture maintenance probe invalidates artifacts and detects controlled source evolution', () => {
  const inputs = {
    sourceRevision: 'source-revision',
    compositePatchSha256: 'composite-patch',
    files: {
      'Modules/CalcPerform.lua': 'local function calculate(value) return value * 2 end\n',
      'Data/ModCache.lua': 'data = { mods = {} }\n',
      'Classes/PassiveTree.lua': 'PassiveTreeClass = newClass("PassiveTree", function() end)\n',
    },
  };
  const firstKey = artifactKey(inputs);
  assert.equal(firstKey, artifactKey({ ...inputs, files: { ...inputs.files } }));
  assert.deepEqual(featureInventory(inputs.files['Classes/PassiveTree.lua']), {
    functionKeyword: 1,
    loadstring: 0,
    newClass: 1,
    setmetatable: 0,
    compoundAssignment: 0,
    probeSchema: 0,
  });
  const result = runControlledEvolution(inputs);
  assert.equal(result.baselineKey, firstKey);
  assert.deepEqual(result.changes.map(change => [
    change.id,
    change.artifactInvalidated,
    change.featureDelta,
    change.unsupportedDynamicBehaviorDetected,
  ]), [
    ['formula', true, 1, null],
    ['data-schema', true, 1, null],
    ['dynamic-behavior', true, 1, true],
  ]);
});

test('normal application and driver sources do not reference the experiment', async () => {
  const roots = [
    resolve(root, 'src'),
    resolve(root, 'upstream/packages/driver/src'),
  ];
  const files = [resolve(root, 'index.html'), resolve(root, 'upstream/packages/driver/CMakeLists.txt')];
  for (const sourceRoot of roots) files.push(...await sourceFiles(sourceRoot));

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /compiled-calcs|compiledCalcs/i, `${file} imports or registers experiment code`);
  }
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (['.c', '.cc', '.cpp', '.h', '.html', '.js', '.mjs', '.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}
