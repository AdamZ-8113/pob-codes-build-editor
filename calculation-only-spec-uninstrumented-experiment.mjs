// TEST ONLY: the same narrow PR #9863 subset, without Lua phase timers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { experiment as upstreamExperiment, transformPassiveSpec as passiveTransform } from './calculation-only-spec-experiment.mjs';

export const experiment = Object.freeze({ ...upstreamExperiment, instrumentation: 'none' });
export const transformationEvidence = [];
const sha256 = source => createHash('sha256').update(source).digest('hex');
function evidence(path, original, result) {
  const record = { path, originalSha256: sha256(original), resultSha256: sha256(result), upstreamHead: experiment.head };
  const index = transformationEvidence.findIndex(entry => entry.path === path);
  if (index < 0) transformationEvidence.push(record);
  else transformationEvidence[index] = record;
  return result;
}
function replaceOnce(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `Exact upstream calculation-only context occurs once: ${needle}`);
  return source.replace(needle, replacement);
}
export function transform(original) {
  let source = replaceOnce(original,
    'and key ~= "path" and key ~= "power" then',
    'and key ~= "path" and key ~= "pathDist" and key ~= "distanceToClassStart" and key ~= "power" then');
  source = replaceOnce(source, '\t\tspec:BuildAllDependsAndPaths()', '\t\tspec:BuildAllDependsAndPaths(true)');
  return evidence('Classes/ItemsTab.lua', original, source);
}
export function transformPassiveSpec(original) {
  return evidence('Classes/PassiveSpec.lua', original, passiveTransform(original));
}
export const additionalTransforms = [{ path: 'Classes/PassiveSpec.lua', transform: transformPassiveSpec }];
