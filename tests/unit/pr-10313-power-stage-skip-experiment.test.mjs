import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { experiment, identities, transforms, transformationEvidence } from '../../tools/experiments/pr-10313-power-stage-skip-experiment.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const sources = Object.fromEntries(await Promise.all(transforms.map(async ({ path }) => [path,
  await readFile(new URL(`../../.runtime/source-ab7e2808e25b/src/${path}`, import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }),
])));

test('stage-skip experiment records immutable upstream provenance and exact source inventory', () => {
  assert.ok(Object.isFrozen(experiment) && Object.isFrozen(transforms));
  assert.equal(experiment.head, '8117baa510edb1ef125df779814e5ae69b938d52');
  assert.equal(experiment.rawDiffSha256, 'f41b3a2fae6370b700104a4a6d926c8c5515115d8f6466196f27383347b5a9b7');
  assert.deepEqual(transforms.map(entry => entry.path), ['Classes/CalcsTab.lua', 'Modules/Calcs.lua', 'Modules/Data.lua']);
});

for (const { path, transform } of transforms) test(`exact stage-skip patch and evidence: ${path}`, { skip: sources[path] === null }, () => {
  const source = sources[path], result = transform(source);
  assert.equal(sha256(result.replaceAll('\r\n', '\n')), identities[path].result);
  const evidence = transformationEvidence.find(entry => entry.path === path);
  assert.equal(evidence.originalSha256, sha256(source));
  assert.equal(evidence.resultSha256, sha256(result));
  assert.throws(() => transform(result), /Source identity/);
  assert.throws(() => transform(source + '\n-- drift'), /Source identity/);
  const crlf = source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  assert.equal(transform(crlf).replaceAll('\r\n', '\n'), result.replaceAll('\r\n', '\n'));
});

test('stage skip preserves cluster gating and routes all six power calculator call sites', { skip: !sources['Classes/CalcsTab.lua'] }, () => {
  const source = sources['Classes/CalcsTab.lua'], result = transforms[0].transform(source);
  const start = source.indexOf('function CalcsTabClass:PowerBuilder()');
  const end = source.indexOf('function CalcsTabClass:CalculatePowerStat(');
  assert.equal(result.slice(0, start), source.slice(0, start));
  assert.equal(result.slice(result.indexOf('function CalcsTabClass:CalculatePowerStat(')), source.slice(end));
  assert.ok(result.includes('local useClusterPower = self.powerStat and self.powerStat.stat and not self.powerStat.ignoreForNodes'));
  assert.ok(result.includes('if useClusterPower and not node.alloc and node.modKey ~= ""'));
  const builder = result.slice(start, result.indexOf('function CalcsTabClass:CalculatePowerStat('));
  assert.equal((builder.match(/calcFunc\(/g) ?? []).length, 1, 'Only the option-passing helper invokes calcFunc');
  assert.equal((builder.match(/calcPower\(\{/g) ?? []).length, 6);
  assert.ok(builder.includes('return calcFunc(override, useFullDPS, calcOptions)'));
});

test('options remain optional and minion metrics inherit the original requirement flags', { skip: !sources['Modules/Calcs.lua'] || !sources['Modules/Data.lua'] }, () => {
  const calcs = transforms[1].transform(sources['Modules/Calcs.lua']);
  assert.ok(calcs.includes('calcs.perform(env, options and options.skipEHP)'));
  assert.ok(calcs.includes('not (options and options.skipFullDPS) and (useFullDPS ~= false or build.viewMode == "TREE")'));
  const data = transforms[2].transform(sources['Modules/Data.lua']);
  assert.equal((data.match(/requiresEHP=true/g) ?? []).length, 7);
  assert.equal((data.match(/requiresFullDPS=true/g) ?? []).length, 1);
  const minions = sources['Modules/Data.lua'].slice(sources['Modules/Data.lua'].indexOf('for i = 1, #data.powerStatList do'));
  assert.ok(data.includes(minions), 'Minion metric copying remains byte-identical');
});
