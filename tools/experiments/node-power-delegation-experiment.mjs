// TEST ONLY. Applies retained upstream source changes to in-memory browser packages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
export const experiment = Object.freeze({"name": "node-power-delegation", "base": "current shipped core; serial PowerBuilder", "patchSha256": "40e1aecced538be4145c7e5c5c96d8f2f9910bef633c9abd6f9e22d30e7c540f", "scope": "In-memory source seam; helpers require default-off nodePowerHelpers=1"});
export const identities = Object.freeze({
  "Classes/CalcsTab.lua": Object.freeze({"source": "b25fdf2f60a5cb1e50d96fbe0e7fb6c8b854e01d67763c5c89304b428d11d835", "result": "2b6c98ac3e1b649bf468399bcc94a00d78ba02dd42bc705fa3e2db801cd5fdf8"})
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
