// Expanded cold-browser phase profiler. Experimental artifacts never enter the app bundle.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { browserChannel } from '../../../../scripts/lib/browser-channel.mjs';
import { loadInput, sha256 as hashValue } from '../../../../scripts/lib/fixture-loader.mjs';
import { manifest, assertSourceIdentity } from '../manifest.mjs';
import { buildBootstrapOverlay } from './bootstrap-overlay.mjs';
import { applyBinaryReopen, applyLoadfBuffer, applyStdioBuffer } from './loadf-buffer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const mode = process.argv.find(value => value.startsWith('--mode='))?.slice(7);
if (mode !== 'profile') throw new Error('Expanded profiler supports only --mode=profile');
const variants = (process.argv.find(value => value.startsWith('--variants='))?.slice(11) ?? 'baseline').split(',');
assert.ok(variants.length > 0 && variants.every(value => ['baseline', 'baseline-repeat', 'architecture-profile', 'comparison', 'bytecode', 'bootstrap', 'calc-only', 'bootstrap-calc-only', 'loadf-64k', 'loadf-256k', 'stdio-64k', 'stdio-256k', 'bytecode-loadf-256k', 'bytecode-fixed', 'bytecode-fixed-loadf-256k'].includes(value)), 'Invalid variant');
const profilePort = Number(process.argv.find(value => value.startsWith('--port='))?.slice(7) ?? 3010);
assert.ok(Number.isInteger(profilePort) && (profilePort === 80 || (profilePort >= 1024 && profilePort <= 65535)), 'Invalid profile port');
const origin = `http://127.0.0.1:${profilePort}`;
const fixtureCatalog = [
  { id: 'guided-329', file: 'fixtures/guided import parity desktop 329.txt' },
  { id: 'lightning-strike-328', file: 'fixtures/lightning strike daughter of oshabi 328 alternate.txt' },
  { id: 'dominating-blow-328', file: 'fixtures/dominating blow of inspiring guardian 328.txt' },
  { id: 'lightning-full-dps-synthetic', file: 'fixtures/lightning strike daughter of oshabi 328 alternate.txt', synthetic: 'first enabled skill group includeInFullDPS false -> true' },
];
const fixtureOrder = process.argv.find(value => value.startsWith('--fixtures='))?.slice(11).split(',');
const fixtures = fixtureOrder ? fixtureOrder.map(id => {
  const fixture = fixtureCatalog.find(candidate => candidate.id === id);
  assert.ok(fixture, `Unknown fixture ${id}`);
  return fixture;
}) : fixtureCatalog;
const rounds = Number(process.argv.find(value => value.startsWith('--rounds='))?.slice(9) ?? 1);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 4, 'Invalid round count');
const sampleTimeoutMs = Number(process.argv.find(value => value.startsWith('--sample-timeout-ms='))?.slice(20) ?? 120_000);
assert.ok(Number.isInteger(sampleTimeoutMs) && sampleTimeoutMs >= 5_000 && sampleTimeoutMs <= 300_000, 'Invalid sample timeout');
const alternateOrder = process.argv.includes('--alternate-order');
const buildOnly = process.argv.includes('--build-only');
const unprofiledDriver = process.argv.includes('--unprofiled-driver');
assert.ok(!unprofiledDriver || buildOnly, '--unprofiled-driver is valid only with --build-only');
const bytecodeOverlayOption = process.argv.find(value => value.startsWith('--bytecode-overlay='))?.slice(19);
const inputs = new Map(fixtures.map(fixture => {
  const loaded = loadInput(resolve(root, fixture.file));
  const xml = fixture.synthetic ? loaded.xml.replace('includeInFullDPS="false"', 'includeInFullDPS="true"') : loaded.xml;
  return [fixture.id, { ...loaded, xml, hash: hashValue(Buffer.from(xml)), ...fixture }];
}));
const normalArtifacts = ['upstream/packages/driver/dist/release/driver.mjs', 'upstream/packages/driver/dist/release/driver.wasm', '.runtime/payload/manifest.json', '.runtime/payload/root.zip', 'source-pin.json'];
const hashFile = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const startingHashes = Object.fromEntries(await Promise.all(normalArtifacts.map(async path => [path, await hashFile(resolve(root, path))])));
const sourcePin = JSON.parse(await readFile(resolve(root, 'source-pin.json'), 'utf8'));
assert.equal(sourcePin.revision, manifest.sourceRevision, 'Experiment upstream revision drift');
assertSourceIdentity('upstream/packages/driver/helper-boot.lua', await readFile(resolve(root, 'upstream/packages/driver/helper-boot.lua'), 'utf8'));

