// Tree evidence for retained unified diffs. No fuzz, offset heuristics, or git apply.
export function parseDriftPatch(patch) {
  const text = patch.toString().replaceAll('\r\n', '\n');
  const sections = text.split(/^diff --git /m).slice(1);
  if (!sections.length) throw new Error('patch-inventory');
  return sections.map(section => {
    const lines = section.split('\n');
    const header = /^a\/(\S+) b\/\1$/.exec(lines.shift());
    if (!header || !/^(src|spec)\/[A-Za-z0-9_./-]+$/.test(header[1]) || header[1].split('/').includes('..')) throw new Error('patch-path');
    const path = header[1];
    const added = lines[0] === 'new file mode 100644';
    if (added) lines.shift();
    if (!/^index [a-f0-9]+\.\.[a-f0-9]+(?: 100644)?$/.test(lines.shift() ?? '') ||
        lines.shift() !== (added ? '--- /dev/null' : `--- a/${path}`) || lines.shift() !== `+++ b/${path}`) throw new Error('patch-header');
    while (lines.at(-1) === '') lines.pop();
    const blocks = [];
    while (lines.length) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(lines.shift());
      if (!hunk) throw new Error('patch-hunk');
      const before = [], after = [];
      let previous;
      while (lines.length && !lines[0].startsWith('@@ ')) {
        const line = lines.shift();
        if (line === '\\ No newline at end of file') {
          if (!previous) throw new Error('patch-newline');
          if (previous !== '+') before[before.length - 1] = before.at(-1).slice(0, -1);
          if (previous !== '-') after[after.length - 1] = after.at(-1).slice(0, -1);
          previous = null;
          continue;
        }
        if (![' ', '+', '-'].includes(line[0])) throw new Error('patch-line');
        if (line[0] !== '+') before.push(line.slice(1) + '\n');
        if (line[0] !== '-') after.push(line.slice(1) + '\n');
        previous = line[0];
      }
      if (before.length !== Number(hunk[2] ?? 1) || after.length !== Number(hunk[4] ?? 1)) throw new Error('patch-count');
      blocks.push({ before: before.join(''), after: after.join('') });
    }
    if (!blocks.length || (added && (blocks.length !== 1 || blocks[0].before !== ''))) throw new Error('patch-blocks');
    return { path, added, blocks };
  });
}

export function uniqueText(source, text) {
  if (typeof source !== 'string' || !text) return false;
  const at = source.indexOf(text);
  return at >= 0 && source.indexOf(text, at + 1) < 0;
}

export function absorptionEvidence(files, sections) {
  const states = sections.flatMap(({ path, added, blocks }) => blocks.map(({ before, after }) => {
    const source = files[path];
    if (added) return source === after;
    return uniqueText(source, after) && !source?.includes(before);
  }));
  return { all: states.every(Boolean), some: states.some(Boolean) };
}

export function transformDriftPatch(files, sections) {
  const result = { ...files };
  for (const { path, added, blocks } of sections) {
    if (added) {
      if (result[path] !== null && result[path] !== undefined) throw new Error('patch-existing-file');
      result[path] = blocks[0].after;
      continue;
    }
    for (const { before, after } of blocks) {
      if (!uniqueText(result[path], before)) throw new Error('patch-context');
      result[path] = result[path].replace(before, () => after);
    }
  }
  return result;
}

export function classifyPatch({ rawFiles, inputFiles = rawFiles, sections, touchedPaths, transform = files => transformDriftPatch(files, sections), blocked = false }) {
  const evidence = absorptionEvidence(rawFiles, sections);
  if (evidence.all) return { classification: 'absorbed', output: inputFiles };
  if (evidence.some) return { classification: 'partial', output: null };
  if (blocked) return { classification: 'conflict', output: null };
  try {
    const output = transform(inputFiles);
    return { classification: touchedPaths.length ? 'touched-applies' : 'untouched', output };
  } catch {
    return { classification: 'conflict', output: null };
  }
}
