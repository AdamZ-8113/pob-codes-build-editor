// Experiment-only overlay that lets the first XML replace the pending unnamed build.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const moduleUrl = new URL(import.meta.url);

const sourcePaths = Object.freeze(['HeadlessWrapper.lua', 'Modules/Build.lua']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildBootstrapOverlay({
  sourceManifest,
  sourcePackages,
  manifest: baseManifest = sourceManifest,
  packages: basePackages = sourcePackages,
}) {
  assert.ok(sourceManifest && Array.isArray(sourceManifest.packages), 'Authoritative source manifest is required');
  assert.ok(sourcePackages instanceof Map, 'Authoritative source packages must be a Map keyed by sha256');
  assert.ok(baseManifest && Array.isArray(baseManifest.packages), 'Base manifest is required');
  assert.ok(basePackages instanceof Map, 'Base packages must be a Map keyed by sha256');

  const sourceCore = findCore(sourceManifest, 'authoritative source');
  const baseCore = findCore(baseManifest, 'base');
  const sourceArchive = checkedPackage(sourceCore, sourcePackages, 'Authoritative source');
  const baseArchive = checkedPackage(baseCore, basePackages, 'Base');
  const sourceZip = new AdmZip(sourceArchive);
  const overlayZip = new AdmZip(baseArchive);
  const manifest = structuredClone(baseManifest);
  const overlayCore = findCore(manifest, 'overlay');
  const replacements = [];

  for (const path of sourcePaths) {
    const sourceFile = findFile(sourceCore, path, 'authoritative source');
    const baseFile = findFile(baseCore, path, 'base');
    const overlayFile = findFile(overlayCore, path, 'overlay');
    const sourceEntry = checkedEntry(sourceZip, sourceFile, path, 'Authoritative source');
    const baseEntry = checkedEntry(overlayZip, baseFile, path, 'Base');
    const sourceText = sourceEntry.toString('utf8');
    const transformedText = path === 'HeadlessWrapper.lua'
      ? transformHeadlessWrapper(sourceText)
      : transformBuild(sourceText);
    const transformed = Buffer.from(transformedText);

    overlayZip.updateFile(path, transformed);
    overlayCore.uncompressedBytes += transformed.byteLength - overlayFile.bytes;
    overlayFile.bytes = transformed.byteLength;
    replacements.push({
      path,
      authoritativeSourceSha256: sha256(sourceEntry),
      baseEntrySha256: sha256(baseEntry),
      overlaySourceSha256: sha256(transformed),
      forcedSourceFallback: !baseEntry.equals(sourceEntry),
    });
  }

  const overlayArchive = overlayZip.toBuffer();
  const packages = new Map(basePackages);
  packages.delete(baseCore.sha256);
  overlayCore.sha256 = sha256(overlayArchive);
  overlayCore.bytes = overlayArchive.byteLength;
  packages.set(overlayCore.sha256, overlayArchive);

  const moduleSha256 = sha256(await readFile(moduleUrl));
  const identities = {
    experiment: 'defer-initial-unnamed-build',
    moduleSha256,
    authoritativeManifestSha256: sha256(Buffer.from(JSON.stringify(sourceManifest))),
    authoritativeCoreSha256: sourceCore.sha256,
    baseManifestSha256: sha256(Buffer.from(JSON.stringify(baseManifest))),
    baseCoreSha256: baseCore.sha256,
    overlayManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
    overlayCoreSha256: overlayCore.sha256,
    replacements,
  };
  const stats = {
    packagesChanged: 1,
    filesReplaced: replacements.length,
    transformedSourceFiles: [...sourcePaths],
    forcedSourceFallbackFiles: replacements.filter(entry => entry.forcedSourceFallback).map(entry => entry.path),
    baseCoreBytes: baseArchive.byteLength,
    overlayCoreBytes: overlayArchive.byteLength,
  };
  return { manifest, packages, identities, stats };
}

function transformHeadlessWrapper(source) {
  return checkedReplace(source,
    'runCallback("OnInit")\nrunCallback("OnFrame") -- Need at least one frame for everything to initialise',
    `runCallback("OnInit")
if __compiledCalcsDeferInitialBuild then
\t__compiledCalcsInitialBuildDeferred = true
else
\trunCallback("OnFrame") -- Need at least one frame for everything to initialise
end`,
    'HeadlessWrapper initial frame');
}

function transformBuild(source) {
  const anchor = '\tself.calcsTab = new("CalcsTab"):CalcsTab(self)';
  return checkedReplace(source, anchor, `${anchor}
\tif __compiledCalcsInstallDeferredProbe then
\t\tlocal installDeferredProbe = __compiledCalcsInstallDeferredProbe
\t\t__compiledCalcsInstallDeferredProbe = nil
\t\tinstallDeferredProbe(self)
\tend`, 'Build calculation probe seam');
}

function checkedReplace(source, before, after, label) {
  const parts = source.split(before);
  assert.equal(parts.length, 2, `${label} anchor must occur exactly once`);
  return `${parts[0]}${after}${parts[1]}`;
}

function findCore(manifest, label) {
  const matches = manifest.packages.filter(pkg => pkg.id === 'core');
  assert.equal(matches.length, 1, `${label} manifest must contain exactly one core package`);
  assert.ok(Array.isArray(matches[0].files), `${label} core file inventory is required`);
  return matches[0];
}

function checkedPackage(pkg, packages, label) {
  const archive = packages.get(pkg.sha256);
  assert.ok(Buffer.isBuffer(archive) || archive instanceof Uint8Array, `${label} core package bytes are missing`);
  const bytes = Buffer.from(archive);
  assert.equal(sha256(bytes), pkg.sha256, `${label} core package identity mismatch`);
  assert.equal(bytes.byteLength, pkg.bytes, `${label} core package byte count mismatch`);
  return bytes;
}

function findFile(pkg, path, label) {
  const matches = pkg.files.filter(file => file.path === path);
  assert.equal(matches.length, 1, `${label} core must contain exactly one ${path}`);
  assert.ok(Number.isSafeInteger(matches[0].bytes) && matches[0].bytes >= 0, `${label} ${path} byte count is invalid`);
  return matches[0];
}

function checkedEntry(zip, file, path, label) {
  const entry = zip.getEntry(path);
  assert.ok(entry && !entry.isDirectory, `${label} core is missing ${path}`);
  const bytes = entry.getData();
  assert.equal(bytes.byteLength, file.bytes, `${label} ${path} byte count mismatch`);
  return bytes;
}
