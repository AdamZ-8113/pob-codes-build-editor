import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSourceLedger } from '../../scripts/build/source-ledger.mjs';
import { EMSDK_IMAGE } from '../../scripts/build/mod-cache/supplement.mjs';
import { appendModCacheSupplement, modCacheKeys, modCachePath } from '../../scripts/patches/mod-cache-supplement-patch.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const shipped = 'local c = {}\n(function()\nc["a"]={nil,"a "}\nc["b\\nc"]={{[1]={name="B",type="BASE",value=1}},nil}\nend)();\nreturn c\n';
const supplement = 'local c = {}\n(function()\nc["a b"]={nil,"a b "}\nc["a b c"]={nil,"a b c "}\nend)();\nreturn c\n';
const merged = 'local c = {}\n(function()\nc["a"]={nil,"a "}\nc["b\\nc"]={{[1]={name="B",type="BASE",value=1}},nil}\nend)();\n' +
  '(function()\nc["a b"]={nil,"a b "}\nc["a b c"]={nil,"a b c "}\nend)();\nreturn c\n';
const ledger = (overrides = {}) => ({ version: 1, treeVersion: '3_29', entries: 2, excluded: [],
  sourceBlobHashes: { [modCachePath]: blob(shipped) }, resultBlobHashes: { [modCachePath]: blob(merged) }, ...overrides });

test('ModCache supplement keeps shipped bytes and appends only new SaveModCache entries', () => {
  const result = appendModCacheSupplement(Buffer.from(shipped), Buffer.from(supplement), ledger());
  assert.equal(Buffer.from(result).toString(), merged);
  assert.deepEqual(modCacheKeys(result), ['a', 'b\\nc', 'a b', 'a b c']);
  // Non-UTF-8 bytes in the shipped module are preserved, not re-encoded.
  const binary = Buffer.concat([Buffer.from('local c = {}\n(function()\nc["\xe9"]={nil,"x"}\n', 'latin1'), Buffer.from('end)();\nreturn c\n')]);
  const binaryResult = Buffer.concat([binary.subarray(0, binary.length - 9), Buffer.from(supplement.slice(13))]);
  assert.deepEqual(Buffer.from(appendModCacheSupplement(binary, Buffer.from(supplement), ledger({
    sourceBlobHashes: { [modCachePath]: createHash('sha1').update(`blob ${binary.length}\0`).update(binary).digest('hex') },
    resultBlobHashes: { [modCachePath]: createHash('sha1').update(`blob ${binaryResult.length}\0`).update(binaryResult).digest('hex') },
  }))), binaryResult);
});

test('ModCache supplement rejects changed identities, formats and key sets', () => {
  const reject = (source, generated, pin, pattern) => assert.throws(() => appendModCacheSupplement(Buffer.from(source), Buffer.from(generated), pin), pattern);
  reject(shipped.replace('"a "', '"a  "'), supplement, ledger(), /shipped Data\/ModCache\.lua identity changed/);
  reject(shipped, supplement.replace('return c\n', 'return c'), ledger(), /generated supplement is not a SaveModCache module/);
  reject(shipped, supplement.replace('c["a b c"]', 'c["a"]'), ledger(), /generated keys must be new and unique/);
  reject(shipped, supplement.replace('c["a b c"]', 'c["a b"]'), ledger(), /generated keys must be new and unique/);
  reject(shipped, supplement, ledger({ entries: 3 }), /2 entries; source-pin\.json records 3/);
  reject(shipped, supplement, ledger({ resultBlobHashes: { [modCachePath]: '0'.repeat(40) } }), new RegExp(`candidate ${blob(merged)}`));
  assert.throws(() => modCacheKeys(Buffer.from('c[1]={nil,nil}\n')), /unrecognized cache entry/);
});

test('source ledger pins one generated ModCache supplement outside every overlay', async () => {
  const { pin } = await validateSourceLedger(appDir);
  const entry = pin.generated.masteryModCacheSupplement;
  assert.equal(entry.version, 1);
  assert.deepEqual(Object.keys(entry.sourceBlobHashes), [modCachePath]);
  const original = JSON.parse(await readFile(join(appDir, 'source-pin.json'), 'utf8'));
  for (const mutate of [
    candidate => { delete candidate.generated; },
    candidate => { candidate.generated.other = {}; },
    candidate => { candidate.generated.masteryModCacheSupplement.version = 2; },
    candidate => { candidate.generated.masteryModCacheSupplement.treeVersion = 'latest'; },
    candidate => { candidate.generated.masteryModCacheSupplement.entries = 0; },
    candidate => { candidate.generated.masteryModCacheSupplement.excluded = [{ key: 'x', reason: 'skipped' }]; },
    candidate => { candidate.generated.masteryModCacheSupplement.resultBlobHashes['src/Data/Other.lua'] = '0'.repeat(40); },
    candidate => { candidate.generated.masteryModCacheSupplement.sourceBlobHashes[modCachePath] = 'x'; },
    candidate => { candidate.adapters.calculationScheduling.resultBlobHashes[modCachePath] = '0'.repeat(40); },
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    await assert.rejects(validateSourceLedger(appDir, Buffer.from(JSON.stringify(candidate))), /Mastery ModCache supplement identity changed/);
  }
});

test('pack generates, merges and verifies the supplement with the driver interpreter', async () => {
  const wrapper = await readFile(join(appDir, 'scripts/build/pack.mjs'), 'utf8');
  const packer = await readFile(join(appDir, 'upstream/packages/packer/src/pack.ts'), 'utf8');
  const runtime = await readFile(join(appDir, 'scripts/build/build-runtime.mjs'), 'utf8');
  const generator = await readFile(join(appDir, 'scripts/build/mod-cache/supplement.lua'), 'utf8');
  const inventory = await readFile(join(appDir, 'docs/BUNDLED_POB_CHANGES.md'), 'utf8');
  assert.equal(runtime.includes(`const image = '${EMSDK_IMAGE}';`), true);
  assert.match(wrapper, /readFile\(join\(appDir, 'scripts\/patches\/mod-cache-supplement-patch\.mjs'\)\)/);
  assert.match(wrapper, /Buffer\.from\(\(await generatorInputs\(\)\)\.sha256\)/);
  assert.match(wrapper, /packer\(join\(modCacheDir, 'stage'\), '--stage'\)/);
  assert.match(wrapper, /packer\(payloadDir, `--mod-cache-supplement=\$\{supplementFile\}`\)/);
  assert.match(wrapper, /await verifyPackedSupplement\(/);
  assert.match(packer, /relPath === "Data\/ModCache\.lua" && modCacheSupplement\s*\? appendModCacheSupplement\(newContent, modCacheSupplement, pin\.generated\.masteryModCacheSupplement\)/);
  // PoB's own mastery-option path and serializer produce every entry.
  assert.match(generator, /new\('PassiveSpec'\):PassiveSpec\(build, treeVersion\)/);
  assert.match(generator, /specClass\.AddMasteryEffectOptionsToNode = function/);
  assert.match(generator, /pcall\(main\.SaveModCache, main\)/);
  assert.equal(inventory.includes('`masteryModCacheSupplement`'), true);
});
