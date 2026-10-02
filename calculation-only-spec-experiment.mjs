// TEST ONLY. Narrow calculation-only spec subset of upstream PR #9863.
// Applied to in-memory acceptance packages; does not change source-pin/payload.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { transform as profileTransform } from './cold-item-source-profile.mjs';

export const experiment = Object.freeze({
  url: 'https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/9863',
  head: '5cafb7f4f05299f08f2e68e6aadfd13396c71642',
  scope: 'Calculation-only temporary jewel specs; excludes upstream output cache and CompareTab changes',
  instrumentation: 'cold-item-source-profile.mjs; inclusive numeric phase timings',
});
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
  let source = profileTransform(original);
  source = replaceOnce(source,
    'and key ~= "path" and key ~= "power" then',
    'and key ~= "path" and key ~= "pathDist" and key ~= "distanceToClassStart" and key ~= "power" then');
  source = replaceOnce(source,
    '_coldItemTimed("specRebuild", spec.BuildAllDependsAndPaths, spec)',
    '_coldItemTimed("specRebuild", spec.BuildAllDependsAndPaths, spec, true)');
  return evidence('Classes/ItemsTab.lua', original, source);
}

export function transformPassiveSpec(original) {
  const normalized = original.replaceAll('\r\n', '\n');
  let source = replaceOnce(normalized,
    '-- Rebuilds dependencies and paths for all nodes\nfunction PassiveSpecClass:BuildAllDependsAndPaths()',
    '-- Rebuilds dependencies and calculation distances for all nodes.\n'
      + '-- Calculation-only specs leave UI path fields unset while still refreshing jewel\n'
      + '-- socket distanceToClassStart values used by the calculator.\n'
      + '---@param calculationOnly? boolean\nfunction PassiveSpecClass:BuildAllDependsAndPaths(calculationOnly)');
  source = replaceOnce(source,
    '\t\tnode.pathDist = (node.alloc and #node.intuitiveLeapLikesAffecting == 0) and 0 or 1000\n\t\tnode.path = nil',
    '\t\tif calculationOnly then\n\t\t\tnode.pathDist = nil\n\t\t\tnode.path = nil\n\t\telse\n'
      + '\t\t\tnode.pathDist = (node.alloc and #node.intuitiveLeapLikesAffecting == 0) and 0 or 1000\n'
      + '\t\t\tnode.path = nil\n\t\tend');
  const bfsStart = '\t-- Use a multi-source 0-1 BFS to find the closest allocated node. Allocated';
  const distanceStart = '\n\tfor _, node in ipairs(rootList) do\n\t\tif node.isJewelSocket or node.expansionJewel then\n\t\t\tself:SetNodeDistanceToClassStart(node)';
  assert.equal(source.split(bfsStart).length, 2, 'Exact upstream UI BFS start occurs once');
  assert.equal(source.split(distanceStart).length, 2, 'Calculator socket-distance pass occurs once');
  const start = source.indexOf(bfsStart);
  const end = source.indexOf(distanceStart, start);
  assert.ok(end > start, 'UI BFS precedes preserved calculator socket distances');
  const bfs = source.slice(start, end);
  assert.equal(sha256(bfs), 'b23056ab528bd85d516f7049e2e0aaac1680cf5740a2ff7db52bfab28049fa77',
    'Exact upstream UI BFS body; reject unreviewed drift');
  const indented = bfs.replace(/^(?=\S|\t)/gm, '\t');
  source = source.slice(0, start) + '\tif not calculationOnly then\n' + indented + '\tend\n' + source.slice(end);
  source = replaceOnce(source,
    '\tself:BuildSplitPersonalityPath()\nend\n\nfunction PassiveSpecClass:ReplaceNode',
    '\tif not calculationOnly then\n\t\tself:BuildSplitPersonalityPath()\n\tend\nend\n\nfunction PassiveSpecClass:ReplaceNode');
  // Preserve the input's newline convention, including on Windows checkouts.
  if (original.includes('\r\n')) source = source.replaceAll('\n', '\r\n');
  return evidence('Classes/PassiveSpec.lua', original, source);
}

export const additionalTransforms = [{ path: 'Classes/PassiveSpec.lua', transform: transformPassiveSpec }];
