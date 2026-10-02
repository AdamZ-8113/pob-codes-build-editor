import { createHash } from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

// Checked, isolated upstream-style hook. Never modifies the pinned checkout.
export function applyUniqueSortPatch(source, patch, pin) {
  const path = 'src/Classes/ItemDBControl.lua';
  if (hash(patch) !== pin.patchSha256 || blob(source) !== pin.sourceBlobHashes[path]) throw new Error('Unique sort delegation patch/source identity changed');
  const section = patch.toString().replaceAll('\r\n', '\n').split('diff --git ')
    .find(part => part.startsWith(`a/${path} b/${path}\n`));
  if (!section) throw new Error('Unique sort delegation runtime patch is missing');
  const hunks = section.split(/^@@[^\n]*@@[^\n]*\n/m).slice(1);
  if (hunks.length !== 2) throw new Error('Unique sort delegation hunk count changed');
  for (const hunk of hunks) {
    const lines = hunk.trimEnd().split('\n');
    if (lines.some(line => ![' ', '+', '-'].includes(line[0]))) throw new Error('Invalid delegation patch');
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
    const at = source.indexOf(before);
    if (at < 0 || source.indexOf(before, at + 1) >= 0) throw new Error('Delegation patch context changed');
    source = source.slice(0, at) + after + source.slice(at + before.length);
  }
  if (blob(source) !== pin.resultBlobHashes[path]) throw new Error('Delegation result identity changed');
  return source;
}
