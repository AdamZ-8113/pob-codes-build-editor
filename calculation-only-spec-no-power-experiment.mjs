// TEST ONLY: clean upstream calculation-only subset plus one local allocation experiment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  experiment as calculationOnlyExperiment,
  transform as calculationOnlyTransform,
  transformPassiveSpec as calculationOnlyPassiveTransform,
} from './calculation-only-spec-uninstrumented-experiment.mjs';

export const experiment = Object.freeze({
  ...calculationOnlyExperiment,
  scope: `${calculationOnlyExperiment.scope}; local omission of unused comparison-node power tables`,
  localChange: 'Omit nodeCopy.power allocation; this addition is not part of upstream PR #9863',
});
export const transformationEvidence = [];
const sha256 = source => createHash('sha256').update(source).digest('hex');
function evidence(path, original, result) {
  const record = {
    path, originalSha256: sha256(original), resultSha256: sha256(result), upstreamHead: experiment.head,
    localChange: path === 'Classes/ItemsTab.lua' ? experiment.localChange : null,
  };
  const index = transformationEvidence.findIndex(entry => entry.path === path);
  if (index < 0) transformationEvidence.push(record);
  else transformationEvidence[index] = record;
  return result;
}

export function transform(original) {
  let source = calculationOnlyTransform(original);
  // Keep owned depends/intuitiveLeapLikesAffecting tables intact. Only power is
  // exclusively heatmap/UI state, outside the temporary-spec calculator path.
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const context = [
    '\t\tnodeCopy.depends = { }',
    '\t\tnodeCopy.intuitiveLeapLikesAffecting = { }',
    '\t\tnodeCopy.power = { }',
    '\t\tspecCopy.nodes[id] = nodeCopy',
  ].join(eol);
  assert.equal(source.split(context).length, 2, 'Exact clone-owned-table context occurs once');
  source = source.replace(context, context.replace(`\t\tnodeCopy.power = { }${eol}`, ''));
  return evidence('Classes/ItemsTab.lua', original, source);
}
export function transformPassiveSpec(original) {
  return evidence('Classes/PassiveSpec.lua', original, calculationOnlyPassiveTransform(original));
}
export const additionalTransforms = [{ path: 'Classes/PassiveSpec.lua', transform: transformPassiveSpec }];
