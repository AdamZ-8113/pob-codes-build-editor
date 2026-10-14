// Browser trial of the PoB Sandbox branch perf/power-report-env-reuse (based on
// e6bc2a632). Applies its exact diff hunks to the packed core files. The CalcsTab
// hunk is adapted: in the editor, report options live in the helper-delegation
// adapter's CreateNodePowerCalculator, which UI and helper evaluations share.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
export const experiment = 'power-report-env-reuse-pob';

const diff = readFileSync(new URL('./env-reuse-pob.diff', import.meta.url), 'utf8');
const files = new Map();
let current;
for (const line of diff.split('\n')) {
  const file = /^\+\+\+ b\/src\/(.+)$/.exec(line);
  if (file) { current = { path: file[1], hunks: [] }; files.set(current.path, current); continue; }
  if (!current || /^(diff|index|---) /.test(line)) continue;
  if (line.startsWith('@@')) { current.hunks.push({ before: [], after: [] }); continue; }
  const hunk = current.hunks.at(-1);
  if (!hunk || line === '' && !hunk.before.length) continue;
  const body = line.slice(1);
  if (line[0] === ' ' || line === '') { hunk.before.push(body); hunk.after.push(body); }
  else if (line[0] === '-') hunk.before.push(body);
  else if (line[0] === '+') hunk.after.push(body);
}

function applyHunks(path) {
  return text => {
    for (const { before, after } of files.get(path).hunks) {
      const from = before.join('\n'), to = after.join('\n');
      assert.equal(text.split(from).length, 2, `${path} hunk context must match exactly once`);
      text = text.replace(from, () => to);
    }
    return text;
  };
}

const calcsTabAnchor = `\tlocal calcOptions = {
\t\tskipEHP = not (self.powerStat and self.powerStat.requiresEHP),
\t\tskipFullDPS = not useFullDPS,
\t}
\tlocal initialized = disableRelevance
`;
const calcsTabReplacement = `\tlocal calcOptions = {
\t\tskipEHP = not (self.powerStat and self.powerStat.requiresEHP),
\t\tskipFullDPS = not useFullDPS,
\t}
\t-- The private unpruned validation path also keeps full setup as its reference.
\tif not disableRelevance then
\t\tcalcOptions.reuseSetup = true
\tend
\tlocal initialized = disableRelevance
`;

assert.deepEqual([...files.keys()].sort(), ['Classes/CalcsTab.lua', 'Modules/CalcRelevance.lua', 'Modules/CalcSetup.lua', 'Modules/Calcs.lua']);
export const transforms = [
  { path: 'Modules/CalcSetup.lua', transform: applyHunks('Modules/CalcSetup.lua') },
  { path: 'Modules/Calcs.lua', transform: applyHunks('Modules/Calcs.lua') },
  { path: 'Modules/CalcRelevance.lua', transform: applyHunks('Modules/CalcRelevance.lua') },
  { path: 'Classes/CalcsTab.lua', transform(text) {
    assert.equal(text.split(calcsTabAnchor).length, 2, 'CreateNodePowerCalculator options anchor');
    return text.replace(calcsTabAnchor, () => calcsTabReplacement);
  } },
];
