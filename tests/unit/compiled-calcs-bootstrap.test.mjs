import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildBootstrapOverlay } from '../../tools/experiments/compiled-calcs/expanded/bootstrap-overlay.mjs';

const require = createRequire(new URL('../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const sha256 = value => createHash('sha256').update(value).digest('hex');

const headlessSource = `before
runCallback("OnInit")
runCallback("OnFrame") -- Need at least one frame for everything to initialise
after
`;
const buildSource = `before
\tself.calcsTab = new("CalcsTab"):CalcsTab(self)
\tself.controls.breakdown = nextStep()
after
`;

function payload({ headless = headlessSource, build = buildSource, extra = 'same' } = {}) {
  const zip = new AdmZip();
  zip.addFile('HeadlessWrapper.lua', Buffer.from(headless));
  zip.addFile('Modules/Build.lua', Buffer.from(build));
  zip.addFile('Other.lua', Buffer.from(extra));
  const archive = zip.toBuffer();
  const files = [
    { path: 'HeadlessWrapper.lua', bytes: Buffer.byteLength(headless) },
    { path: 'Modules/Build.lua', bytes: Buffer.byteLength(build) },
    { path: 'Other.lua', bytes: Buffer.byteLength(extra) },
  ];
  const manifest = { packages: [{
    id: 'core', sha256: sha256(archive), bytes: archive.byteLength,
    uncompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0), files,
  }] };
  return { manifest, packages: new Map([[manifest.packages[0].sha256, archive]]) };
}

test('defers only the initial frame and installs the probe before BuildOutput work', async () => {
  const source = payload();
  const manifestBefore = structuredClone(source.manifest);
  const packageKeysBefore = [...source.packages.keys()];
  const result = await buildBootstrapOverlay({ sourceManifest: source.manifest, sourcePackages: source.packages });
  const core = result.manifest.packages[0];
  const zip = new AdmZip(result.packages.get(core.sha256));
  const headless = zip.readAsText('HeadlessWrapper.lua');
  const build = zip.readAsText('Modules/Build.lua');

  assert.match(headless, /runCallback\("OnInit"\)\nif __compiledCalcsDeferInitialBuild then/);
  assert.match(headless, /__compiledCalcsInitialBuildDeferred = true/);
  assert.match(headless, /else\n\trunCallback\("OnFrame"\).*\nend/);
  assert.ok(build.indexOf('__compiledCalcsInstallDeferredProbe') > build.indexOf('self.calcsTab = new("CalcsTab")'));
  assert.ok(build.indexOf('__compiledCalcsInstallDeferredProbe') < build.indexOf('self.controls.breakdown = nextStep()'));
  assert.deepEqual(source.manifest, manifestBefore, 'authoritative manifest stays unchanged');
  assert.deepEqual([...source.packages.keys()], packageKeysBefore, 'authoritative package map stays unchanged');
  assert.equal(result.identities.authoritativeCoreSha256, manifestBefore.packages[0].sha256);
  assert.equal(result.identities.baseCoreSha256, manifestBefore.packages[0].sha256);
  assert.equal(result.identities.overlayCoreSha256, core.sha256);
  assert.equal(result.stats.filesReplaced, 2);
  assert.deepEqual(result.stats.forcedSourceFallbackFiles, []);
});

test('composes over non-source package entries and records two explicit source fallbacks', async () => {
  const source = payload();
  const base = payload({ headless: '\u001bLua-bytecode-headless', build: '\u001bLua-bytecode-build', extra: 'base-extra' });
  const result = await buildBootstrapOverlay({
    sourceManifest: source.manifest,
    sourcePackages: source.packages,
    manifest: base.manifest,
    packages: base.packages,
  });
  const core = result.manifest.packages[0];
  const zip = new AdmZip(result.packages.get(core.sha256));

  assert.equal(zip.readAsText('Other.lua'), 'base-extra', 'unrelated chosen-arm entry remains intact');
  assert.match(zip.readAsText('HeadlessWrapper.lua'), /__compiledCalcsInitialBuildDeferred/);
  assert.match(zip.readAsText('Modules/Build.lua'), /__compiledCalcsInstallDeferredProbe/);
  assert.deepEqual(result.stats.forcedSourceFallbackFiles, ['HeadlessWrapper.lua', 'Modules/Build.lua']);
  assert.equal(result.identities.replacements.every(entry => entry.forcedSourceFallback), true);
  assert.equal(result.identities.authoritativeCoreSha256, source.manifest.packages[0].sha256);
  assert.equal(result.identities.baseCoreSha256, base.manifest.packages[0].sha256);
  assert.notEqual(result.identities.overlayCoreSha256, result.identities.baseCoreSha256);
});

test('rejects missing or duplicate transform anchors', async () => {
  const missingHeadless = payload({ headless: 'runCallback("OnInit")\n' });
  await assert.rejects(buildBootstrapOverlay({
    sourceManifest: missingHeadless.manifest, sourcePackages: missingHeadless.packages,
  }), /HeadlessWrapper initial frame anchor must occur exactly once/);

  const duplicateBuild = payload({ build: `${buildSource}${buildSource}` });
  await assert.rejects(buildBootstrapOverlay({
    sourceManifest: duplicateBuild.manifest, sourcePackages: duplicateBuild.packages,
  }), /Build calculation probe seam anchor must occur exactly once/);
});

test('rejects corrupt package identities and base inventory drift', async () => {
  const source = payload();
  const corruptSourcePackages = new Map(source.packages);
  corruptSourcePackages.set(source.manifest.packages[0].sha256, Buffer.from('corrupt'));
  await assert.rejects(buildBootstrapOverlay({
    sourceManifest: source.manifest, sourcePackages: corruptSourcePackages,
  }), /identity mismatch/);

  const base = payload();
  base.manifest.packages[0].files.find(file => file.path === 'Modules/Build.lua').bytes++;
  await assert.rejects(buildBootstrapOverlay({
    sourceManifest: source.manifest, sourcePackages: source.packages,
    manifest: base.manifest, packages: base.packages,
  }), /Base Modules\/Build.lua byte count mismatch/);
});
