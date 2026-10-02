import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyJewelSpecPatch } from '../../scripts/patches/jewel-spec-patch.mjs';
import { applyItemComparisonPatch } from '../../scripts/patches/item-comparison-patch.mjs';
import { blobHash, sha256 } from '../../scripts/patches/gem-hover-patch.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePin = JSON.parse(await readFile(join(appDir, 'source-pin.json'), 'utf8'));
const pin = sourcePin.adapters.calculationOnlyJewelSpecs;
const patch = await readFile(join(appDir, pin.patchFile));
const paths = ['src/Classes/ItemsTab.lua', 'src/Classes/PassiveSpec.lua'];

function patchHunks(path) {
  const section = patch.toString().split('diff --git ').find(part => part.startsWith(`a/${path} b/${path}\n`));
  return section.split(/^@@[^\n]*@@[^\n]*\n/m).slice(1).map(hunk => {
    const body = hunk.split('\n');
    if (body.at(-1) === '') body.pop();
    return {
      before: body.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n',
      after: body.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n',
    };
  });
}

const fixtures = paths.map(path => {
  const hunks = patchHunks(path);
  const source = `prefix ${path}\n` + hunks.map(({ before }, index) => `${before}gap ${index}\n`).join('') + 'suffix\n';
  const result = `prefix ${path}\n` + hunks.map(({ after }, index) => `${after}gap ${index}\n`).join('') + 'suffix\n';
  const fixturePin = { ...pin, sourceBlobHashes: { ...pin.sourceBlobHashes, [path]: blobHash(source) }, resultBlobHashes: { ...pin.resultBlobHashes, [path]: blobHash(result) } };
  return { path, hunks, source, result, fixturePin };
});

test('jewel-spec patch applies all retained hunks to both exact runtime inputs', () => {
  for (const { path, source, result, fixturePin } of fixtures) {
    assert.equal(applyJewelSpecPatch(source, patch, fixturePin, path), result);
  }
});

test('jewel-spec patch rejects patch/source/result tampering, wrong order and duplicate application', () => {
  for (const { path, source, result, fixturePin } of fixtures) {
    assert.throws(() => applyJewelSpecPatch(source, Buffer.from('changed patch'), fixturePin, path), /patch hash/);
    assert.throws(() => applyJewelSpecPatch(source + '\n', patch, fixturePin, path), /source hash/);
    assert.throws(() => applyJewelSpecPatch(result, patch, fixturePin, path), /source hash/);
    assert.throws(() => applyJewelSpecPatch(source, patch, { ...fixturePin, resultBlobHashes: {} }, path), /result hash/);
    assert.throws(() => applyJewelSpecPatch(source, patch, fixturePin, 'src/Classes/Other.lua'), /unsupported/);
  }
});

test('jewel-spec patch rejects missing or ambiguous context even when input is repinned', () => {
  for (const { path, hunks, source, fixturePin } of fixtures) {
    for (const changed of [source.replace(hunks[0].before, 'missing context\n'), source + hunks[0].before]) {
      const changedPin = { ...fixturePin, sourceBlobHashes: { ...fixturePin.sourceBlobHashes, [path]: blobHash(changed) } };
      assert.throws(() => applyJewelSpecPatch(changed, patch, changedPin, path), /context mismatch/);
    }
  }
});

test('jewel-spec patch rejects repinned malformed headers, inventory, hunks and diff semantics', () => {
  const original = patch.toString();
  const changedPatches = [
    'unrecognized prefix\n' + original,
    original + 'diff --git a/other b/other\n',
    original.replace('src/Classes/PassiveSpec.lua b/src/Classes/PassiveSpec.lua', 'src/Classes/Other.lua b/src/Classes/Other.lua'),
    original.replace('100644', '100755'),
    original.replace('--- a/src/Classes/ItemsTab.lua', 'rename from src/Classes/ItemsTab.lua'),
    original.replace('@@ -4091,7 +4091,7 @@', '@@ -4091,8 +4091,7 @@'),
    original.replace(/\n \t/, '\n?\t'),
    original + '@@ -1,1 +1,1 @@\n context\n',
    original.replace(/@@ -\d+,\d+ \+\d+,\d+ @@\n[^@]*?(?=@@ )/, ''),
  ];
  const { path, source, fixturePin } = fixtures[0];
  for (const changed of changedPatches) {
    const bytes = Buffer.from(changed);
    assert.throws(() => applyJewelSpecPatch(source, bytes, { ...fixturePin, patchSha256: sha256(bytes) }, path), /inventory|Unsupported|hunk/);
  }
});

