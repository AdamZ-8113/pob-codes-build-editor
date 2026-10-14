// Setup-only bytecode overlay preparation. Never invoke inside a timed trial.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBytecodeOverlay } from './bytecode.mjs';

const require = createRequire(new URL('../../../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv.includes('--help')) {
  console.log('Usage: node tools/experiments/compiled-calcs/expanded/prepare-bytecode.mjs --output=tmp/compiled-calcs-expanded/<date>/bytecode-overlay [--packages=core,...]');
  console.log('Setup only: generate and validate this overlay before starting any timed trial.');
  process.exit(0);
}

const outputArgument = argument('output');
assert.ok(outputArgument, '--output is required');
const output = resolve(root, outputArgument);
const allowedRoot = resolve(root, 'tmp/compiled-calcs-expanded');
assert.ok(output.startsWith(`${allowedRoot}${sep}`), '--output must stay under tmp/compiled-calcs-expanded');
assert.notEqual(output, allowedRoot, '--output must name a child directory');
const existing = await readdir(output).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
assert.equal(existing.length, 0, '--output must not overwrite an existing retained overlay');

const manifest = JSON.parse(await readFile(resolve(root, '.runtime/payload/manifest.json'), 'utf8'));
const packageArgument = argument('packages');
const packageIds = packageArgument ? packageArgument.split(',').filter(Boolean) : undefined;
if (packageIds) assert.equal(new Set(packageIds).size, packageIds.length, '--packages contains duplicates');
const selectedIds = packageIds ?? manifest.packages.filter(entry => entry.startup).map(entry => entry.id);
assert.ok(selectedIds.length > 0, 'No bytecode packages selected');
const sourcePackages = new Map();
for (const id of selectedIds) {
  const entry = manifest.packages.find(pkg => pkg.id === id);
  assert.ok(entry, `Unknown payload package ${id}`);
  const bytes = await readFile(resolve(root, '.runtime/payload/packages', `${entry.sha256}.zip`));
  assert.equal(sha256(bytes), entry.sha256, `Source package identity mismatch for ${id}`);
  assert.equal(bytes.byteLength, entry.bytes, `Source package byte count mismatch for ${id}`);
  sourcePackages.set(entry.sha256, bytes);
}

const overlay = await buildBytecodeOverlay({
  repoRoot: root,
  manifest,
  packages: sourcePackages,
  packageIds: selectedIds,
});
const validation = validateOverlay({ sourceManifest: manifest, sourcePackages, overlay });
await mkdir(resolve(output, 'packages'), { recursive: true });
await Promise.all([
  writeJson(resolve(output, 'manifest.json'), overlay.manifest),
  writeJson(resolve(output, 'identity.json'), overlay.identities),
  writeJson(resolve(output, 'stats.json'), overlay.stats),
  writeJson(resolve(output, 'validation.json'), validation),
  ...overlay.identities.packages.map(async entry => {
    const bytes = overlay.packages.get(entry.overlaySha256);
    assert.ok(bytes, `Missing generated package ${entry.id}`);
    await writeFile(resolve(output, 'packages', `${entry.overlaySha256}.zip`), bytes);
  }),
]);

console.log(JSON.stringify({
  output: relative(root, output),
  phase: 'setup-only',
  includedInTrialTiming: false,
  identities: overlay.identities,
  stats: overlay.stats,
  validation,
}, null, 2));

function validateOverlay({ sourceManifest, sourcePackages, overlay }) {
  const expectedHeader = Buffer.from(overlay.identities.luaBytecodeHeaderHex, 'hex');
  assert.equal(expectedHeader.byteLength, 18, 'Unexpected Lua bytecode header length');
  let manifestFilesChecked = 0;
  let compiledHeadersChecked = 0;
  let exactSourceFallbacksChecked = 0;
  const packageGrowth = [];
  for (const identity of overlay.identities.packages) {
    const sourceEntry = sourceManifest.packages.find(entry => entry.id === identity.id);
    const overlayEntry = overlay.manifest.packages.find(entry => entry.id === identity.id);
    assert.ok(sourceEntry && overlayEntry, `Manifest package missing for ${identity.id}`);
    assert.equal(sourceEntry.sha256, identity.sourceSha256, `Source identity mismatch for ${identity.id}`);
    assert.equal(overlayEntry.sha256, identity.overlaySha256, `Overlay identity mismatch for ${identity.id}`);
    const sourceBytes = sourcePackages.get(identity.sourceSha256);
    const overlayBytes = overlay.packages.get(identity.overlaySha256);
    assert.ok(sourceBytes && overlayBytes, `Package bytes missing for ${identity.id}`);
    assert.equal(sha256(overlayBytes), overlayEntry.sha256, `Overlay archive hash mismatch for ${identity.id}`);
    assert.equal(overlayBytes.byteLength, overlayEntry.bytes, `Overlay archive size mismatch for ${identity.id}`);
    packageGrowth.push({
      id: identity.id,
      sourceBytes: sourceBytes.byteLength,
      overlayBytes: overlayBytes.byteLength,
      growthBytes: overlayBytes.byteLength - sourceBytes.byteLength,
      archiveRatio: overlayBytes.byteLength / sourceBytes.byteLength,
    });
    const sourceZip = new AdmZip(sourceBytes);
    const overlayZip = new AdmZip(overlayBytes);
    for (const file of overlayEntry.files) {
      const entry = overlayZip.getEntry(file.path);
      assert.ok(entry && !entry.isDirectory, `Overlay archive missing ${file.path}`);
      const bytes = entry.getData();
      assert.equal(bytes.byteLength, file.bytes, `Overlay file size mismatch for ${file.path}`);
      manifestFilesChecked++;
      if (!file.path.endsWith('.lua')) continue;
      if (overlay.stats.fallbacks.includes(file.path)) {
        assert.deepEqual(bytes, sourceZip.getEntry(file.path)?.getData(), `Fallback source changed for ${file.path}`);
        exactSourceFallbacksChecked++;
      } else {
        assert.deepEqual(bytes.subarray(0, expectedHeader.byteLength), expectedHeader, `Bytecode header mismatch for ${file.path}`);
        compiledHeadersChecked++;
      }
    }
  }
  assert.equal(compiledHeadersChecked, overlay.stats.compiledFiles, 'Compiled file validation count mismatch');
  assert.equal(exactSourceFallbacksChecked, overlay.stats.fallbackFiles, 'Fallback validation count mismatch');
  return {
    validated: true,
    phase: 'setup-only',
    includedInTrialTiming: false,
    selectedPackages: overlay.identities.packages.length,
    packageGrowth,
    manifestFilesChecked,
    compiledHeadersChecked,
    exactSourceFallbacksChecked,
    archiveGrowthBytes: overlay.stats.overlayArchiveBytes - overlay.stats.sourceArchiveBytes,
    archiveRatio: overlay.stats.overlayArchiveBytes / overlay.stats.sourceArchiveBytes,
    luaByteRatio: overlay.stats.overlayLuaBytes / overlay.stats.sourceBytes,
  };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
