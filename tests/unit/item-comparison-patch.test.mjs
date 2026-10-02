import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyItemComparisonPatch } from '../../scripts/patches/item-comparison-patch.mjs';
import { blobHash, sha256 } from '../../scripts/patches/gem-hover-patch.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePin = JSON.parse(await readFile(join(appDir, 'source-pin.json'), 'utf8'));
const pin = sourcePin.adapters.limitedUniqueItemComparisons;
const path = 'src/Classes/ItemsTab.lua';
const patch = await readFile(join(appDir, pin.patchFile));
const hunk = patch.toString().split(/^@@[^\n]*@@[^\n]*\n/m)[1].split('\n').slice(0, -1);
const context = hunk.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
const replacement = hunk.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
const insertion = hunk.filter(line => line[0] === '+').map(line => line.slice(1)).join('\n') + '\n';
const source = 'prefix\n' + context + 'suffix\n';
const result = 'prefix\n' + replacement + 'suffix\n';
const fixturePin = { ...pin, sourceBlobHashes: { [path]: blobHash(source) }, resultBlobHashes: { [path]: blobHash(result) } };

test('item comparison patch inserts the limited-unique shortcut and leaves the original path intact', () => {
  assert.equal(applyItemComparisonPatch(source, patch, fixturePin), result);
  assert.equal(result.replace(insertion, ''), source);
  assert.match(insertion, /item\.rarity == "UNIQUE" or item\.rarity == "RELIC"/);
  assert.match(insertion, /matchingCount == item\.limit/);
  assert.doesNotMatch(insertion, /matchingCount >=|getReplacedItemAndOutput|calcFunc/);
  assert.match(insertion, /addCompareForSlot\(compareSlot\)/);
});

test('checked item comparison patch rejects tampering and duplicate application', () => {
  assert.throws(() => applyItemComparisonPatch(source, Buffer.from('changed patch'), fixturePin), /patch hash/);
  assert.throws(() => applyItemComparisonPatch(source + '\n', patch, fixturePin), /source hash/);
  assert.throws(() => applyItemComparisonPatch(result, patch, fixturePin), /source hash/);
  assert.throws(() => applyItemComparisonPatch(source, patch, { ...fixturePin, resultBlobHashes: {} }), /result hash/);
});

test('checked item comparison patch rejects missing or ambiguous context despite repinned input', () => {
  for (const changed of [source.replace(context, 'missing context\n'), source + context]) {
    const changedPin = { ...fixturePin, sourceBlobHashes: { [path]: blobHash(changed) } };
    assert.throws(() => applyItemComparisonPatch(changed, patch, changedPin), /context mismatch/);
  }
});

test('checked item comparison patch rejects repinned malformed patch inventory and hunks', () => {
  const extraFile = Buffer.from(patch.toString() + 'diff --git a/other b/other\n');
  const extraHunk = Buffer.from(patch.toString() + '@@ -1,1 +1,1 @@\n context\n');
  const invalidLine = Buffer.from(patch.toString().replace(/\n \t/, '\n?\t'));
  for (const changed of [extraFile, extraHunk, invalidLine]) {
    assert.throws(() => applyItemComparisonPatch(source, changed, { ...fixturePin, patchSha256: sha256(changed) }), /inventory|hunks|Unsupported/);
  }
});

const prepared = join(appDir, `.runtime/source-${sourcePin.compositePatch.patchSha256.slice(0, 12)}`, path);
let preparedSource;
try {
  preparedSource = (await readFile(prepared, 'utf8')).replaceAll('\r\n', '\n');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

test('pinned ItemsTab source yields the exact result blob without modifying the checkout', { skip: !preparedSource }, async () => {
  const output = applyItemComparisonPatch(preparedSource, patch, pin);
  assert.equal(blobHash(output), pin.resultBlobHashes[path]);
  assert.equal(output.replace(insertion, ''), preparedSource);
  assert.equal((await readFile(prepared, 'utf8')).replaceAll('\r\n', '\n'), preparedSource);
});

test('pack input fingerprint and packer apply the checked item comparison adapter', async () => {
  const wrapper = await readFile(join(appDir, 'scripts/build/pack.mjs'), 'utf8');
  const packer = await readFile(join(appDir, 'upstream/packages/packer/src/pack.ts'), 'utf8');
  assert.match(wrapper, /readFile\(join\(appDir, 'scripts\/patches\/item-comparison-patch\.mjs'\)\)/);
  assert.match(wrapper, /readFile\(join\(appDir, pin\.adapters\.limitedUniqueItemComparisons\.patchFile\)\)/);
  assert.match(packer, /relPath === "Classes\/ItemsTab\.lua"\s*\? new TextEncoder\(\)\.encode\(applyItemComparisonPatch/);
});
