// TEST ONLY. Applies retained upstream source changes to in-memory browser packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const experiment = Object.freeze({
  "name": "heatmap-first-power-builder",
  "base": "current shipped core; independent of PR #10313",
  "patchSha256": "c83a56b241c50b3b79ef0506f24f9fa51e51b27f4d3d3a6c37f19e5393162748",
  "scope": "In-memory CalcsTab/TreeTab experiment only; no shipped payload changes"
});

export const identities = Object.freeze({
  "Classes/CalcsTab.lua": Object.freeze({"source": "e5f0f283dc1149f530ea4c21ea4961f08ad1e1159d0d346f1329598ce5d564fa", "result": "50fd5f2eb51d6c9e421d5cac141a68cbac522e007152630bf40fadd175d226b6"}),
  "Classes/TreeTab.lua": Object.freeze({"source": "3f095dff36e5fe7c82e7bc62767bc49e08fd048e780a42168035c87caa6333f5", "result": "4e6d20332c8399bd6f820be4ac74c65b62c193de449ec729d733e4b17b70dd94"})
});
const patch = readFileSync(new URL('./heatmap-first-power-builder.patch', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
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
