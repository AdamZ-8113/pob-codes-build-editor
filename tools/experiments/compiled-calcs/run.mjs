// Isolated Wave 0A browser profiler. Experimental artifacts never enter the app bundle.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { browserChannel } from '../../../scripts/lib/browser-channel.mjs';
import { loadInput, sha256 as hashValue } from '../../../scripts/lib/fixture-loader.mjs';
import { readCorePackage, rewriteCorePackage, sha256 } from '../../profiles/core-package-overlay.mjs';
import { manifest, assertSourceIdentity, calculationUnion, summarizeRound, needsConfirmation, decideProfile } from './manifest.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice('--mode='.length);
if (mode !== 'profile') throw new Error('Wave 0A supports only --mode=profile');

const origin = 'http://127.0.0.1:3010';
const compilerImage = manifest.compilerImage;
const fixtures = [
  { id: 'guided-329', file: 'fixtures/guided import parity desktop 329.txt' },
  { id: 'lightning-strike-328', file: 'fixtures/lightning strike daughter of oshabi 328 alternate.txt' },
  { id: 'dominating-blow-328', file: 'fixtures/dominating blow of inspiring guardian 328.txt' },
];
const candidates = [
  {
    id: 'defence-hit-pool-simulation',
    source: 'src/Modules/CalcDefence.lua:numberOfHitsToDie',
    boundary: 'One defence hit-pool simulation, including recursive acceleration and pool reduction; nested modifier queries are attributed separately.',
    boundaryEstimate: '0.25 ms per outer invocation for typed pool/damage setup and result copy (unmeasured assumption).',
  },
  {
    id: 'mod-store-query-evaluation',
    source: 'src/Classes/ModStore.lua query front ends plus src/Classes/ModDB.lua filtering/evaluation internals',
    boundary: 'The query/filter/evaluation family as one candidate. Same-family nesting is unioned; work nested under defence is exclusive here.',
    boundaryEstimate: '1.0 ms fixed setup plus 0.003 ms per outer query for a same-WASM Lua/C boundary (unmeasured assumption).',
  },
];

const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const isoRunId = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
const evidenceDirectory = resolve(root, 'tmp', 'compiled-calcs-poc', isoRunId);

const normalArtifacts = [
  'upstream/packages/driver/dist/release/driver.mjs',
  'upstream/packages/driver/dist/release/driver.wasm',
  '.runtime/payload/manifest.json',
  '.runtime/payload/root.zip',
  'source-pin.json',
];
const startingHashes = Object.fromEntries(await Promise.all(normalArtifacts.map(async path => [path, await hashFile(resolve(root, path))])));
const sourcePin = JSON.parse(await readFile(resolve(root, 'source-pin.json'), 'utf8'));
assert.equal(sourcePin.revision, manifest.sourceRevision, 'Experiment upstream revision drift');
assert.deepEqual(fixtures.map(fixture => fixture.id), [...manifest.primaryFixtureIds]);
for (const path of Object.keys(manifest.sourceLocks).filter(path => path.startsWith('upstream/'))) {
  assertSourceIdentity(path, await readFile(resolve(root, path), 'utf8'));
}
const provenance = JSON.parse(await readFile(resolve(root, '.runtime/payload/provenance.json'), 'utf8'));
const editorHead = runText('git', ['rev-parse', 'HEAD']).trim();
const initialStatus = runText('git', ['status', '--short']);

const fixtureInputs = new Map(fixtures.map(({ id, file }) => {
  const loaded = loadInput(resolve(root, file));
  return [id, { ...loaded, file }];
}));

const probeSource = await readFile(new URL('./probe.lua', import.meta.url), 'utf8');
const runtimeProfileSource = await readFile(resolve(root, 'upstream/packages/driver/runtime-profile.lua'), 'utf8');
const helperSource = await readFile(resolve(root, 'upstream/packages/driver/helper-boot.lua'), 'utf8');
const patchedHelper = patchHelperBoot(helperSource, runtimeProfileSource, probeSource);
const authoritativeBuildInventory = await inventoryHash([
  resolve(root, 'upstream/packages/driver'),
  resolve(root, 'upstream/packages/packer'),
  resolve(root, 'upstream/vendor'),
]);
const buildIdentity = hashValue(Buffer.from(JSON.stringify({
  helper: hashValue(patchedHelper),
  cmake: await hashFile(resolve(root, 'upstream/packages/driver/CMakeLists.txt')),
  authoritativeBuildInventory,
  compilerImage,
  buildType: 'Release', compactValues: true, allocator: 'mimalloc',
})));
const retainedBuild = resolve(root, '.runtime', 'compiled-calcs-poc', buildIdentity.slice(0, 16));
const driverMjs = resolve(retainedBuild, 'driver.mjs');
const driverWasm = resolve(retainedBuild, 'driver.wasm');

