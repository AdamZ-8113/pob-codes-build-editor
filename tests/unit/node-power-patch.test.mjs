import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyNodePowerPatch } from '../../scripts/patches/node-power-patch.mjs';
import { transforms } from '../../tools/experiments/node-power-delegation-experiment.mjs';
import { validateSourceLedger } from '../../scripts/build/source-ledger.mjs';

const { pin } = await validateSourceLedger(fileURLToPath(new URL('../..', import.meta.url)));
const adapter = pin.adapters.nodePowerDelegation;
const patch = await readFile(adapter.patchFile);
const source = await readFile(`.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/src/Classes/CalcsTab.lua`, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

test('bundled node-power adapter is exactly the accepted browser trial and rejects drift', { skip: source === null }, () => {
  const result = applyNodePowerPatch(source, patch, adapter);
  assert.equal(result, transforms[0].transform(source));
  assert.throws(() => applyNodePowerPatch(source + '\n', patch, adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(source, Buffer.concat([patch, Buffer.from('\n')]), adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(result, patch, adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(source, patch, { ...adapter, resultBlobHashes: { 'src/Classes/CalcsTab.lua': '0'.repeat(40) } }), /identity/);
});

test('node-power ledger rejects unowned patches and changed source chains', async () => {
  for (const field of ['patchSha256', 'patchFile', 'sourceBlobHashes']) {
    const changed = structuredClone(pin);
    changed.adapters.nodePowerDelegation[field] = field === 'sourceBlobHashes' ? {} : 'changed';
    await assert.rejects(validateSourceLedger(process.cwd(), Buffer.from(JSON.stringify(changed))), /Node-power/);
  }
});
