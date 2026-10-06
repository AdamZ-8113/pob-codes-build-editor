import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { experiment, identities, transforms, transformationEvidence } from '../../tools/experiments/heatmap-first-power-builder-experiment.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const sources = Object.fromEntries(await Promise.all(transforms.map(async ({ path }) => [path,
  await readFile(new URL(`../../.runtime/source-ab7e2808e25b/src/${path}`, import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }),
])));

test('heatmap-first experiment is isolated from stage skipping and retains exact source inventory', () => {
  assert.ok(Object.isFrozen(experiment) && Object.isFrozen(transforms));
  assert.deepEqual(transforms.map(entry => entry.path), ['Classes/CalcsTab.lua', 'Classes/TreeTab.lua']);
  assert.equal(identities['Classes/CalcsTab.lua'].source, 'e5f0f283dc1149f530ea4c21ea4961f08ad1e1159d0d346f1329598ce5d564fa');
});

for (const { path, transform } of transforms) test(`heatmap-first exact patch and evidence: ${path}`, { skip: sources[path] === null }, () => {
  const source = sources[path], result = transform(source);
  assert.equal(hash(result.replaceAll('\r\n', '\n')), identities[path].result);
  const evidence = transformationEvidence.find(entry => entry.path === path);
  assert.equal(evidence.originalSha256, hash(source));
  assert.equal(evidence.resultSha256, hash(result));
  assert.throws(() => transform(result), /Source identity/);
  assert.throws(() => transform(source + '\n-- drift'), /Source identity/);
  const crlf = source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  assert.equal(transform(crlf).replaceAll('\r\n', '\n'), result.replaceAll('\r\n', '\n'));
});

test('heatmap-first preserves calculator semantics and changes only the builder and tree hooks', { skip: !sources['Classes/CalcsTab.lua'] }, () => {
  const source = sources['Classes/CalcsTab.lua'], result = transforms[0].transform(source);
  const start = source.indexOf('function CalcsTabClass:BuildPower()');
  const end = source.indexOf('function CalcsTabClass:CalculatePowerStat(');
  assert.equal(result.slice(0, start), source.slice(0, start));
  assert.equal(result.slice(result.indexOf('function CalcsTabClass:CalculatePowerStat(')), source.slice(end));
  assert.ok(result.includes('self.powerStat.stat == "FullDPS"'));
  assert.ok(!result.includes('skipEHP') && !result.includes('calcOptions'));
  assert.ok(result.includes('local useClusterPower = self.powerStat and self.powerStat.stat and not self.powerStat.ignoreForNodes'));
  assert.ok(result.includes('token ~= self.powerBuildToken'));
  assert.ok(result.includes('self.powerReportPending = token'));
  assert.ok(result.includes('self.powerReportBuilder = reportPhase'));
  assert.ok(result.includes('cache = nil'), 'Deferred work releases heatmap calculator outputs');
});

test('profiling heatmap excludes allocated mastery values but full snapshots preserve them', async () => {
  const diagnostics = await readFile(new URL('../../tools/profiles/heatmap-profile.lua', import.meta.url), 'utf8');
  assert.match(diagnostics, /if full or not node\.alloc then\s+power\('node:'[\s\S]*?for effect, value[\s\S]*?power\('mastery:'[\s\S]*?end\s+end/);
});