const imageInspect = spawnSync('docker', ['image', 'inspect', compilerImage, '--format', '{{.Id}}'], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (imageInspect.error || imageInspect.status !== 0) {
  throw new Error(`Pinned Emscripten image unavailable: ${imageInspect.error?.message ?? imageInspect.stderr}`);
}

if (!(await fileExists(driverMjs)) || !(await fileExists(driverWasm))) {
  await buildProfileDriver({ patchedHelper, retainedBuild });
}
const buildHashes = { driverMjs: await hashFile(driverMjs), driverWasm: await hashFile(driverWasm) };

const core = await readCorePackage();
const overlay = rewriteCorePackage(core, [{ path: 'Modules/CalcDefence.lua', transform: instrumentDefence }]);
const overlayIdentity = {
  sourceCoreSha256: overlay.sourceCoreHash,
  instrumentedCoreSha256: overlay.core.sha256,
  evidence: overlay.evidence,
};

let server;
const samples = [];
const pairs = [];
let browserVersion = '';
try {
  if (await portListening()) throw new Error('Wave 0A refuses an existing listener on 127.0.0.1:3010');
  server = startServer();
  await waitForServer(server);
  for (const fixture of fixtures) {
    const control = await runBrowserSample(fixture, 1, false);
    const instrumented = await runBrowserSample(fixture, 1, true);
    browserVersion ||= control.browserVersion;
    samples.push(control, instrumented);
    const pair = derivePair(control, instrumented); pairs.push(pair);
    console.log(`Wave 0A round 1 ${fixture.id}: clean C=${pair.controlCalculationMs.toFixed(3)} ms, K<=${pair.candidateOpportunityUpperMs.toFixed(3)} ms, conservative ceiling<=${formatNumber(pair.conservativeEngineCeiling)}x, clean T=${pair.controlHeadlessEngineColdFirstResultMs.toFixed(3)} ms`);
  }
  if (needsConfirmation(summarizeRound(pairs, 1))) {
    for (const fixture of fixtures) {
      const control = await runBrowserSample(fixture, 2, false);
      const instrumented = await runBrowserSample(fixture, 2, true);
      samples.push(control, instrumented);
      const pair = derivePair(control, instrumented); pairs.push(pair);
      console.log(`Wave 0A confirmation ${fixture.id}: clean C=${pair.controlCalculationMs.toFixed(3)} ms, K<=${pair.candidateOpportunityUpperMs.toFixed(3)} ms, conservative ceiling<=${formatNumber(pair.conservativeEngineCeiling)}x, clean T=${pair.controlHeadlessEngineColdFirstResultMs.toFixed(3)} ms`);
    }
  }
} finally {
  if (server) await stopProcess(server);
}

const rounds = [1, 2].filter(round => pairs.some(pair => pair.round === round)).map(round => summarizeRound(pairs, round));
const decision = decideProfile(rounds);

const endingHashes = Object.fromEntries(await Promise.all(normalArtifacts.map(async path => [path, await hashFile(resolve(root, path))])));
assert.deepEqual(endingHashes, startingHashes, 'Normal runtime and payload artifacts changed');
const finalStatus = runText('git', ['status', '--short']);
const report = {
  schemaVersion: 1,
  manifestVersion: manifest.version,
  experiment: 'compiled-calcs-wave-0a',
  runId: isoRunId,
  date: new Date().toISOString(),
  coldDefinition: 'Each sample launches a new Chrome process with a new OS-temporary user-data directory and a new worker/Lua state. No target warm-up or discarded target calculation. The loopback server and OS file cache may be warm.',
  clocks: {
    browser: 'Monotonic performance.now(); first-result duration uses the page navigation time origin. Worker phase values are durations, never cross-origin timestamp differences.',
    lua: 'Driver GetTime uses emscripten_get_now minus state start, truncated to integer milliseconds. Short candidate spans have quantization uncertainty.',
  },
  compiledExecution: { implemented: false, parity: 'not-applicable-no-compiled-kernel', fallbackCoverage: 'not-applicable-no-compiled-kernel' },
  metricLimits: [
    'Headless-engine timing omits the shipped renderer, fonts, main worker, UI, and normal scheduling/input path; it is not shipped-app first-import latency.',
    'Default HeadlessWrapper boot calculates its empty/default build inside helperBootMs before profiling hooks attach. Hooks are reset and enabled before the first target import; the default calculation count is therefore known to be nonzero but not separately observable.',
    'Natural GC inside import and calculation spans remains charged there. helper-boot.lua explicit post-import collection is reported separately and remains inside headless-engine cold first-result time.',
    'WASM capacity and Lua KiB are diagnostics, not total process memory. Process peak/retained memory was not measured in Wave 0A.',
    'Boundary/setup costs are transparent model assumptions, not measured compiled-bridge costs.',
  ],
  identities: {
    editorHead, editorBranch: runText('git', ['branch', '--show-current']).trim(), initialStatus, finalStatus,
    sourceRevision: sourcePin.revision,
    compositePatchSha256: sourcePin.compositePatch.patchSha256,
    compositeResultTree: sourcePin.compositePatch.resultTree,
    payloadManifestSha256: provenance.manifestSha256,
    payloadRootZipSha256: provenance.rootZipSha256,
    normalArtifacts: startingHashes,
    buildIdentity,
    authoritativeBuildInventory,
    buildHashes,
    overlay: overlayIdentity,
    runnerSha256: await hashFile(new URL('./run.mjs', import.meta.url)),
    manifestSha256: await hashFile(new URL('./manifest.mjs', import.meta.url)),
    probeSha256: await hashFile(new URL('./probe.lua', import.meta.url)),
    runtimeProfileSha256: await hashFile(resolve(root, 'upstream/packages/driver/runtime-profile.lua')),
    helperBootSha256: await hashFile(resolve(root, 'upstream/packages/driver/helper-boot.lua')),
    profileHtmlSha256: await hashFile(new URL('./profile.html', import.meta.url)),
    profileBrowserSha256: await hashFile(new URL('./profile-browser.ts', import.meta.url)),
    profileWorkerSha256: await hashFile(new URL('./profile-worker.ts', import.meta.url)),
  },
  environment: {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    logicalCores: cpus().length,
    browser: browserVersion,
    browserChannel: browserChannel(),
    compilerImage,
    compilerImageId: imageInspect.stdout.trim(),
    buildFlags: ['Release', 'POB_COMPACT_VALUES=ON', '-O3', '-flto', '-sMALLOC=mimalloc', '-sALLOW_MEMORY_GROWTH'],
    gcPause: 400,
  },
  fixtures: fixtures.map(fixture => ({ ...fixture, xmlSha256: fixtureInputs.get(fixture.id).hash })),
  candidates,
  overheadTreatment: 'Every fixture/round is a fresh-process coarse-only control followed by a fresh-process candidate profile. The control never installs the high-frequency ModStore wrappers. Instrumented K retains nested wrapper work and is an opportunity numerator upper bound. The conservative gate reduces clean control C and T by 10% for plausible run noise before applying that upper numerator. Incrementally adjusted K remains diagnostic only.',
  rounds,
  decision,
  pairs,
  samples,
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(resolve(evidenceDirectory, 'raw.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(evidenceDirectory, 'decision.md'), renderDecision(report));
console.log(JSON.stringify({ evidenceDirectory: relative(root, evidenceDirectory), rounds, decision, buildHashes, overlayIdentity }, null, 2));

function patchHelperBoot(source, profile, probe) {
  let result = `local installRuntimeProfile = (function()\n${profile}\nend)()\nlocal installCompiledCalcsProbe = (function()\n${probe}\nend)()\n${source}`;
  result = checkedReplace(result,
    "assert(build and not __mainObject__.promptMsg, 'Helper PoB boot failed')",
    "assert(build and not __mainObject__.promptMsg, 'Helper PoB boot failed')\ninstallRuntimeProfile(build)\ninstallCompiledCalcsProbe(build)\ngetRuntimeProfile(true)");
  result = checkedReplace(result,
    "        loadBuildFromXML(job.xml, 'Calculation helper')\n        assert(not __mainObject__.promptMsg, 'Helper import failed')",
    "        setCompiledCalcsProfileCandidates(job.instrumentCandidates ~= false)\n        local targetStarted = GetTime()\n        loadBuildFromXML(job.xml, 'Calculation helper')\n        local targetLoadMs = GetTime() - targetStarted\n        assert(not __mainObject__.promptMsg, 'Helper import failed')");
  result = checkedReplace(result,
    "        collectgarbage('collect')\n        return json.encode({ready=true})",
    "        local gcStarted = GetTime()\n        collectgarbage('collect')\n        local postImportGcMs = GetTime() - gcStarted\n        return json.encode({ready=true, targetLoadMs=targetLoadMs, postImportGcMs=postImportGcMs})");
  result = checkedReplace(result,
    "    assert(loadedIdentity == job.identity, 'Stale helper build')",
    "    if job.kind == 'compiled-calcs-profile-report' then\n        assert(loadedIdentity == job.identity, 'Stale helper build')\n        return json.encode({runtimeProfile=json.decode(getRuntimeProfile(false)), coarseProfile=getCompiledCalcsProfile(build)})\n    end\n    assert(loadedIdentity == job.identity, 'Stale helper build')");
  return result;
}

function instrumentDefence(source) {
  assertSourceIdentity('Modules/CalcDefence.lua', source);
  let result = checkedReplace(source,
    '\tlocal function numberOfHitsToDie(DamageIn)',
    '\tlocal numberOfHitsToDie\n\tlocal function numberOfHitsToDieImpl(DamageIn)');
  result = checkedReplace(result,
    '\tend\n\t\n\tif damageCategoryConfig ~= "DamageOverTime" then\n\t\t-- number of damaging hits needed to be taken to die',
    '\tend\n\tnumberOfHitsToDie = function(...)\n\t\treturn compiledCalcsProfileCall("defence-hit-pool-simulation", numberOfHitsToDieImpl, ...)\n\tend\n\t\n\tif damageCategoryConfig ~= "DamageOverTime" then\n\t\t-- number of damaging hits needed to be taken to die');
  return result;
}

function checkedReplace(source, before, after) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `Missing checked transform input: ${before.slice(0, 80)}`);
  assert.equal(source.indexOf(before, first + before.length), -1, `Ambiguous checked transform input: ${before.slice(0, 80)}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function buildProfileDriver({ patchedHelper, retainedBuild }) {
  const scratch = await mkdtemp(join(tmpdir(), 'pob-compiled-calcs-build-'));
  try {
    await assertOwnedScratch(scratch, 'pob-compiled-calcs-build-');
    const overlayRoot = resolve(scratch, 'upstream');
    await mkdir(resolve(overlayRoot, 'packages'), { recursive: true });
    await cp(resolve(root, 'upstream/packages/driver'), resolve(overlayRoot, 'packages/driver'), { recursive: true, filter: path => !path.includes(`${sep}build${sep}`) && !path.includes(`${sep}dist${sep}`) });
    await cp(resolve(root, 'upstream/packages/packer'), resolve(overlayRoot, 'packages/packer'), { recursive: true });
    await cp(resolve(root, 'upstream/vendor'), resolve(overlayRoot, 'vendor'), { recursive: true });
    await writeFile(resolve(overlayRoot, 'packages/driver/helper-boot.lua'), patchedHelper);
    await runInherited('docker', ['run', '--rm',
      '--mount', `type=bind,source=${overlayRoot},target=/source`,
      '--workdir', '/source/packages/driver', compilerImage, 'bash', '-lc',
      "emcmake cmake --fresh -G 'Unix Makefiles' -B build/release -S . -DCMAKE_BUILD_TYPE=Release -DPOB_COMPACT_VALUES=ON && EMCC_FORCE_STDLIBS=libc cmake --build build/release --target driver -j 4",
    ]);
    await mkdir(retainedBuild, { recursive: true });
    await cp(resolve(overlayRoot, 'packages/driver/dist/release/driver.mjs'), resolve(retainedBuild, 'driver.mjs'));
    await cp(resolve(overlayRoot, 'packages/driver/dist/release/driver.wasm'), resolve(retainedBuild, 'driver.wasm'));
    await writeFile(resolve(retainedBuild, 'identity.json'), `${JSON.stringify({ buildIdentity, compilerImage }, null, 2)}\n`);
  } finally {
    await assertOwnedScratch(scratch, 'pob-compiled-calcs-build-');
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runBrowserSample(fixture, round, instrumentCandidates) {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'pob-compiled-calcs-profile-'));
  const launchStarted = performance.now();
  let context;
  try {
    await assertOwnedScratch(profileDirectory, 'pob-compiled-calcs-profile-');
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      channel: browserChannel(),
      viewport: { width: 800, height: 600 },
      args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--metrics-recording-only'],
    });
    const launchMs = performance.now() - launchStarted;
    const browserVersion = context.browser()?.version() ?? 'unknown';
    const input = fixtureInputs.get(fixture.id);
    await context.route('**/*', async route => {
      const requestUrl = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(requestUrl.hostname)) { await route.abort('blockedbyclient'); return; }
      if (requestUrl.pathname === '/payload/manifest.json') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overlay.manifest) }); return;
      }
      if (requestUrl.pathname === `/payload/packages/${overlay.core.sha256}.zip`) {
        await route.fulfill({ contentType: 'application/octet-stream', body: overlay.bytes }); return;
      }
      if (requestUrl.pathname === `/tools/experiments/compiled-calcs/fixture/${fixture.id}`) {
        await route.fulfill({ contentType: 'application/xml; charset=utf-8', body: input.xml }); return;
      }
      await route.continue();
    });
    const page = context.pages()[0] ?? await context.newPage();
    const driverUrl = `/@fs/${driverMjs.replaceAll('\\', '/')}`;
    const url = `${origin}/tools/experiments/compiled-calcs/profile.html?fixture=${encodeURIComponent(fixture.id)}&driver=${encodeURIComponent(driverUrl)}&instrument=${instrumentCandidates ? '1' : '0'}`;
    await page.goto(url, { waitUntil: 'commit', timeout: 120_000 });
    await page.waitForFunction(() => window.__COMPILED_CALCS_PROFILE__?.done, null, { timeout: 240_000 });
    const envelope = await page.evaluate(() => window.__COMPILED_CALCS_PROFILE__);
    if (envelope.error) throw new Error(envelope.error);
    const raw = envelope.result;
    const metrics = deriveMetrics(raw);
    return { fixture: fixture.id, fixtureFile: fixture.file, fixtureXmlSha256: input.hash, round,
      arm: instrumentCandidates ? 'candidate-profile' : 'coarse-control', launchMs, browserVersion, raw, metrics };
  } finally {
    await context?.close();
    await assertOwnedScratch(profileDirectory, 'pob-compiled-calcs-profile-');
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

function derivePair(control, instrumented) {
  assert.equal(control.fixture, instrumented.fixture);
  assert.equal(control.round, instrumented.round);
  assert.deepEqual(control.metrics.phaseCounts.calculationModes, instrumented.metrics.phaseCounts.calculationModes);
  assert.deepEqual(control.raw.coarseProfile.skill, instrumented.raw.coarseProfile.skill);
  assert.equal(control.metrics.candidateMetrics['mod-store-query-evaluation'].calls, 0, 'Control must not install modifier wrappers');
  const controlCalculationMs = control.metrics.rawCalculationMs;
  const conservativeControlCalculationMs = controlCalculationMs * (1 - manifest.denominatorAllowance);
  const candidateOpportunityUpperMs = Math.min(instrumented.metrics.rawCandidateUnionMs,
    conservativeControlCalculationMs * (1 - Number.EPSILON));
  const adjustedCandidateMs = Math.min(instrumented.metrics.adjustedCandidateUnionMs,
    controlCalculationMs * (1 - Number.EPSILON));
  const conservativeEngineCeiling = conservativeControlCalculationMs > candidateOpportunityUpperMs
    ? conservativeControlCalculationMs / (conservativeControlCalculationMs - candidateOpportunityUpperMs)
    : Number.POSITIVE_INFINITY;
  const T = control.metrics.headlessEngineColdFirstResultMs;
  const estimatedBoundarySetupMs = instrumented.metrics.estimatedBoundarySetupMs;
  const modeled = Object.fromEntries([2, 5].map(speed => {
    const engineMs = controlCalculationMs - adjustedCandidateMs + adjustedCandidateMs / speed + estimatedBoundarySetupMs;
    return [speed, {
      kernelSpeed: speed,
      estimatedBoundarySetupMs,
      modeledEngineMs: engineMs,
      modeledEngineGain: controlCalculationMs / engineMs,
      modeledStartupReductionFraction: Math.max(adjustedCandidateMs - adjustedCandidateMs / speed - estimatedBoundarySetupMs, 0) / T,
    }];
  }));
  return {
    fixture: control.fixture,
    round: control.round,
    controlArm: control.arm,
    instrumentedArm: instrumented.arm,
    controlCalculationMs,
    conservativeControlCalculationMs,
    candidateOpportunityUpperMs,
    adjustedCandidateMs,
    simpleControlEngineCeiling: controlCalculationMs / (controlCalculationMs - Math.min(instrumented.metrics.rawCandidateUnionMs, controlCalculationMs * (1 - Number.EPSILON))),
    conservativeEngineCeiling,
    adjustedControlEngineCeiling: controlCalculationMs / (controlCalculationMs - adjustedCandidateMs),
    controlHeadlessEngineColdFirstResultMs: T,
    conservativeCandidateStartupShare: candidateOpportunityUpperMs / (T * (1 - manifest.denominatorAllowance)),
    optimisticStartupReductionUpperFraction: candidateOpportunityUpperMs / (T * (1 - manifest.denominatorAllowance)),
    estimatedBoundarySetupMs,
    modeled,
    controlImportSetupResidualMs: Math.max(control.metrics.targetLoadMs - controlCalculationMs, 0),
    instrumentedImportSetupResidualMs: Math.max(instrumented.metrics.targetLoadMs - instrumented.metrics.rawCalculationMs, 0),
    controlSampleIndex: samples.indexOf(control),
    instrumentedSampleIndex: samples.indexOf(instrumented),
  };
}

function deriveMetrics(raw) {
  const runtime = raw.runtimeProfile;
  const coarse = raw.coarseProfile;
  const runtimeCalculationMs = [...(runtime.MAIN ?? []), ...(runtime.CALCS ?? [])].reduce((sum, value) => sum + Number(value), 0);
  const coarseCalculationMs = Number(coarse.regions.calculation.inclusiveMs);
  const rawCalculationMs = calculationUnion(coarse);
  const candidateMetrics = {};
  let rawCandidateUnionMs = 0;
  let adjustedCandidateUnionMs = 0;
  let estimatedBoundaryMs = 0;
  const perCall = Number(coarse.calibration.estimatedPerCallMs);
  for (const candidate of candidates) {
    const region = coarse.regions[candidate.id];
    const rawExclusiveMs = Number(region.exclusiveMs);
    const overheadMs = Number(region.calls) * perCall;
    const adjustedExclusiveMs = Math.max(rawExclusiveMs - overheadMs, 0);
    const boundaryMs = candidate.id === 'defence-hit-pool-simulation'
      ? Number(region.outerCalls) * 0.25
      : 1 + Number(region.outerCalls) * 0.003;
    candidateMetrics[candidate.id] = { ...region, rawExclusiveMs, overheadMs, adjustedExclusiveMs, modeledBoundarySetupMs: boundaryMs };
    rawCandidateUnionMs += rawExclusiveMs;
    adjustedCandidateUnionMs += adjustedExclusiveMs;
    estimatedBoundaryMs += boundaryMs;
  }
  const calculationWrapperCalls = Number(coarse.regions.calculation.calls);
  const allWrapperCalls = Object.values(candidateMetrics).reduce((sum, region) => sum + Number(region.calls), calculationWrapperCalls);
  const fullWrappedNoopPerCallMs = Number(coarse.calibration.wrappedMs) / Number(coarse.calibration.iterations);
  const wrapperOverheadUpperPerCallMs = Math.max(perCall * 2, fullWrappedNoopPerCallMs);
  const estimatedAllWrapperOverheadMs = allWrapperCalls * perCall;
  const wrapperOverheadUpperAllowanceMs = allWrapperCalls * wrapperOverheadUpperPerCallMs;
  const adjustedCalculationMs = Math.max(rawCalculationMs - estimatedAllWrapperOverheadMs, adjustedCandidateUnionMs);
  const boundedRawK = Math.min(rawCandidateUnionMs, rawCalculationMs * (1 - Number.EPSILON));
  const boundedAdjustedK = Math.min(adjustedCandidateUnionMs, adjustedCalculationMs * (1 - Number.EPSILON));
  const conservativeCalculationMs = rawCalculationMs - wrapperOverheadUpperAllowanceMs;
  const conservativeEngineCeiling = conservativeCalculationMs > boundedRawK
    ? conservativeCalculationMs / (conservativeCalculationMs - boundedRawK) : Number.POSITIVE_INFINITY;
  const T = Number(raw.phases.headlessEngineColdFirstResultMs);
  const models = Object.fromEntries([2, 5].map(speed => {
    const modeledEngineMs = adjustedCalculationMs - boundedAdjustedK + boundedAdjustedK / speed + estimatedBoundaryMs;
    return [speed, {
      kernelSpeed: speed,
      modeledEngineMs,
      modeledEngineGain: adjustedCalculationMs / modeledEngineMs,
      modeledStartupReductionFraction: Math.max(boundedAdjustedK - boundedAdjustedK / speed - estimatedBoundaryMs, 0) / T,
    }];
  }));
  return {
    headlessEngineColdFirstResultMs: T,
    targetLoadMs: Number(raw.targetLoadMs),
    postImportGcMs: Number(raw.postImportGcMs),
    resultDeliveryAndExplicitGcMs: Math.max(Number(raw.jobRoundTripMs) - Number(raw.targetLoadMs), 0),
    runtimeCalculationMs,
    coarseCalculationMs,
    rawCalculationMs,
    adjustedCalculationMs,
    rawCandidateUnionMs: boundedRawK,
    adjustedCandidateUnionMs: boundedAdjustedK,
    simpleRawEngineCeiling: rawCalculationMs / (rawCalculationMs - boundedRawK),
    conservativeCalculationMs,
    conservativeEngineCeiling,
    adjustedEngineCeiling: adjustedCalculationMs / (adjustedCalculationMs - boundedAdjustedK),
    rawCandidateStartupShare: boundedRawK / T,
    adjustedCandidateStartupShare: boundedAdjustedK / T,
    estimatedBoundarySetupMs: estimatedBoundaryMs,
    profilerOverhead: {
      calibration: coarse.calibration,
      calculationWrapperCalls,
      allWrapperCalls,
      estimatedAllWrapperOverheadMs,
      wrapperOverheadUpperPerCallMs,
      wrapperOverheadUpperAllowanceMs,
    },
    modeled: models,
    candidateMetrics,
    phaseCounts: {
      runtimeMAIN: runtime.MAIN?.length ?? 0,
      runtimeCALCS: runtime.CALCS?.length ?? 0,
      calculationOuter: coarse.regions.calculation.outerCalls,
      calculationTotal: coarse.regions.calculation.calls,
      calculationModes: coarse.calculationModes,
    },
    nestedTreatment: { stackDepthAtReport: coarse.stackDepthAtReport, calculationMaxDepth: coarse.regions.calculation.maxDepth, candidateExclusiveUnion: true },
    wasmBytes: raw.wasmBytes,
    luaKiB: runtime.luaKiB,
  };
}

function renderDecision(report) {
  const rows = report.pairs.map(pair => `| ${pair.round} | ${pair.fixture} | ${pair.controlHeadlessEngineColdFirstResultMs.toFixed(3)} | ${pair.controlCalculationMs.toFixed(3)} | ${pair.candidateOpportunityUpperMs.toFixed(3)} | ${formatNumber(pair.conservativeEngineCeiling)}x | ${(100 * pair.conservativeCandidateStartupShare).toFixed(2)}% |`).join('\n');
  const roundRows = report.rounds.map(round => `| ${round.round} | ${formatNumber(round.conservativeEngineCeilingGeometricMean)}x | ${formatNumber(round.simpleControlEngineCeilingGeometricMean)}x | ${formatNumber(round.adjustedControlEngineCeilingGeometricMean)}x |`).join('\n');
  return `# Compiled calculations Wave 0A decision\n\nOutcome: **${report.decision.outcome}**. ${report.decision.reason}\n\n| Round | Fixture | Control T cold first result (ms) | Control C calculation (ms) | K opportunity upper bound (ms) | Conservative engine ceiling | Conservative K/T |\n| ---: | --- | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n| Round | Conservative paired geometric mean | Simple paired geometric mean | Incrementally adjusted geometric mean |\n| ---: | ---: | ---: | ---: |\n${roundRows}\n\nEach fixture/round is a fresh-process coarse-only control followed by a fresh-process candidate profile. The control never installs high-frequency modifier wrappers. Instrumented K retains nested wrapper work and therefore bounds the opportunity numerator upward. The conservative gate reduces clean control C and T by 10% for plausible run noise before applying that upper numerator. The separately adjusted values subtract measured incremental wrapper cost and are diagnostic. Candidate nesting is removed by attributing direct child time away from each parent; K never double-counts the defence region's modifier queries.\n\nThe harness starts one new Chrome process, browser profile, worker, and Lua state per sample. The default empty build calculation occurs during helper boot and is included in helperBootMs; hooks are reset and enabled before the target's first import. Natural GC remains in its enclosing span, while the helper's explicit post-import collection is separately reported. Calibration runs only in the post-result diagnostics request. Import/setup residual is retained per arm as targetLoadMs minus C.\n\nThis is instrumented headless-engine evidence. It omits renderer, fonts, the main worker, UI initialization/drawing, and normal scheduling/input. The first fixture may include first-time Vite transforms; later fresh browsers reuse warmed dev-server/module caches and OS file cache. T is an observed phase denominator, not shipped-editor latency or a cross-arm startup speedup. Boundary/setup model values are assumptions; see raw.json for call counts, 2x/5x models, source/binary identities, hashes, phase counts, and limitations.\n`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'infinite';
}

async function inventoryHash(roots) {
  const entries = [];
  async function visit(path, base) {
    const names = await readdir(path, { withFileTypes: true });
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      if (entry.isSymbolicLink()) throw new Error(`Build inventory link is unsupported: ${resolve(path, entry.name)}`);
      if (entry.isDirectory() && ['build', 'dist'].includes(entry.name)) continue;
      const absolute = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(absolute, base);
      else if (entry.isFile()) entries.push([relative(base, absolute).replaceAll('\\', '/'), await hashFile(absolute)]);
    }
  }
  for (const path of roots) await visit(path, path);
  return { fileCount: entries.length, sha256: hashValue(Buffer.from(JSON.stringify(entries))) };
}

function runText(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

async function runInherited(command, args) {
  await new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function fileExists(path) {
  try { return (await lstat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function assertOwnedScratch(path, prefix) {
  const absolute = resolve(path);
  const parent = resolve(absolute, '..');
  assert.equal(parent, resolve(tmpdir()), 'Scratch must be an immediate OS temp child');
  assert.ok(basename(absolute).startsWith(prefix), 'Scratch prefix mismatch');
  const actual = await realpath(absolute);
  assert.equal(resolve(actual), absolute, 'Scratch path must not traverse a reparse point');
  assert.equal((await lstat(absolute)).isSymbolicLink(), false, 'Scratch root must not be a link');
  async function checkChildren(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      assert.ok(child.startsWith(`${absolute}${sep}`), 'Scratch descendant escaped its owner');
      assert.equal((await lstat(child)).isSymbolicLink(), false, 'Scratch cleanup refuses nested links');
      assert.equal(resolve(await realpath(child)), child, 'Scratch cleanup refuses nested reparse traversal');
      if (entry.isDirectory()) await checkChildren(child);
    }
  }
  await checkChildren(absolute);
}

function startServer() {
  const child = spawn(process.execPath, ['scripts/dev/dev.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-8192); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-8192); process.stderr.write(chunk); });
  const completed = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('exit', (code, signal) => resolve({ code, signal })); });
  return { child, completed, output: () => output };
}

async function waitForServer(server) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error(`Development server exited: ${server.output()}`);
    if (server.output().includes(`Desktop PoB: ${origin}/`)) {
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        await response.body?.cancel();
        if (response.ok) return;
      } catch { /* keep waiting */ }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Development server readiness timeout: ${server.output()}`);
}

async function stopProcess(processState) {
  if (!processState.child.pid) return;
  if (process.platform === 'win32' && processState.child.exitCode === null && processState.child.signalCode === null) {
    spawnSync('taskkill', ['/PID', String(processState.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else if (processState.child.exitCode === null && processState.child.signalCode === null) {
    processState.child.kill('SIGTERM');
  }
  await Promise.race([processState.completed, new Promise(resolve => setTimeout(resolve, 5000))]);
}

async function portListening() {
  return await new Promise((resolvePort, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: 3010 });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); resolvePort(true); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot verify port 3010')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolvePort(false) : reject(error));
  });
}
