import { blobHash, sha256 } from './gem-hover-patch.mjs';

// Upstream-style Lua optimization, applied only to the in-memory pack input.
// Patch identity, exact context, source identity and result identity fail closed.
export function applyItemComparisonPatch(source, patch, pin) {
  const path = 'src/Classes/ItemsTab.lua';
  if (sha256(patch) !== pin.patchSha256) throw new Error('Item comparison patch hash mismatch');
  if (blobHash(source) !== pin.sourceBlobHashes[path]) throw new Error('Item comparison source hash mismatch');
  const sections = patch.toString().replaceAll('\r\n', '\n').split('diff --git ').slice(1);
  if (sections.length !== 1 || !sections[0].startsWith(`a/${path} b/${path}\n`)) {
    throw new Error('Item comparison runtime patch inventory changed');
  }
  const hunks = sections[0].split(/^@@[^\n]*@@[^\n]*\n/m).slice(1);
  if (hunks.length !== 1) throw new Error('Item comparison patch hunks changed');
  const lines = hunks[0].split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some(line => ![' ', '+', '-'].includes(line[0]))) throw new Error('Unsupported item comparison patch line');
  const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
  const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + 1) >= 0) throw new Error('Item comparison patch context mismatch');
  const result = source.slice(0, at) + after + source.slice(at + before.length);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error('Item comparison result hash mismatch');
  return result;
}