const preparedDir = join(appDir, `.runtime/source-${sourcePin.compositePatch.patchSha256.slice(0, 12)}`);
const prepared = {};
for (const path of paths) {
  try {
    prepared[path] = (await readFile(join(preparedDir, path), 'utf8')).replaceAll('\r\n', '\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

test('prepared checkout identities and chained results are exact and the checkout is untouched', { skip: !paths.every(path => prepared[path]) }, async () => {
  const itemsPath = paths[0];
  const priorPatch = await readFile(join(appDir, sourcePin.adapters.limitedUniqueItemComparisons.patchFile));
  for (const path of paths) {
    assert.equal(blobHash(prepared[path]), pin.preparedSourceBlobHashes[path]);
    const source = path === itemsPath ? applyItemComparisonPatch(prepared[path], priorPatch, sourcePin.adapters.limitedUniqueItemComparisons) : prepared[path];
    assert.equal(blobHash(source), pin.sourceBlobHashes[path]);
    assert.equal(blobHash(applyJewelSpecPatch(source, patch, pin, path)), pin.resultBlobHashes[path]);
    assert.equal((await readFile(join(preparedDir, path), 'utf8')).replaceAll('\r\n', '\n'), prepared[path]);
  }
  assert.throws(() => applyJewelSpecPatch(prepared[itemsPath], patch, pin, itemsPath), /source hash/);
});

test('temporary jewel clones retain mutable graph ownership and only omit their unused power tables', () => {
  const { result } = fixtures[0];
  assert.match(result, /key ~= "path" and key ~= "pathDist" and key ~= "distanceToClassStart" and key ~= "power"/);
  assert.match(result, /nodeCopy\.depends = \{ \}\n\t\tnodeCopy\.intuitiveLeapLikesAffecting = \{ \}\n\t\tspecCopy\.nodes\[id\] = nodeCopy/);
  assert.doesNotMatch(result, /nodeCopy\.power =/);
  assert.match(result, /spec:BuildAllDependsAndPaths\(true\)/);
  const removed = patchHunks(paths[0]).flatMap(({ before }) => before.split('\n')).filter(line => line.includes('nodeCopy.power'));
  assert.deepEqual(removed, ['\t\tnodeCopy.power = { }']);
});

test('calculation-only specs gate UI paths while preserving calculator socket distances', () => {
  const { result } = fixtures[1];
  assert.match(result, /function PassiveSpecClass:BuildAllDependsAndPaths\(calculationOnly\)/);
  assert.match(result, /if calculationOnly then\n\t\t\tnode\.pathDist = nil\n\t\t\tnode\.path = nil\n\t\telse/);
  assert.match(result, /if not calculationOnly then\n\t\t-- Use a multi-source 0-1 BFS/);
  assert.doesNotMatch(patch.toString(), /^[-+]\s*self:SetNodeDistanceToClassStart\(node\)/m);
  if (prepared[paths[1]]) {
    const full = applyJewelSpecPatch(prepared[paths[1]], patch, pin, paths[1]);
    assert.match(full, /\tend\n\n\tfor _, node in ipairs\(rootList\) do\n\t\tif node\.isJewelSocket or node\.expansionJewel then\n\t\t\tself:SetNodeDistanceToClassStart\(node\)/);
  }
  assert.match(result, /if not calculationOnly then\n\t\tself:BuildSplitPersonalityPath\(\)\n\tend/);
  assert.match(result, /node\.distanceToClassStart = 0/);
});

test('pack fingerprint, compatibility and packer own the new checked overlay without experiments', async () => {
  const wrapper = await readFile(join(appDir, 'scripts/build/pack.mjs'), 'utf8');
  const packer = await readFile(join(appDir, 'upstream/packages/packer/src/pack.ts'), 'utf8');
  const adapter = await readFile(join(appDir, 'scripts/patches/jewel-spec-patch.mjs'), 'utf8');
  assert.match(wrapper, /compatibility\.preparedSourceBlobHashes \?\? compatibility\.sourceBlobHashes/);
  assert.match(wrapper, /readFile\(join\(appDir, 'scripts\/patches\/jewel-spec-patch\.mjs'\)\)/);
  assert.match(wrapper, /readFile\(join\(appDir, pin\.adapters\.calculationOnlyJewelSpecs\.patchFile\)\)/);
  assert.match(packer, /const comparisonInput = relPath === "Classes\/ItemsTab\.lua"\s*\? new TextEncoder\(\)\.encode\(applyItemComparisonPatch/);
  assert.match(packer, /applyJewelSpecPatch\(new TextDecoder\(\)\.decode\(comparisonInput\)/);
  assert.match(packer, /relPath === "Classes\/PassiveSpec\.lua"\s*\? new TextEncoder\(\)\.encode\(applyJewelSpecPatch/);
  for (const source of [wrapper, packer, adapter]) assert.doesNotMatch(source, /from ['"][^'"]*(?:experiment|profile)[^'"]*['"]/);
});
