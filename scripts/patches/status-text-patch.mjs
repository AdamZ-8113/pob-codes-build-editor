import { createHash } from 'node:crypto';
import { parseDriftPatch, transformDriftPatch } from '../build/drift-patch.mjs';

const paths = [
  'src/Classes/GemSelectControl.lua',
  'src/Classes/TreeTab.lua',
  'src/Modules/ToastNotification.lua',
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

export function transformStatusTextPatch(source, patch, path) {
  if (!paths.includes(path)) throw new Error('Status-text patch path changed');
  const sections = parseDriftPatch(patch.toString()).filter(section => section.path === path);
  if (sections.length !== 1) throw new Error('Status-text patch inventory changed');
  return transformDriftPatch({ [path]: source }, sections)[path];
}

export function applyStatusTextPatch(source, patch, pin, path) {
  if (sha256(patch) !== pin.patchSha256 || blob(source) !== pin.sourceBlobHashes[path]) {
    throw new Error('Status-text patch/source identity changed');
  }
  const result = transformStatusTextPatch(source, patch, path);
  if (blob(result) !== pin.resultBlobHashes[path]) throw new Error('Status-text result identity changed');
  return result;
}
