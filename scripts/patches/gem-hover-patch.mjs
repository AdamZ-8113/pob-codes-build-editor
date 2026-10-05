import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const blobHash = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

// Apply only the runtime file from the maintainer's unmodified upstream patch.
// Exact context and input/output hashes deliberately fail closed on source drift.
export function applyGemHoverPatch(source, patch, pin) {
  const path = 'src/Classes/GemSelectControl.lua';
  if (sha256(patch) !== pin.patchSha256) throw new Error('Gem hover patch hash mismatch');
  if (blobHash(source) !== pin.sourceBlobHashes[path]) throw new Error('Gem hover source hash mismatch');
  const result = transformGemHoverPatch(source, patch);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error('Gem hover result hash mismatch');
  return result;
}

export function transformGemHoverPatch(source, patch) {
  const path = 'src/Classes/GemSelectControl.lua';
  const section = patch.toString().replaceAll('\r\n', '\n').split('diff --git ')
    .find(part => part.startsWith(`a/${path} b/${path}\n`));
  if (!section) throw new Error('Gem hover runtime patch missing');
  const hunks = section.split(/^@@[^\n]*@@[^\n]*\n/m).slice(1);
  if (hunks.length !== 3) throw new Error('Gem hover patch hunks changed');
  let result = source;
  for (const hunk of hunks) {
    const lines = hunk.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.some(line => ![' ', '+', '-'].includes(line[0]))) throw new Error('Unsupported gem hover patch line');
    const before = lines.filter(line => line[0] !== '+').map(line => line.slice(1)).join('\n') + '\n';
    const after = lines.filter(line => line[0] !== '-').map(line => line.slice(1)).join('\n') + '\n';
    const at = result.indexOf(before);
    if (at < 0 || result.indexOf(before, at + 1) >= 0) throw new Error('Gem hover patch context mismatch');
    result = result.slice(0, at) + after + result.slice(at + before.length);
  }
  return result;
}