const probeSource = await readFile(new URL('./probe.lua', import.meta.url), 'utf8');
const helperSource = await readFile(resolve(root, 'upstream/packages/driver/helper-boot.lua'), 'utf8');
const coarsePatchedHelper = patchHelperBoot(helperSource, probeSource, false);
const detailedPatchedHelper = patchHelperBoot(helperSource, probeSource, true);
const buildInventory = await inventoryHash([resolve(root, 'upstream/packages/driver'), resolve(root, 'upstream/packages/packer'), resolve(root, 'upstream/vendor')]);
const loadfSource = await readFile(resolve(root, 'upstream/vendor/lua/lauxlib.c'));
const loadfOverlaySha256 = await hashFile(new URL('./loadf-buffer.mjs', import.meta.url));
const requestedBuildConfigurations = new Map();
if (unprofiledDriver) {
  assert.ok(variants.length === 1, 'Unprofiled driver build accepts exactly one variant');
  const stdioBufferBytes = variants[0] === 'stdio-64k' ? 64 * 1024 : variants[0] === 'stdio-256k' ? 256 * 1024 : 0;
  requestedBuildConfigurations.set(`16384:true:${stdioBufferBytes}:false`, { loadfBufferBytes: 16 * 1024, binaryReopen: true, stdioBufferBytes, detailedProfile: false });
} else {
  requestedBuildConfigurations.set('16384:false:0:false', { loadfBufferBytes: 16 * 1024, binaryReopen: false, stdioBufferBytes: 0, detailedProfile: false });
  for (const variant of variants) {
    const loadfBufferBytes = variant.includes('loadf-64k') ? 64 * 1024 : variant.includes('loadf-256k') ? 256 * 1024 : 16 * 1024;
    const stdioBufferBytes = variant.includes('stdio-64k') ? 64 * 1024 : variant.includes('stdio-256k') ? 256 * 1024 : 0;
    const binaryReopen = variant.includes('bytecode-fixed') || stdioBufferBytes > 0;
    const detailedProfile = variant === 'architecture-profile';
    requestedBuildConfigurations.set(`${loadfBufferBytes}:${binaryReopen}:${stdioBufferBytes}:${detailedProfile}`, { loadfBufferBytes, binaryReopen, stdioBufferBytes, detailedProfile });
  }
}
const buildConfigurations = [...requestedBuildConfigurations.values()].map(({ loadfBufferBytes, binaryReopen, stdioBufferBytes, detailedProfile }) => {
  const helperProfiled = !unprofiledDriver;
  const driverHelperSource = unprofiledDriver ? helperSource : detailedProfile ? detailedPatchedHelper : coarsePatchedHelper;
  const helperBootSha256 = hashValue(driverHelperSource);
  const transformedLoadf = Buffer.from(stdioBufferBytes > 0
    ? applyStdioBuffer(loadfSource, stdioBufferBytes)
    : loadfBufferBytes !== 16 * 1024
      ? applyLoadfBuffer(loadfSource, loadfBufferBytes, { binaryReopen })
      : binaryReopen ? applyBinaryReopen(loadfSource) : loadfSource);
  const buildIdentity = hashValue(Buffer.from(JSON.stringify({ helperBootSha256, helperProfiled, detailedProfile, buildInventory, compilerImage: manifest.compilerImage, buildType: 'Release', compactValues: true, allocator: 'mimalloc', loadfBufferBytes, binaryReopen, stdioBufferBytes: stdioBufferBytes || undefined, transformedLoadfSha256: hashValue(transformedLoadf), loadfOverlaySha256: (loadfBufferBytes !== 16 * 1024 || binaryReopen || stdioBufferBytes > 0) ? loadfOverlaySha256 : undefined })));
  const directory = resolve(root, '.runtime', 'compiled-calcs-expanded', buildIdentity.slice(0, 16));
  return { loadfBufferBytes, binaryReopen, stdioBufferBytes, detailedProfile, helperProfiled, helperBootSha256, driverHelperSource, transformedLoadf, buildIdentity, directory, driverMjs: resolve(directory, 'driver.mjs'), driverWasm: resolve(directory, 'driver.wasm') };
});
const driverBuilds = new Map(buildConfigurations.map(build => [`${build.loadfBufferBytes}:${build.binaryReopen}:${build.stdioBufferBytes}:${build.detailedProfile}`, build]));
const defaultBuild = driverBuilds.get(`${16 * 1024}:false:0:false`);
const bytecodeOverlay = variants.some(variant => variant.includes('bytecode')) ? await loadBytecodeOverlay(bytecodeOverlayOption) : undefined;
const bootstrapOverlay = variants.some(variant => variant.includes('bootstrap')) ? await loadBootstrapOverlay() : undefined;
const imageInspect = spawnSync('docker', ['image', 'inspect', manifest.compilerImage, '--format', '{{.Id}}'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (imageInspect.error || imageInspect.status !== 0) throw new Error(`Pinned compiler unavailable: ${imageInspect.error?.message ?? imageInspect.stderr}`);
for (const build of buildConfigurations) if (!(await fileExists(build.driverMjs)) || !(await fileExists(build.driverWasm))) await buildDriver(build);
for (const build of buildConfigurations) build.hashes = { driverMjs: await hashFile(build.driverMjs), driverWasm: await hashFile(build.driverWasm) };
if (buildOnly) {
  const endingHashes = Object.fromEntries(await Promise.all(normalArtifacts.map(async path => [path, await hashFile(resolve(root, path))])));
  assert.deepEqual(endingHashes, startingHashes, 'Normal artifacts changed during isolated builds');
  console.log(JSON.stringify({ driverBuilds: buildConfigurations.map(buildIdentityRecord) }, null, 2));
  process.exit(0);
}

const runId = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
const dateDirectory = new Date().toISOString().slice(0, 10);
const evidenceDirectory = resolve(root, 'tmp', 'compiled-calcs-expanded', dateDirectory, runId);
await mkdir(evidenceDirectory, { recursive: true });
const samples = [];
let server;
let serverCacheDirectory;
let warmedServerAssets = [];
try {
  if (await portListening()) throw new Error(`Expanded profiler refuses existing 127.0.0.1:${profilePort} listener`);
  serverCacheDirectory = await mkdtemp(join(tmpdir(), 'pob-compiled-calcs-expanded-vite-'));
  server = await startServer(serverCacheDirectory);
  warmedServerAssets = await warmServerTransforms();
  for (let round = 1; round <= rounds; round++) {
    const fixtureSequence = [...fixtures.slice((round - 1) % fixtures.length), ...fixtures.slice(0, (round - 1) % fixtures.length)];
    for (const fixture of fixtureSequence) {
      const stableFixtureIndex = fixtures.indexOf(fixture);
      const armSequence = alternateOrder && (stableFixtureIndex + round) % 2 === 0 ? [...variants].reverse() : variants;
      for (const variant of armSequence) {
        const sample = await runBrowserSample(fixture, variant, round);
        samples.push(sample);
        console.log(`round ${round} ${fixture.id} ${variant}: engine=${sample.metrics.engineColdFirstResultMs.toFixed(3)} ms fs=${sample.metrics.filesystemReadyMs.toFixed(3)} wasm=${sample.metrics.wasmInitMs.toFixed(3)} boot=${sample.metrics.helperBootMs.toFixed(3)} import=${sample.metrics.targetLoadMs.toFixed(3)} unique=${sample.metrics.uniqueDBDrainMs.toFixed(3)} gc=${sample.metrics.explicitGcMs.toFixed(3)}`);
      }
    }
  }
} finally {
  if (server) await server.close();
  if (serverCacheDirectory) {
    await assertOwnedScratch(serverCacheDirectory, 'pob-compiled-calcs-expanded-vite-');
    await rm(serverCacheDirectory, { recursive: true, force: true });
  }
}

const comparisons = [];
for (const fixture of fixtures) {
  for (let round = 1; round <= rounds; round++) {
    const baseline = samples.find(sample => sample.fixture === fixture.id && sample.variant === 'baseline' && sample.round === round);
    if (!baseline) continue;
    for (const candidate of samples.filter(sample => sample.fixture === fixture.id && sample.variant !== 'baseline' && sample.round === round)) {
      const baselineOutput = baseline.raw.profile.output;
      const candidateOutput = candidate.raw.profile.output;
      const outputParity = stableStringify(candidateOutput) === stableStringify(baselineOutput);
      const completeCalculationOutputParity = exactFieldsParity(baselineOutput, candidateOutput, ['mainPlayer', 'mainMinion', 'calcsPlayer', 'calcsMinion', 'material', 'fieldCounts', 'fullDPSEnrollment', 'warnings', 'warningsSource', 'activeSkill']);
      const restOfBreakdownParity = exactFieldsParity(baselineOutput, candidateOutput, ['mainPlayerBreakdown', 'mainMinionBreakdown', 'calcsMinionBreakdown', 'calcsPlayerBreakdownWithoutDisplayedRawModLists']);
      const displayedBreakdownParity = stableStringify(candidateOutput.displayedSkillBreakdown) === stableStringify(baselineOutput.displayedSkillBreakdown);
      const substantiveParity = completeCalculationOutputParity && restOfBreakdownParity && displayedBreakdownParity;
      const firstResultTransport = compareFirstResultTransport(baseline.raw.firstResultTransportProfile, candidate.raw.firstResultTransportProfile);
      const eligibility = speedEvidenceEligibility(candidate.variant, completeCalculationOutputParity, firstResultTransport);
      comparisons.push({ round, fixture: fixture.id, variant: candidate.variant, baselineMs: baseline.metrics.engineColdFirstResultMs, candidateMs: candidate.metrics.engineColdFirstResultMs,
        speedup: baseline.metrics.engineColdFirstResultMs / candidate.metrics.engineColdFirstResultMs,
        savedMs: baseline.metrics.engineColdFirstResultMs - candidate.metrics.engineColdFirstResultMs,
        outputParity, completeCalculationOutputParity, restOfBreakdownParity, displayedBreakdownParity, substantiveParity,
        firstResultTransport, ...eligibility,
        baselineOutputSha256: baseline.outputSha256, candidateOutputSha256: candidate.outputSha256 });
    }
  }
}
const endingHashes = Object.fromEntries(await Promise.all(normalArtifacts.map(async path => [path, await hashFile(resolve(root, path))])));
assert.deepEqual(endingHashes, startingHashes, 'Normal artifacts changed');
const report = {
  schemaVersion: 1, experiment: 'compiled-calcs-expanded-cold', runId, date: new Date().toISOString(), variants, rounds, alternateOrder,
  coldDefinition: 'Each sample uses a new Chrome process, disposable browser profile, worker, WASM/Lua state, and target first import. Server transforms are prefetched without executing the runtime; local server and OS caches may be warm.',
  timingBoundary: 'engineColdFirstResultMs begins when profile-browser.ts starts after its own Vite transform and ends immediately after the first helper result. It includes filesystem broker startup, worker module loading, WASM instantiation, Lua boot, target import/calculation, uniqueDB draining, explicit GC, encoding, bridge, and delivery.',
  serverNormalization: { hmr: false, watch: false, fetchedOnlyNoExecution: true, transformedAssetCount: warmedServerAssets.length, assets: warmedServerAssets },
  limitations: ['Headless path omits renderer/fonts/UI/main-worker scheduling.', 'Headless baseline uses the pass-through RPC observer for symmetric accounting and is not the unwrapped production baseline; the separate actual-app smoke provides that comparison.', 'Calc-only variants change the request contract and return with the uniqueDB catalog incomplete; they are not ordinary helper replacements.', 'Comparison variants measure the existing comparison-kind snapshot load contract; they do not execute a completed item comparison operation.', 'Architecture-profile is diagnostic instrumentation, not a speed candidate; compare it with the coarse baseline to bound observer overhead.', 'Bootstrap calculation subphases attach the probe at a different initialization point; only the total engine first-result boundary is directly comparable.', 'GetTime Lua phases are integer milliseconds.', 'Dofile spans remove direct-child time for exclusive totals but include file read, parse and execution together; architecture-profile adds nested module/chunk/method spans.', 'The first-result transport snapshot is captured after the helper call but before diagnostic output collection; complete output diagnostics are captured after the timed first result.', 'Raw internal breakdown order is preserved. Complete MAIN/CALCS values are compared separately because baseline runs can vary in tied or unordered internal breakdown rows.'],
  identities: {
    editorHead: runText('git', ['rev-parse', 'HEAD']).trim(), editorBranch: runText('git', ['branch', '--show-current']).trim(),
    sourceRevision: sourcePin.revision, compositePatchSha256: sourcePin.compositePatch.patchSha256, compositeResultTree: sourcePin.compositePatch.resultTree,
    normalArtifacts: startingHashes, buildInventory, driverBuilds: buildConfigurations.map(buildIdentityRecord), loadfOverlaySha256,
    runnerSha256: await hashFile(new URL('./run.mjs', import.meta.url)), probeSha256: await hashFile(new URL('./probe.lua', import.meta.url)),
    helperBootSha256: await hashFile(resolve(root, 'upstream/packages/driver/helper-boot.lua')),
    profileHtmlSha256: await hashFile(new URL('./profile.html', import.meta.url)), profileBrowserSha256: await hashFile(new URL('./profile-browser.ts', import.meta.url)), profileWorkerSha256: await hashFile(new URL('./profile-worker.ts', import.meta.url)),
    bytecodeOverlay: bytecodeOverlay?.identity,
    bootstrapOverlay: bootstrapOverlay && { identities: bootstrapOverlay.identities, stats: bootstrapOverlay.stats },
  },
  environment: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCores: cpus().length, profilePort,
    browser: samples[0]?.browserVersion, browserChannel: browserChannel(), compilerImage: manifest.compilerImage, compilerImageId: imageInspect.stdout.trim(),
    buildFlags: ['Release', 'POB_COMPACT_VALUES=ON', '-O3', '-flto', '-sMALLOC=mimalloc', '-sALLOW_MEMORY_GROWTH'], gcPause: 400 },
  fixtures: fixtures.map(fixture => ({ ...fixture, xmlSha256: inputs.get(fixture.id).hash })),
  candidateInterpretationValid: comparisons.length > 0 && comparisons.every(item => item.outputParity),
  calculationOutputInterpretationValid: comparisons.length > 0 && comparisons.every(item => item.completeCalculationOutputParity),
  substantiveInterpretationValid: comparisons.length > 0 && comparisons.every(item => item.substantiveParity),
  speedEvidenceEligibility: {
    sourceRuntimeCandidates: 'Eligible when complete calculated outputs match. Raw breakdown order remains separate evidence.',
    oldBytecode: 'Rejected: binary reopen deferred close work and retained read-ahead state contaminated first-result timings.',
    fixedBytecode: 'Eligible only when complete calculated outputs match and its first-result descriptor balance equals source baseline.',
    calculationOnly: 'Measured changed request contract with incomplete uniqueDB catalog; not eligible as an ordinary helper replacement.',
  }, comparisons, samples,
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(resolve(evidenceDirectory, 'raw.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(evidenceDirectory, 'summary.md'), renderSummary(report));
console.log(JSON.stringify({ evidenceDirectory: relative(root, evidenceDirectory), driverBuilds: buildConfigurations.map(buildIdentityRecord), comparisons }, null, 2));

function patchHelperBoot(source, probe, detailedProfile) {
  let result = `local installExpandedColdProbe = (function()\n${probe}\nend)()\n__compiledCalcsDeferInitialBuild = true\n${source}`;
  result = checkedReplace(result, 'local realDofile = dofile', `local expandedBootStarted = nativeTime()
local expandedDofileTimes = setmetatable({}, { __jsontype = 'array' })
local expandedDofileStack = {}
local expandedDetailedEnabled = ${detailedProfile ? 'true' : 'false'}
local expandedDetailedPhase = 'boot'
local expandedDetailedProfile = { spans = {}, loadfileCompile = {}, dynamicCompile = {} }
local expandedDetailedStack = {}
local expandedWrappedMethods = {}
local function expandedRecord(bucket, label, elapsed, exclusive)
    local key = expandedDetailedPhase .. '|' .. label
    local entry = bucket[key]
    if not entry then
        entry = { calls = 0, totalMs = 0, exclusiveMs = 0, maxMs = 0 }
        bucket[key] = entry
    end
    entry.calls = entry.calls + 1
    entry.totalMs = entry.totalMs + elapsed
    entry.exclusiveMs = entry.exclusiveMs + (exclusive or elapsed)
    entry.maxMs = math.max(entry.maxMs, elapsed)
end
local function expandedTimed(label, func, ...)
    if not expandedDetailedEnabled then return func(...) end
    local frame = { started = nativeTime(), childMs = 0 }
    expandedDetailedStack[#expandedDetailedStack + 1] = frame
    local result = table.pack(func(...))
    local elapsed = nativeTime() - frame.started
    expandedDetailedStack[#expandedDetailedStack] = nil
    local parent = expandedDetailedStack[#expandedDetailedStack]
    if parent then parent.childMs = parent.childMs + elapsed end
    expandedRecord(expandedDetailedProfile.spans, label, elapsed, elapsed - frame.childMs)
    return table.unpack(result, 1, result.n)
end
local function expandedWrapMethod(target, name, label)
    local original = target and target[name]
    if type(original) ~= 'function' or expandedWrappedMethods[original] then return end
    local wrapped = function(...) return expandedTimed(label, original, ...) end
    expandedWrappedMethods[wrapped] = true
    target[name] = wrapped
end
local function expandedInstallDetailedHooks()
    if not expandedDetailedEnabled then return end
    local realLoadstring = loadstring
    function loadstring(text, chunkName, ...)
        local label = 'loadstring:' .. tostring(chunkName or '<anonymous>') .. ':' .. tostring(type(text) == 'string' and #text or -1)
        local started = nativeTime()
        local result = table.pack(realLoadstring(text, chunkName, ...))
        local elapsed = nativeTime() - started
        expandedRecord(expandedDetailedProfile.dynamicCompile, label, elapsed)
        if type(result[1]) == 'function' then
            local chunk = result[1]
            result[1] = function(...) return expandedTimed('dynamic-chunk:' .. label, chunk, ...) end
        end
        return table.unpack(result, 1, result.n)
    end
    local realLoadModule = LoadModule
    function LoadModule(name, ...)
        local result = table.pack(expandedTimed('module:' .. tostring(name), realLoadModule, name, ...))
        local value = result[1]
        local normalized = tostring(name):gsub('%.lua$', '')
        local className = normalized:match('^Classes/(.+)$')
        if type(value) ~= 'table' and className and common and common.classes then value = common.classes[className] end
        local constructors = {
            ['Classes/PassiveTree'] = 'PassiveTree', ['Classes/PassiveSpec'] = 'PassiveSpec',
            ['Modules/Build'] = 'Build', ['Classes/CalcsTab'] = 'CalcsTab',
            ['Classes/ItemsTab'] = 'ItemsTab', ['Classes/SkillsTab'] = 'SkillsTab',
            ['Classes/ConfigTab'] = 'ConfigTab', ['Classes/TreeTab'] = 'TreeTab',
            ['Classes/ImportTab'] = 'ImportTab',
        }
        if type(value) == 'table' and constructors[normalized] then
            expandedWrapMethod(value, constructors[normalized], 'constructor:' .. constructors[normalized])
        end
        if normalized == 'Classes/Item' and type(value) == 'table' and type(value.Item) == 'function' and not expandedWrappedMethods[value.Item] then
            local originalItem = value.Item
            local wrappedItem = function(self, raw, source, fromDB, ...)
                local label = 'constructor:Item:' .. tostring(source or 'unspecified') .. ':' .. tostring(fromDB and 'database' or 'build')
                return expandedTimed(label, originalItem, self, raw, source, fromDB, ...)
            end
            expandedWrappedMethods[wrappedItem] = true
            value.Item = wrappedItem
        end
        return table.unpack(result, 1, result.n)
    end
    local realPLoadModule = PLoadModule
    function PLoadModule(name, ...)
        local result = table.pack(expandedTimed('protected-module:' .. tostring(name), realPLoadModule, name, ...))
        local value = result[2]
        if tostring(name):gsub('%.lua$', '') == 'Modules/Main' and type(value) == 'table' then
            expandedWrapMethod(value, 'Init', 'main:Init')
            expandedWrapMethod(value, 'LoadTree', 'main:LoadTree')
        end
        return table.unpack(result, 1, result.n)
    end
end
local realDofile = dofile
local realLoadfile = loadfile
local expandedLoadfileCalls, expandedLoadfileMs, expandedLoadfileMaxMs = 0, 0, 0
function loadfile(...)
    local path = tostring(select(1, ...) or '<stdin>')
    local started = nativeTime()
    local result = table.pack(realLoadfile(...))
    local elapsed = nativeTime() - started
    expandedLoadfileCalls = expandedLoadfileCalls + 1
    expandedLoadfileMs = expandedLoadfileMs + elapsed
    expandedLoadfileMaxMs = math.max(expandedLoadfileMaxMs, elapsed)
    if expandedDetailedEnabled then
        expandedRecord(expandedDetailedProfile.loadfileCompile, 'loadfile:' .. path, elapsed)
        if type(result[1]) == 'function' then
            local chunk = result[1]
            result[1] = function(...) return expandedTimed('file-chunk:' .. path, chunk, ...) end
        end
    end
    return table.unpack(result, 1, result.n)
end`);
  result = checkedReplace(result, `function dofile(path)
    local result = realDofile(path)
    if path == '_SimpleGraphic.def.lua' then
        Inflate, Deflate, GetTime = nativeInflate, nativeDeflate, nativeTime
        GetUserPath = function() return '' end
    end
    return result
end`, `function dofile(path)
    local frame = { path = path, started = nativeTime(), childMs = 0 }
    expandedDofileStack[#expandedDofileStack + 1] = frame
    local result = table.pack(realDofile(path))
    local elapsed = nativeTime() - frame.started
    expandedDofileStack[#expandedDofileStack] = nil
    local parent = expandedDofileStack[#expandedDofileStack]
    if parent then parent.childMs = parent.childMs + elapsed end
    expandedDofileTimes[#expandedDofileTimes + 1] = { path = path, inclusiveMs = elapsed, exclusiveMs = elapsed - frame.childMs }
    if path == '_SimpleGraphic.def.lua' then
        Inflate, Deflate, GetTime = nativeInflate, nativeDeflate, nativeTime
        GetUserPath = function() return '' end
        expandedInstallDetailedHooks()
    end
    return table.unpack(result, 1, result.n)
end`);
  result = checkedReplace(result, "assert(build and not __mainObject__.promptMsg, 'Helper PoB boot failed')", "assert(build and not __mainObject__.promptMsg, 'Helper PoB boot failed')\nlocal expandedLuaBootMs = nativeTime() - expandedBootStarted\nlocal expandedBootLoadfileProfile = { calls = expandedLoadfileCalls, totalMs = expandedLoadfileMs, maxMs = expandedLoadfileMaxMs }\ninstallExpandedColdProbe(build)");
  const originalLoad = `    if job.xml then
        loadBuildFromXML(job.xml, 'Calculation helper')
        assert(not __mainObject__.promptMsg, 'Helper import failed')
        local started = GetTime()
        while job.kind ~= 'nodePower' and job.kind ~= 'comparison' and __mainObject__.main.uniqueDB.loading do
            runCallback('OnFrame')
            assert(GetTime() - started < 15000, 'Helper unique database timeout')
        end
        loadedIdentity = job.identity
        loadedKind = job.kind
        operation, calc = nil, nil
        collectgarbage('collect')
        return json.encode({ready=true})
    end`;
  const expandedLoad = `    if job.xml then
        if __compiledCalcsInitialBuildDeferred then assert(type(job.xml) == 'string' and #job.xml > 0, 'Deferred initial build requires XML') end
        expandedDetailedPhase = 'target-import'
        local targetStarted = GetTime()
        loadBuildFromXML(job.xml, 'Calculation helper')
        local targetLoadMs = GetTime() - targetStarted
        assert(not __mainObject__.promptMsg, 'Helper import failed')
        local uniqueDBWasLoading = __mainObject__.main.uniqueDB.loading and true or false
        expandedDetailedPhase = 'catalog-drain'
        local uniqueStarted, uniqueDBFrames = GetTime(), 0
        local uniqueDBDrainSkipped = job.kind == 'compiled-calcs-expanded-calc-only'
        while not uniqueDBDrainSkipped and job.kind ~= 'nodePower' and job.kind ~= 'comparison' and __mainObject__.main.uniqueDB.loading do
            uniqueDBFrames = uniqueDBFrames + 1
            runCallback('OnFrame')
            assert(GetTime() - uniqueStarted < 15000, 'Helper unique database timeout')
        end
        local uniqueDBDrainMs = GetTime() - uniqueStarted
        loadedIdentity = job.identity
        loadedKind = job.kind
        operation, calc = nil, nil
        expandedDetailedPhase = 'explicit-gc'
        local gcStarted = GetTime()
        collectgarbage('collect')
        local explicitGcMs = GetTime() - gcStarted
        local deferredInitialBuildCompleted = __compiledCalcsInitialBuildDeferred and true or false
        if deferredInitialBuildCompleted then __compiledCalcsInitialBuildDeferred = nil end
        local response = { ready = true, targetLoadMs = targetLoadMs, uniqueDBWasLoading = uniqueDBWasLoading,
            uniqueDBDrainMs = uniqueDBDrainMs, uniqueDBFrames = uniqueDBFrames, uniqueDBDrainSkipped = uniqueDBDrainSkipped,
            deferredInitialBuildCompleted = deferredInitialBuildCompleted, explicitGcMs = explicitGcMs }
        local encodeStarted = GetTime()
        json.encode(response)
        response.responseEncodeProbeMs = GetTime() - encodeStarted
        expandedDetailedPhase = 'post-result'
        return json.encode(response)
    end`;
  result = checkedReplace(result, originalLoad, expandedLoad);
  result = checkedReplace(result, "    assert(loadedIdentity == job.identity, 'Stale helper build')", `    if job.kind == 'compiled-calcs-expanded-report' then
        assert(loadedIdentity == job.identity, 'Stale helper build')
        return json.encode({ profile = getExpandedColdProfile(job.includeOutput), bootProfile = { totalMs = expandedLuaBootMs, files = expandedDofileTimes, loadfile = expandedBootLoadfileProfile, detailed = expandedDetailedEnabled and expandedDetailedProfile or nil } })
    end
    assert(loadedIdentity == job.identity, 'Stale helper build')`);
  return result;
}

function checkedReplace(source, before, after) {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `Missing transform input: ${before.slice(0, 80)}`);
  assert.equal(source.indexOf(before, first + before.length), -1, `Ambiguous transform input: ${before.slice(0, 80)}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function buildDriver(build) {
  const scratch = await mkdtemp(join(tmpdir(), 'pob-compiled-calcs-expanded-build-'));
  try {
    await assertOwnedScratch(scratch, 'pob-compiled-calcs-expanded-build-');
    const overlayRoot = resolve(scratch, 'upstream');
    await mkdir(resolve(overlayRoot, 'packages'), { recursive: true });
    await cp(resolve(root, 'upstream/packages/driver'), resolve(overlayRoot, 'packages/driver'), { recursive: true, filter: path => !path.includes(`${sep}build${sep}`) && !path.includes(`${sep}dist${sep}`) });
    await cp(resolve(root, 'upstream/packages/packer'), resolve(overlayRoot, 'packages/packer'), { recursive: true });
    await cp(resolve(root, 'upstream/vendor'), resolve(overlayRoot, 'vendor'), { recursive: true });
    await writeFile(resolve(overlayRoot, 'packages/driver/helper-boot.lua'), build.driverHelperSource);
    if (build.loadfBufferBytes !== 16 * 1024 || build.binaryReopen || build.stdioBufferBytes > 0) await writeFile(resolve(overlayRoot, 'vendor/lua/lauxlib.c'), build.transformedLoadf);
    await runInherited('docker', ['run', '--rm', '--mount', `type=bind,source=${overlayRoot},target=/source`, '--workdir', '/source/packages/driver', manifest.compilerImage, 'bash', '-lc', "emcmake cmake --fresh -G 'Unix Makefiles' -B build/release -S . -DCMAKE_BUILD_TYPE=Release -DPOB_COMPACT_VALUES=ON && EMCC_FORCE_STDLIBS=libc cmake --build build/release --target driver -j 4"]);
    await mkdir(build.directory, { recursive: true });
    await cp(resolve(overlayRoot, 'packages/driver/dist/release/driver.mjs'), build.driverMjs);
    await cp(resolve(overlayRoot, 'packages/driver/dist/release/driver.wasm'), build.driverWasm);
    await writeFile(resolve(build.directory, 'identity.json'), `${JSON.stringify({ buildIdentity: build.buildIdentity, compilerImage: manifest.compilerImage, helperProfiled: build.helperProfiled, detailedProfile: build.detailedProfile, helperBootSha256: build.helperBootSha256, loadfBufferBytes: build.loadfBufferBytes, binaryReopen: build.binaryReopen, stdioBufferBytes: build.stdioBufferBytes, transformedLoadfSha256: hashValue(build.transformedLoadf), loadfOverlaySha256: (build.loadfBufferBytes === 16 * 1024 && !build.binaryReopen && !build.stdioBufferBytes) ? undefined : loadfOverlaySha256 }, null, 2)}\n`);
  } finally {
    await assertOwnedScratch(scratch, 'pob-compiled-calcs-expanded-build-');
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runBrowserSample(fixture, variant, round) {
  const profileDirectory = await mkdtemp(join(tmpdir(), 'pob-compiled-calcs-expanded-profile-'));
  let context;
  const launchStarted = performance.now();
  try {
    await assertOwnedScratch(profileDirectory, 'pob-compiled-calcs-expanded-profile-');
    context = await chromium.launchPersistentContext(profileDirectory, { headless: true, channel: browserChannel(), viewport: { width: 800, height: 600 }, args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--metrics-recording-only'] });
    const launchMs = performance.now() - launchStarted;
    const input = inputs.get(fixture.id);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) { await route.abort('blockedbyclient'); return; }
      const overlay = variant.includes('bootstrap') ? bootstrapOverlay : variant.includes('bytecode') ? bytecodeOverlay : undefined;
      if (overlay && url.pathname === '/payload/manifest.json') { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overlay.manifest) }); return; }
      const packageMatch = overlay && url.pathname.match(/^\/payload\/packages\/([a-f0-9]{64})\.zip$/);
      if (packageMatch && overlay.packages.has(packageMatch[1])) { await route.fulfill({ contentType: 'application/octet-stream', body: overlay.packages.get(packageMatch[1]) }); return; }
      if (url.pathname === `/tools/experiments/compiled-calcs/expanded/fixture/${fixture.id}`) { await route.fulfill({ contentType: 'application/xml; charset=utf-8', body: input.xml }); return; }
      await route.continue();
    });
    const page = context.pages()[0] ?? await context.newPage();
    const browserDiagnostics = [];
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') browserDiagnostics.push(`console ${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => browserDiagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed', request => browserDiagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
    page.on('response', response => {
      if (response.status() >= 400) browserDiagnostics.push(`response ${response.status()}: ${response.url()}`);
      else if (/worker|broker/i.test(response.url())) browserDiagnostics.push(`response ${response.status()}: ${response.url()}`);
    });
    const build = driverBuildForVariant(variant);
    const driverUrl = `/@fs/${build.driverMjs.replaceAll('\\', '/')}`;
    const url = `${origin}/tools/experiments/compiled-calcs/expanded/profile.html?fixture=${encodeURIComponent(fixture.id)}&driver=${encodeURIComponent(driverUrl)}&variant=${variant}`;
    const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: sampleTimeoutMs });
    assert.ok(navigation?.ok(), `Profile navigation failed: HTTP ${navigation?.status() ?? 'unknown'}`);
    try {
      await page.waitForFunction(() => window.__COMPILED_CALCS_PROFILE__?.firstResultReady || window.__COMPILED_CALCS_PROFILE__?.done, null, { timeout: sampleTimeoutMs });
    } catch (error) {
      const state = await page.evaluate(() => ({ href: location.href, readyState: document.readyState, body: document.body?.innerText, profile: window.__COMPILED_CALCS_PROFILE__ }));
      throw new Error(`${error.message}\nstate=${JSON.stringify(state)}\n${browserDiagnostics.slice(-20).join('\n')}`);
    }
    const firstEnvelope = await page.evaluate(() => window.__COMPILED_CALCS_PROFILE__);
    if (firstEnvelope.error) throw new Error(`${firstEnvelope.error}\n${browserDiagnostics.slice(-20).join('\n')}`);
    assert.ok(firstEnvelope.firstResultReady && firstEnvelope.firstResult, 'Profile page ended before first result');
    const firstResultPath = resolve(evidenceDirectory, `first-result-r${round}-${fixture.id}-${variant}.json`);
    await writeFile(firstResultPath, `${JSON.stringify({ round, fixture: fixture.id, variant, launchMs, browserVersion: context.browser()?.version() ?? 'unknown', raw: firstEnvelope.firstResult }, null, 2)}\n`);
    console.log(`round ${round} ${fixture.id} ${variant}: first result retained at ${relative(root, firstResultPath)}`);
    await page.waitForFunction(() => window.__COMPILED_CALCS_PROFILE__?.done, null, { timeout: 45_000 });
    const envelope = await page.evaluate(() => window.__COMPILED_CALCS_PROFILE__);
    if (envelope.error) throw new Error(envelope.error);
    const raw = envelope.result;
    const metrics = deriveMetrics(raw);
    const outputSha256 = hashValue(Buffer.from(stableStringify(raw.profile.output)));
    return { round, fixture: fixture.id, fixtureFile: fixture.file, fixtureXmlSha256: input.hash, variant, launchMs, browserVersion: context.browser()?.version() ?? 'unknown', outputSha256, raw, metrics };
  } finally {
    await context?.close();
    await assertOwnedScratch(profileDirectory, 'pob-compiled-calcs-expanded-profile-');
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

function deriveMetrics(raw) {
  const phases = raw.phases;
  const engine = phases.headlessEngineColdFirstResultMs - phases.bootstrapStartedAtMs;
  const calc = Number(raw.profile.regions.calculation.totalMs);
  const known = Number(raw.targetLoadMs) + Number(raw.uniqueDBDrainMs) + Number(raw.explicitGcMs);
  const fileTotals = raw.bootProfile.files.reduce((sum, file) => ({ inclusiveMs: sum.inclusiveMs + Number(file.inclusiveMs), exclusiveMs: sum.exclusiveMs + Number(file.exclusiveMs) }), { inclusiveMs: 0, exclusiveMs: 0 });
  return { engineColdFirstResultMs: engine, preBootstrapMs: phases.bootstrapStartedAtMs, filesystemReadyMs: phases.filesystemReadyMs, wasmInitMs: phases.wasmInitMs, helperBootMs: phases.helperBootMs,
    luaBootMs: raw.bootProfile.totalMs, dofileExclusiveMs: fileTotals.exclusiveMs,
    loadfileCalls: Number(raw.bootProfile.loadfile.calls), loadfileTotalMs: Number(raw.bootProfile.loadfile.totalMs), loadfileMaxMs: Number(raw.bootProfile.loadfile.maxMs),
    targetLoadMs: Number(raw.targetLoadMs), calculationMs: calc,
    importSetupResidualMs: Math.max(Number(raw.targetLoadMs) - calc, 0), uniqueDBDrainMs: Number(raw.uniqueDBDrainMs), uniqueDBFrames: Number(raw.uniqueDBFrames),
    uniqueDBDrainSkipped: Boolean(raw.uniqueDBDrainSkipped), deferredInitialBuildCompleted: Boolean(raw.deferredInitialBuildCompleted),
    explicitGcMs: Number(raw.explicitGcMs), responseEncodeProbeMs: Number(raw.responseEncodeProbeMs), resultBridgeResidualMs: Math.max(Number(raw.jobRoundTripMs) - known, 0),
    jobRoundTripMs: Number(raw.jobRoundTripMs), wasmBytes: Number(raw.wasmBytes), luaKiB: Number(raw.profile.luaKiB) };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function exactFieldsParity(left, right, fields) {
  return fields.every(field => stableStringify(left[field]) === stableStringify(right[field]));
}

function driverBuildForVariant(variant) {
  if (variant === 'architecture-profile') return assertBuild(16 * 1024, false, 0, true);
  if (variant.includes('stdio-256k')) return assertBuild(16 * 1024, true, 256 * 1024);
  if (variant.includes('stdio-64k')) return assertBuild(16 * 1024, true, 64 * 1024);
  const binaryReopen = variant.includes('bytecode-fixed');
  if (variant.includes('loadf-256k')) return assertBuild(256 * 1024, binaryReopen, 0);
  if (variant.includes('loadf-64k')) return assertBuild(64 * 1024, binaryReopen, 0);
  if (binaryReopen) return assertBuild(16 * 1024, true, 0);
  return defaultBuild;
}

function assertBuild(bytes, binaryReopen = false, stdioBufferBytes = 0, detailedProfile = false) {
  const build = driverBuilds.get(`${bytes}:${binaryReopen}:${stdioBufferBytes}:${detailedProfile}`);
  assert.ok(build, `Missing ${bytes}-byte LoadF driver build (binaryReopen=${binaryReopen}, stdioBufferBytes=${stdioBufferBytes}, detailedProfile=${detailedProfile})`);
  return build;
}

function buildIdentityRecord({ loadfBufferBytes, binaryReopen, stdioBufferBytes, detailedProfile, helperProfiled, helperBootSha256, buildIdentity, hashes }) {
  return { loadfBufferBytes, binaryReopen, stdioBufferBytes, detailedProfile, helperProfiled, helperBootSha256, buildIdentity, hashes };
}

function compareFirstResultTransport(baseline, candidate) {
  const view = profile => ({
    profilePresent: Boolean(profile),
    successfulCountersPresent: Boolean(profile?.successfulForwardedCalls),
    attemptedOpens: Number(profile?.forwardedCalls?.open ?? 0),
    successfulOpens: Number(profile?.successfulForwardedCalls?.open ?? 0),
    failedOpens: Number(profile?.failedForwardedCalls?.open ?? 0),
    successfulCloses: Number(profile?.successfulForwardedCalls?.close ?? 0),
    failedCloses: Number(profile?.failedForwardedCalls?.close ?? 0),
    successfulDescriptorBalance: Number(profile?.successfulForwardedCalls?.open ?? 0) - Number(profile?.successfulForwardedCalls?.close ?? 0),
    activeDescriptorCount: Number(profile?.activeDescriptorCount ?? 0),
    activeDescriptorPaths: profile?.activeDescriptorPaths ?? [],
    openFiles: Number(profile?.openFiles ?? 0),
    retainedBytes: Number(profile?.retainedBytes ?? 0),
  });
  const baselineView = view(baseline), candidateView = view(candidate);
  return { baseline: baselineView, candidate: candidateView,
    baselineClean: baselineView.profilePresent && baselineView.successfulCountersPresent && baselineView.successfulOpens > 0 && baselineView.failedCloses === 0 && baselineView.successfulDescriptorBalance === 0 && baselineView.activeDescriptorCount === 0 && baselineView.openFiles === 0 && baselineView.retainedBytes === 0,
    lifecycleParity: candidateView.profilePresent && candidateView.successfulCountersPresent && candidateView.successfulOpens > 0 && candidateView.failedCloses === 0 && candidateView.successfulDescriptorBalance === 0 && candidateView.activeDescriptorCount === 0 && candidateView.openFiles === 0 && candidateView.retainedBytes === 0 };
}

function speedEvidenceEligibility(variant, completeCalculationOutputParity, firstResultTransport) {
  if (!completeCalculationOutputParity) return { speedEvidenceEligible: false, speedEvidenceClass: 'rejected-calculation-output-mismatch' };
  if (variant === 'architecture-profile') return { speedEvidenceEligible: false, speedEvidenceClass: 'diagnostic-instrumentation-only' };
  if (variant.includes('calc-only')) return { speedEvidenceEligible: false, speedEvidenceClass: 'changed-contract-incomplete-unique-db' };
  if (variant.startsWith('comparison')) return { speedEvidenceEligible: false, speedEvidenceClass: 'existing-comparison-snapshot-load-contract' };
  if (variant.includes('bytecode-fixed')) return firstResultTransport.baselineClean && firstResultTransport.lifecycleParity
    ? { speedEvidenceEligible: true, speedEvidenceClass: 'fixed-bytecode-lifecycle-balanced' }
    : { speedEvidenceEligible: false, speedEvidenceClass: 'rejected-bytecode-lifecycle-imbalance' };
  if (variant.includes('bytecode')) return { speedEvidenceEligible: false, speedEvidenceClass: 'rejected-bytecode-deferred-close-contamination' };
  return firstResultTransport.baselineClean && firstResultTransport.lifecycleParity
    ? { speedEvidenceEligible: true, speedEvidenceClass: 'source-runtime-transport-candidate' }
    : { speedEvidenceEligible: false, speedEvidenceClass: 'rejected-transport-profile-or-lifecycle' };
}

function renderSummary(report) {
  const rows = report.samples.map(sample => `| ${sample.round} | ${sample.fixture} | ${sample.variant} | ${sample.metrics.engineColdFirstResultMs.toFixed(3)} | ${sample.metrics.filesystemReadyMs.toFixed(3)} | ${sample.metrics.wasmInitMs.toFixed(3)} | ${sample.metrics.helperBootMs.toFixed(3)} | ${sample.metrics.targetLoadMs.toFixed(3)} | ${sample.metrics.calculationMs.toFixed(3)} | ${sample.metrics.uniqueDBDrainMs.toFixed(3)} | ${sample.metrics.explicitGcMs.toFixed(3)} |`).join('\n');
  const comparisons = report.comparisons.map(item => `| ${item.round} | ${item.fixture} | ${item.variant} | ${item.baselineMs.toFixed(3)} | ${item.candidateMs.toFixed(3)} | ${item.speedup.toFixed(3)}x | ${item.savedMs.toFixed(3)} | ${item.outputParity} | ${item.substantiveParity} |`).join('\n');
  return `# Expanded compiled-calculation cold profile\n\n| Round | Fixture | Variant | Engine cold first result | Filesystem | WASM | Helper boot | Import | Calculation | uniqueDB drain | Explicit GC |\n| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n| Round | Fixture | Variant | Baseline ms | Candidate ms | Speedup | Saved ms | Raw output parity | Substantive parity |\n| ---: | --- | --- | ---: | ---: | ---: | ---: | --- | --- |\n${comparisons || '| n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a |'}\n`;
}

async function loadBytecodeOverlay(option) {
  const directory = option ? resolve(root, option) : resolve(root, 'tmp', 'compiled-calcs-expanded', '2026-10-11', 'bytecode-overlay');
  const overlayManifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const identity = JSON.parse(await readFile(resolve(directory, 'identity.json'), 'utf8'));
  const validation = JSON.parse(await readFile(resolve(directory, 'validation.json'), 'utf8'));
  assert.equal(validation.validated, true, 'Retained bytecode overlay validation did not pass');
  assert.equal(hashValue(Buffer.from(JSON.stringify(overlayManifest))), identity.overlayManifestSha256, 'Retained bytecode manifest identity mismatch');
  const normalManifest = JSON.parse(await readFile(resolve(root, '.runtime/payload/manifest.json'), 'utf8'));
  assert.equal(hashValue(Buffer.from(JSON.stringify(normalManifest))), identity.sourceManifestSha256, 'Retained bytecode source manifest drift');
  const packages = new Map();
  for (const entry of await readdir(resolve(directory, 'packages'), { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.zip$/.test(entry.name)) continue;
    const expectedHash = entry.name.slice(0, -4);
    const bytes = await readFile(resolve(directory, 'packages', entry.name));
    assert.equal(hashValue(bytes), expectedHash, `Retained bytecode package identity mismatch: ${entry.name}`);
    packages.set(expectedHash, bytes);
  }
  for (const selected of identity.packages) {
    const entry = overlayManifest.packages.find(candidate => candidate.id === selected.id);
    assert.ok(entry, `Retained bytecode manifest missing ${selected.id}`);
    assert.equal(entry.sha256, selected.overlaySha256, `Retained bytecode manifest package mismatch: ${selected.id}`);
    assert.ok(packages.has(selected.overlaySha256), `Retained bytecode package missing: ${selected.id}`);
  }
  assert.equal(packages.size, identity.packages.length, 'Unexpected retained bytecode package inventory');
  return { manifest: overlayManifest, identity: { ...identity, validation, evidenceDirectory: relative(root, directory) }, packages };
}

async function loadBootstrapOverlay() {
  const sourceManifest = JSON.parse(await readFile(resolve(root, '.runtime/payload/manifest.json'), 'utf8'));
  const core = sourceManifest.packages.find(pkg => pkg.id === 'core');
  assert.ok(core, 'Source payload core package missing');
  const coreBytes = await readFile(resolve(root, '.runtime/payload/packages', `${core.sha256}.zip`));
  assert.equal(hashValue(coreBytes), core.sha256, 'Source payload core package identity mismatch');
  return await buildBootstrapOverlay({ sourceManifest, sourcePackages: new Map([[core.sha256, coreBytes]]) });
}

async function warmServerTransforms() {
  const queue = ['/tools/experiments/compiled-calcs/expanded/profile.html', '/tools/experiments/compiled-calcs/expanded/profile-browser.ts', '/tools/experiments/compiled-calcs/expanded/profile-worker.ts', '/tools/experiments/compiled-calcs/expanded/rpc-profile.mjs', '/upstream/packages/driver/src/js/broker.ts', '/upstream/packages/driver/src/js/rpc.ts', ...buildConfigurations.map(build => `/@fs/${build.driverMjs.replaceAll('\\', '/')}`)];
  const seen = new Set(), assets = [];
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    assert.ok(seen.size <= 256, 'Unexpected transformed module graph size');
    const response = await fetch(`${origin}${path}`, { redirect: 'error' });
    if (response.status === 404) continue;
    assert.ok(response.ok, `Transform prefetch ${path}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    assets.push({ path, bytes: body.length, sha256: hashValue(body) });
    const text = body.toString('utf8');
    for (const match of text.matchAll(/["'`](\/(?:@id|@fs|node_modules|tools|upstream)\/[^"'`\s]+)["'`]/g)) {
      const child = match[1].replaceAll('&amp;', '&');
      if (!seen.has(child) && !child.startsWith('/payload/')) queue.push(child);
    }
  }
  return assets;
}

async function inventoryHash(roots) {
  const entries = [];
  async function visit(path, base) { for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.isSymbolicLink()) throw new Error(`Build inventory link: ${resolve(path, entry.name)}`); if (entry.isDirectory() && ['build', 'dist'].includes(entry.name)) continue; const absolute = resolve(path, entry.name); if (entry.isDirectory()) await visit(absolute, base); else if (entry.isFile()) entries.push([relative(base, absolute).replaceAll('\\', '/'), await hashFile(absolute)]); } }
  for (const path of roots) await visit(path, path);
  return { fileCount: entries.length, sha256: hashValue(Buffer.from(JSON.stringify(entries))) };
}
function runText(command, args) { const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true }); if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.stderr}`); return result.stdout; }
async function runInherited(command, args) { await new Promise((accept, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited ${code}`))); }); }
async function fileExists(path) { try { return (await lstat(path)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function assertOwnedScratch(path, prefix) { const absolute = resolve(path); assert.equal(resolve(absolute, '..'), resolve(tmpdir())); assert.ok(basename(absolute).startsWith(prefix)); assert.equal(resolve(await realpath(absolute)), absolute); assert.equal((await lstat(absolute)).isSymbolicLink(), false); async function visit(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const child = resolve(directory, entry.name); assert.ok(child.startsWith(`${absolute}${sep}`)); assert.equal((await lstat(child)).isSymbolicLink(), false); assert.equal(resolve(await realpath(child)), child); if (entry.isDirectory()) await visit(child); } } await visit(absolute); }
async function startServer(cacheDirectory) {
  const vite = resolve(root, 'upstream/node_modules/vite/dist/node/index.js');
  const { createServer } = await import(pathToFileURL(vite).href);
  const portAliasPlugin = profilePort === 3010 ? undefined : {
    name: 'compiled-calcs-profile-port-alias', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.headers.host === `127.0.0.1:${profilePort}`) request.headers.host = '127.0.0.1:3010';
        next();
      });
    },
  };
  const upstreamNodeModules = resolve(root, 'upstream/node_modules');
  const server = await createServer({ configFile: resolve(root, 'upstream/vite.local.config.ts'), cacheDir: cacheDirectory,
    resolve: { alias: {
      comlink: resolve(upstreamNodeModules, 'comlink'), react: resolve(upstreamNodeModules, 'react'),
      'react-dom': resolve(upstreamNodeModules, 'react-dom'),
    } },
    define: { __DESKTOP_DEV_LAN_HOSTS__: JSON.stringify([]) }, plugins: portAliasPlugin ? [portAliasPlugin] : [],
    server: { host: '127.0.0.1', port: profilePort, strictPort: true, hmr: false, watch: null } });
  await server.listen();
  console.log(`Expanded profile server: ${origin}/ (HMR/watch disabled)`);
  return server;
}
async function portListening() { return await new Promise((accept, reject) => { const socket = createConnection({ host: '127.0.0.1', port: profilePort }); socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); accept(true); }); socket.once('timeout', () => { socket.destroy(); reject(new Error('Cannot verify port')); }); socket.once('error', error => error.code === 'ECONNREFUSED' ? accept(false) : reject(error)); }); }
