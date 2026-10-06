// TEST ONLY. Applies retained upstream source changes to in-memory browser packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const experiment = Object.freeze({
  url: 'https://github.com/PathOfBuildingCommunity/PathOfBuilding/pull/10313',
  head: '8117baa510edb1ef125df779814e5ae69b938d52',
  rawDiffSha256: 'f41b3a2fae6370b700104a4a6d926c8c5515115d8f6466196f27383347b5a9b7',
  patchSha256: '91e0c3d8f374fc8ca3f2960020940483bb64dd6c48026455770d80d7a82b6c0d',
  scope: 'All three upstream src/ sections; no test/spec or shipped payload changes',
  resolution: 'Retain #10373 useClusterPower declaration in the first CalcsTab hunk. In the final cluster hunk, retain its outer useClusterPower guard and unconditional singleStat assignment as context. Only the calculator call changes there.',
});

export const identities = Object.freeze({
  'Classes/CalcsTab.lua': Object.freeze({
    source: 'e5f0f283dc1149f530ea4c21ea4961f08ad1e1159d0d346f1329598ce5d564fa',
    result: '639090c0722129115b0efc1b68796fb61a511b0d72d359768284f6070169e860',
  }),
  'Modules/Calcs.lua': Object.freeze({
    source: '6a139752fb368865fdbae66b4753af284621a780a11a4d5cecbe0367ca003be6',
    result: '0c70ce57b9c43c716a1e3e1d14b78d2f755da8a02587c213bd832bbfc5f9d4aa',
  }),
  'Modules/Data.lua': Object.freeze({
    source: '0b28d109fe2bda535059ba21ba1ccad6615497ba29eec8e323442089b00a1158',
    result: '3b2afcfe3ed1093a22077937ae3019cc434d79757da0a908e51af99072e04d45',
  }),
});
const patch = readFileSync(new URL('./pr-10313-power-stage-skip.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
assert.equal(sha256(patch), experiment.patchSha256, 'Retained experiment patch identity');
const sections = parseDriftPatch(patch);
assert.deepEqual(sections.map(section => section.path), Object.keys(identities).map(path => `src/${path}`), 'Exact source-only patch inventory');
export const transformationEvidence = [];
export const transforms = Object.freeze(sections.map(section => {
  const path = section.path.slice(4), identity = identities[path];
  return Object.freeze({ path, transform(original) {
    const normalized = original.replaceAll('\r\n', '\n');
    assert.equal(sha256(normalized), identity.source, `Source identity: ${path}`);
    const transformed = transformDriftPatch({ [section.path]: normalized }, [section])[section.path];
    assert.equal(sha256(transformed), identity.result, `Result identity: ${path}`);
    const result = original.includes('\r\n') ? transformed.replaceAll('\n', '\r\n') : transformed;
    const record = { path, originalSha256: sha256(original), resultSha256: sha256(result), upstreamHead: experiment.head };
    const index = transformationEvidence.findIndex(entry => entry.path === path);
    if (index < 0) transformationEvidence.push(record);
    else transformationEvidence[index] = record;
    return result;
  } });
}));
