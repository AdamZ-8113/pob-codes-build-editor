import { blobHash, sha256 } from './gem-hover-patch.mjs';

const runtimeHunks = new Map([
  ['src/Classes/ItemsTab.lua', 3],
  ['src/Classes/PassiveSpec.lua', 4],
]);

// Apply the retained runtime patch to in-memory pack inputs only. The narrow
// upstream #9863 subset and our separate power-table allocation omission are
// recorded in source-pin.json; neither experimental instrumentation nor PoB's
// calculator formulas are part of this adapter.
export function applyJewelSpecPatch(source, patch, pin, path) {
  if (sha256(patch) !== pin.patchSha256) throw new Error('Jewel spec patch hash mismatch');
  if (!runtimeHunks.has(path)) throw new Error('Jewel spec runtime path is unsupported');
  if (blobHash(source) !== pin.sourceBlobHashes[path]) throw new Error('Jewel spec source hash mismatch');
  const result = transformJewelSpecPatch(source, patch, path);
  if (blobHash(result) !== pin.resultBlobHashes[path]) throw new Error('Jewel spec result hash mismatch');
  return result;
}

export function transformJewelSpecPatch(source, patch, path) {
  if (!runtimeHunks.has(path)) throw new Error('Jewel spec runtime path is unsupported');

  const sections = patch.toString().replaceAll('\r\n', '\n').split('diff --git ').slice(1);
  if (sections.length !== runtimeHunks.size || !patch.toString().startsWith('diff --git ')) {
    throw new Error('Jewel spec runtime patch inventory changed');
  }
  let selected;
  for (const [index, [sectionPath, expectedHunks]] of [...runtimeHunks].entries()) {
    const lines = sections[index].split('\n');
    if (lines.shift() !== `a/${sectionPath} b/${sectionPath}` ||
        !/^index [a-f0-9]{7}\.\.[a-f0-9]{7} 100644$/.test(lines.shift() ?? '') ||
        lines.shift() !== `--- a/${sectionPath}` || lines.shift() !== `+++ b/${sectionPath}`) {
      throw new Error('Jewel spec runtime patch inventory changed');
    }
    if (lines.at(-1) === '') lines.pop();
    const hunks = [];
    while (lines.length) {
      const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(?: .*|)$/.exec(lines.shift());
      if (!header) throw new Error('Unsupported jewel spec patch hunk');
      const body = [];
      while (lines.length && !lines[0].startsWith('@@ ')) body.push(lines.shift());
      if (body.some(line => ![' ', '+', '-'].includes(line[0]))) {
        throw new Error('Unsupported jewel spec patch line');
      }
      const beforeLines = body.filter(line => line[0] !== '+').map(line => line.slice(1));
      const afterLines = body.filter(line => line[0] !== '-').map(line => line.slice(1));
      if (Number(header[1]) < 1 || Number(header[3]) < 1 ||
          beforeLines.length !== Number(header[2]) || afterLines.length !== Number(header[4])) {
        throw new Error('Jewel spec patch hunk counts changed');
      }
      hunks.push({ before: beforeLines.join('\n') + '\n', after: afterLines.join('\n') + '\n' });
    }
    if (hunks.length !== expectedHunks) throw new Error('Jewel spec patch hunks changed');
    if (sectionPath === path) selected = hunks;
  }

  let result = source;
  for (const { before, after } of selected) {
    const at = result.indexOf(before);
    if (at < 0 || result.indexOf(before, at + 1) >= 0) throw new Error('Jewel spec patch context mismatch');
    result = result.slice(0, at) + after + result.slice(at + before.length);
  }
  return result;
}
