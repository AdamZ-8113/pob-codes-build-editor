import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { transforms, identities, transformationEvidence } from '../../tools/experiments/node-power-delegation-experiment.mjs';
import { validateSourceLedger } from '../../scripts/build/source-ledger.mjs';

const appDir = fileURLToPath(new URL('../..', import.meta.url));
const { pin } = await validateSourceLedger(appDir);
const source = await readFile(new URL(`../../.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/src/Classes/CalcsTab.lua`, import.meta.url), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
test('node-power seam is exact, independently guarded, and rejects drift and double application', {skip: source === null}, () => {
  assert.equal(transforms.length, 1);
  const result = transforms[0].transform(source);
  assert.equal(createHash('sha256').update(result.replaceAll('\r\n', '\n')).digest('hex'), identities['Classes/CalcsTab.lua'].result);
  assert.throws(() => transforms[0].transform(source + '\n'), /Source identity/);
  assert.throws(() => transforms[0].transform(result), /Source identity/);
  assert.equal(transformationEvidence.length, 1);
  const end = 'function CalcsTabClass:CalculatePowerStat(';
  assert.equal(result.slice(result.indexOf(end)), source.slice(source.indexOf(end)));
});
