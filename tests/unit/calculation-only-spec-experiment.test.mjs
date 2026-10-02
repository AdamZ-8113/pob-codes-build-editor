import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { transform, transformPassiveSpec, experiment, transformationEvidence, additionalTransforms } from '../../tools/experiments/calculation-only-spec-experiment.mjs';

const sourceRoot = new URL('../../.runtime/source-ab7e2808e25b/src/Classes/', import.meta.url);
const items = await readFile(new URL('ItemsTab.lua', sourceRoot), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const passive = await readFile(new URL('PassiveSpec.lua', sourceRoot), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const sha256 = text => createHash('sha256').update(text).digest('hex');

test('narrow upstream experiment records immutable provenance', () => {
  assert.equal(experiment.head, '5cafb7f4f05299f08f2e68e6aadfd13396c71642');
  assert.equal(additionalTransforms.length, 1);
  assert.equal(additionalTransforms[0].path, 'Classes/PassiveSpec.lua');
  assert.ok(Object.isFrozen(experiment));
});
test('ItemsTab changes only clone fields and calculation-only argument, plus phase instrumentation', { skip: !items }, () => {
  const result = transform(items);
  assert.match(result, /key ~= "pathDist" and key ~= "distanceToClassStart"/);
  assert.match(result, /_coldItemTimed\("specRebuild", spec.BuildAllDependsAndPaths, spec, true\)/);
  assert.ok(!result.includes('jewelComparisonOutputCache'));
  // The experiment must not rewrite the existing comparison eligibility body.
  const marker = 'function ItemsTabClass:AddItemStatDifferences(';
  const originalBody = items.slice(items.indexOf(marker));
  assert.ok(result.includes(originalBody));
  const record = transformationEvidence.find(entry => entry.path === 'Classes/ItemsTab.lua');
  assert.equal(record.originalSha256, sha256(items));
  assert.equal(record.resultSha256, sha256(result));
  assert.throws(() => transform(result), /once/);
});
test('PassiveSpec preserves calculator distances and gates only UI paths', { skip: !passive }, () => {
  const result = transformPassiveSpec(passive);
  assert.match(result, /BuildAllDependsAndPaths\(calculationOnly\)/);
  assert.match(result, /if not calculationOnly then\n\t\t-- Use a multi-source 0-1 BFS/);
  assert.match(result, /\n\tfor _, node in ipairs\(rootList\) do\n\t\tif node.isJewelSocket or node.expansionJewel then\n\t\t\tself:SetNodeDistanceToClassStart\(node\)/);
  assert.match(result, /if not calculationOnly then\n\t\tself:BuildSplitPersonalityPath\(\)\n\tend/);
  assert.equal(result.slice(0, result.indexOf('-- Rebuilds dependencies and calculation distances')),
    passive.slice(0, passive.indexOf('-- Rebuilds dependencies and paths')));
  const record = transformationEvidence.find(entry => entry.path === 'Classes/PassiveSpec.lua');
  assert.equal(record.originalSha256, sha256(passive));
  assert.equal(record.resultSha256, sha256(result));
  assert.throws(() => transformPassiveSpec(result), /once/);
  assert.throws(() => transformPassiveSpec(passive.replace('local queueLength = #queue', 'local queueLength = 99')), /BFS body/);
});
test('PassiveSpec handles CRLF while preserving its newline convention', { skip: !passive }, () => {
  const normalized = passive.replaceAll('\r\n', '\n');
  const crlf = normalized.replaceAll('\n', '\r\n');
  const result = transformPassiveSpec(crlf);
  assert.equal(result.replaceAll('\r\n', '\n'), transformPassiveSpec(normalized));
  assert.ok(!result.replaceAll('\r\n', '').includes('\n'));
});
