// TEST ONLY. Applies retained upstream source changes to in-memory browser packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const experiment = Object.freeze({"name": "node-power-delegation", "base": "current shipped core; serial PowerBuilder", "patchSha256": "ae30b4f9516ebf59e68c1fcee6be122ad023b8477dfe7e5002937f6ebb1e6930", "scope": "In-memory source seam; helpers require default-off nodePowerHelpers=1"});
export const identities = Object.freeze({
  "Classes/CalcsTab.lua": Object.freeze({"source": "e5f0f283dc1149f530ea4c21ea4961f08ad1e1159d0d346f1329598ce5d564fa", "result": "6642f4f4aba8fe418ced8e1a4934fbedcde20c86c849930aa9a5293dd5bef430"})
});
const patch = readFileSync(new URL('./node-power-delegation.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
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
    const record = { path, originalSha256: sha256(original), resultSha256: sha256(result), experiment: experiment.name };
    const index = transformationEvidence.findIndex(entry => entry.path === path);
    if (index < 0) transformationEvidence.push(record);
    else transformationEvidence[index] = record;
    return result;
  } });
}));
