import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSourceTransforms, rewriteCorePackage, sha256 } from '../../tools/profiles/core-package-overlay.mjs';

const require = createRequire(new URL('../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
function fixture() {
  const zip = new AdmZip();
  zip.addFile('Classes/Example.lua', Buffer.from('original'));
  const archive = zip.toBuffer();
  return { archive, manifest: { packages: [{ id: 'core', sha256: sha256(archive), bytes: archive.length, uncompressedBytes: 8, files: [{ path: 'Classes/Example.lua', bytes: 8 }] }] } };
}

test('ordered overlays stack against the previous result and record every hash', () => {
  const input = fixture(), before = structuredClone(input.manifest);
  const result = rewriteCorePackage(input, [
    { path: 'Classes/Example.lua', transform: text => text.replace('original', 'first') },
    { path: 'Classes/Example.lua', transform: text => { assert.equal(text, 'first'); return text + '-second'; } },
  ]);
  assert.deepEqual(input.manifest, before, 'Caller manifest remains unchanged for the other arm');
  assert.equal(new AdmZip(result.bytes).readAsText('Classes/Example.lua'), 'first-second');
  assert.deepEqual(result.evidence, [
    { path: 'Classes/Example.lua', before: sha256('original'), after: sha256('first') },
    { path: 'Classes/Example.lua', before: sha256('first'), after: sha256('first-second') },
  ]);
  assert.equal(result.sourceCoreHash, sha256(input.archive));
  assert.equal(result.core.sha256, sha256(result.bytes));
  assert.equal(result.core.bytes, result.bytes.length);
  assert.equal(result.core.files[0].bytes, 12);
  assert.equal(result.core.uncompressedBytes, 12);
});

test('reject unknown paths, missing ZIP entries, corrupt core and non-text transforms', () => {
  assert.throws(() => rewriteCorePackage(fixture(), [{ path: 'unknown.lua', transform: () => '' }]), /belong to core/);
  const missing = fixture();
  missing.manifest.packages[0].files.push({ path: 'missing.lua', bytes: 0 });
  assert.throws(() => rewriteCorePackage(missing, [{ path: 'missing.lua', transform: () => '' }]), /belong to core/);
  const corrupt = fixture(); corrupt.manifest.packages[0].sha256 = 'bad';
  assert.throws(() => rewriteCorePackage(corrupt, []), /Core package identity/);
  assert.throws(() => rewriteCorePackage(fixture(), [{ path: 'Classes/Example.lua', transform: () => undefined }]), /source text/);
});

test('repeatable modules preserve legacy primary/additional ordering and new ordered lists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-overlay-unit-'));
  try {
    const legacy = join(directory, 'legacy.mjs'), modern = join(directory, 'modern.mjs');
    await writeFile(legacy, `export const transform = text => text + '-primary';
export const additionalTransforms = [{path:'Classes/Example.lua', transform:text => text + '-extra'}];
export const transformationEvidence = {kind:'public-test'};`);
    await writeFile(modern, `export const transforms = [{path:'Classes/Example.lua', transform:text => text + '-last'}];`);
    const loaded = await loadSourceTransforms([legacy, modern], 'Classes/Example.lua');
    const result = rewriteCorePackage(fixture(), loaded.transforms);
    assert.equal(new AdmZip(result.bytes).readAsText('Classes/Example.lua'), 'original-primary-extra-last');
    assert.deepEqual(loaded.modules[0].transformationEvidence, { kind: 'public-test' });
    assert.match(loaded.modules[1].sha256, /^[a-f0-9]{64}$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
