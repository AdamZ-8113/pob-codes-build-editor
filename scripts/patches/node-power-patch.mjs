import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../build/drift-patch.mjs';

const path = 'src/Classes/CalcsTab.lua';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

export function transformNodePowerPatch(source, patch) {
  const sections = parseDriftPatch(patch.toString());
  if (sections.length !== 1 || sections[0].path !== path) throw new Error('Node-power patch inventory changed');
  return transformDriftPatch({ [path]: source }, sections)[path];
}

export function applyNodePowerPatch(source, patch, pin) {
  if (sha256(patch) !== pin.patchSha256 || blob(source) !== pin.sourceBlobHashes[path]) {
    throw new Error('Node-power patch/source identity changed');
  }
  const result = transformNodePowerPatch(source, patch);
  if (blob(result) !== pin.resultBlobHashes[path]) throw new Error('Node-power result identity changed');
  return result;
}
