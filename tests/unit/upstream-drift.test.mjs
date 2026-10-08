import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyPatch, parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';
import { analyzeDrift, driftExitCode, driftMarkdown, main, PACK_STAGES } from '../../scripts/build/upstream-drift.mjs';
import { blobHash } from '../../scripts/patches/gem-hover-patch.mjs';

const path = 'src/Classes/ImportTab.lua';
const patch = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n head\n-old\n+new\n tail\n`;
const sections = parseDriftPatch(patch);
const before = 'head\nold\ntail\n', after = 'head\nnew\ntail\n';
const classify = (raw, touched = [], extra = {}) => classifyPatch({ rawFiles: { [path]: raw }, sections, touchedPaths: touched, ...extra }).classification;

test('tree evidence distinguishes every class; merged metadata cannot prove absorption', () => {
  assert.equal(classify(before), 'untouched');
  assert.equal(classify('prefix\n' + before, [path]), 'touched-applies');
  assert.equal(classify('broken\n', [path]), 'conflict');
  assert.equal(classify(after, [path]), 'absorbed');
  assert.equal(classify(before, [], { prState: 'merged' }), 'untouched');
  assert.equal(classify(after + before, [path]), 'touched-applies');
  const two = parseDriftPatch(patch + patch.replaceAll(path, 'src/Classes/ItemsTab.lua'));
  assert.equal(classifyPatch({ rawFiles: { [path]: after, 'src/Classes/ItemsTab.lua': before }, sections: two, touchedPaths: [path] }).classification, 'partial');
});

test('absorption requires all blocks and rejects duplicate results and missing files', () => {
  assert.equal(classify(after + after, [path]), 'conflict');
  assert.equal(classify(null, [path]), 'conflict');
  const multi = sections.concat(parseDriftPatch(patch.replaceAll('old', 'old2').replaceAll('new', 'new2')));
  assert.equal(classifyPatch({ rawFiles: { [path]: after + 'head\nold2\ntail\n' }, sections: multi, touchedPaths: [path] }).classification, 'partial');
});

test('strict matcher rejects ambiguous context that git apply accepts by line position', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drift-unit-'));
  try {
    execFileSync('git', ['init', '--quiet', directory], { windowsHide: true });
    const file = 'sample.txt';
    await writeFile(join(directory, file), before + '\ngap\n' + before);
    const bytes = patch.replaceAll(path, file);
    execFileSync('git', ['-C', directory, 'apply', '--check', '-'], { input: bytes, windowsHide: true });
    assert.equal(classify(before + '\ngap\n' + before, [path]), 'conflict');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('new files and missing final newlines preserve exact blob identity', () => {
  const added = parseDriftPatch(`diff --git a/src/New.lua b/src/New.lua\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/src/New.lua\n@@ -0,0 +1 @@\n+content\n\\ No newline at end of file\n`);
  assert.equal(transformDriftPatch({ 'src/New.lua': null }, added)['src/New.lua'], 'content');
  assert.equal(classifyPatch({ rawFiles: { 'src/New.lua': 'content' }, sections: added, touchedPaths: ['src/New.lua'] }).classification, 'absorbed');
  assert.throws(() => parseDriftPatch(patch.replace('-1,3', '-1,9')), /patch-count/);
  assert.throws(() => parseDriftPatch(patch.replaceAll(path, 'src/../evil')), /patch-path/);
});

test('exit policies retain incomplete failure and Markdown never echoes raw diagnostics', () => {
  const report = { completion: 'complete', counts: { conflict: 0, partial: 0, absorbed: 0, 'touched-applies': 0 } };
  assert.equal(driftExitCode(report), 0);
  for (const value of ['conflict', 'partial']) {
    assert.equal(driftExitCode({ ...report, counts: { ...report.counts, [value]: 1 } }), 1);
  }
  const touched = { ...report, counts: { ...report.counts, 'touched-applies': 1 } };
  assert.equal(driftExitCode(touched), 0);
  assert.equal(driftExitCode(touched, 'touched'), 1);
  assert.equal(driftExitCode(touched, 'never'), 0);
  assert.equal(driftExitCode({ ...report, completion: 'incomplete' }, 'never'), 2);
  assert.throws(() => driftExitCode(report, 'invalid'));
  const markdown = driftMarkdown({ ...report, capturedAt: '2026-10-05T00:00:00.000Z', entries: [], informationalPrs: [], errorCode: 'collection-failed', rawError: 'sentinel-secret @everyone webhook' });
  assert.doesNotMatch(markdown, /sentinel|@everyone|webhook/);
});

test('CLI persists conflicts and incomplete reports before applying its exit code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drift-cli-unit-'));
  const previous = process.exitCode;
  try {
    const output = join(directory, 'report.json'), summary = join(directory, 'summary.md');
    const report = { schemaVersion: 1, completion: 'complete', capturedAt: '2026-10-05T00:00:00Z',
      entries: [{ id: 'composite', classification: 'conflict', touchedPaths: [path], prState: null }],
      counts: { conflict: 1, partial: 0, 'touched-applies': 0, absorbed: 0, untouched: 0 }, informationalPrs: [] };
    let printed;
    await main(['--fail-on=conflict', '--json', '--output', output], {
      collect: async () => structuredClone(report), env: { GITHUB_STEP_SUMMARY: summary }, print: value => { printed = value; },
    });
    assert.equal(process.exitCode, 1);
    assert.equal(JSON.parse(await readFile(output)).counts.conflict, 1);
    assert.deepEqual(JSON.parse(printed), JSON.parse(await readFile(output)));
    assert.match(await readFile(summary, 'utf8'), /composite.*conflict/);
    await main(['--fail-on=never', '--output', output], { collect: async () => ({ ...report, completion: 'incomplete' }), env: {}, print: () => {} });
    assert.equal(process.exitCode, 2);
    assert.equal(JSON.parse(await readFile(output)).completion, 'incomplete');
  } finally {
    process.exitCode = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('pack-time inventory and actual chained transforms produce source and result identities', async () => {
  const pin = JSON.parse(await readFile('source-pin.json'));
  const patches = {};
  const raw = {};
  // Build each minimal runtime input from its retained exact contexts. Include
  // the original whitespace: no fixture downloads or prepared-source dependency.
  for (const [name] of PACK_STAGES) patches[pin.adapters[name].patchFile] = await readFile(pin.adapters[name].patchFile);
  for (const name of ['limitedUniqueItemComparisons', 'gemDropdownHover', 'uniqueSortDelegation', 'importTabHostCapabilities', 'nodePowerDelegation']) {
    for (const section of parseDriftPatch(patches[pin.adapters[name].patchFile])) {
      if (section.path.startsWith('src/')) raw[section.path] = section.blocks.map(block => block.before).join('\nseparation\n');
    }
  }
  // Jewel-spec contexts are disjoint from the item-comparison block, and the
  // preferred-export context is disjoint from host-capability context.
  for (const name of ['calculationOnlyJewelSpecs', 'preferredExportSite', 'compactStatusText']) {
    for (const section of parseDriftPatch(patches[pin.adapters[name].patchFile])) {
      raw[section.path] = (raw[section.path] ?? '') + '\nseparation\n' + section.blocks.map(block => block.before).join('\nseparation\n');
    }
  }
  const identityPatch = patch.replaceAll(path, 'src/Marker.lua');
  patches.composite = identityPatch;
  raw['src/Marker.lua'] = before;
  const mainPath = 'src/Modules/Main.lua';
  const mainSource = await readFile(`.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/${mainPath}`, 'utf8').catch(() => null);
  if (mainSource !== null) raw[mainPath] = mainSource;
  const adapters = mainSource === null
    ? Object.fromEntries(Object.entries(pin.adapters).filter(([name]) => name !== 'browserUiDefaults'))
    : pin.adapters;
  const tinyPin = { compositePatch: { patchFile: 'composite', files: ['src/Marker.lua'] }, overlays: [], adapters };
  const result = analyzeDrift({ pin: tinyPin, patches, baseFiles: raw, targetFiles: raw, identities: true });
  assert.equal(result.counts.conflict, 0);
  assert.equal(result.counts.partial, 0);
  assert.equal(result.counts.untouched, result.entries.length);
  const identities = result.identities.adapters;
  assert.equal(identities.preferredExportSite.sourceBlobHashes[path], identities.importTabHostCapabilities.resultBlobHashes[path]);
  assert.equal(identities.preferredExportSite.preparedSourceBlobHashes[path], blobHash(raw[path]));
  const items = 'src/Classes/ItemsTab.lua';
  assert.equal(identities.calculationOnlyJewelSpecs.sourceBlobHashes[items], identities.limitedUniqueItemComparisons.resultBlobHashes[items]);
  assert.equal(identities.uniqueSortDelegation.sourceBlobHashes['src/Classes/ItemDBControl.lua'], blobHash(raw['src/Classes/ItemDBControl.lua']));
  if (mainSource !== null) {
    assert.equal(identities.browserUiDefaults.sourceBlobHashes[mainPath], pin.adapters.browserUiDefaults.sourceBlobHashes[mainPath]);
    assert.equal(identities.browserUiDefaults.resultBlobHashes[mainPath], pin.adapters.browserUiDefaults.resultBlobHashes[mainPath]);
  }
  const touched = analyzeDrift({ pin: tinyPin, patches, baseFiles: raw, targetFiles: { ...raw, 'src/Classes/ItemDBControl.lua': '// upstream edit\n' + raw['src/Classes/ItemDBControl.lua'] } });
  assert.equal(touched.entries.find(entry => entry.id === 'uniqueSortDelegation').classification, 'touched-applies');
});

test('a two-PR composite with one absorbed PR remains partial and blocks dependent identities', () => {
  const otherPath = 'src/Classes/ItemsTab.lua';
  const otherPatch = patch.replaceAll(path, otherPath);
  const pin = { compositePatch: { files: [path, otherPath], patchFile: 'composite' },
    overlays: [{ kind: 'upstream-pr', number: 1, files: [path], patchFile: 'one' }, { kind: 'upstream-pr', number: 2, files: [otherPath], patchFile: 'two' }],
    adapters: Object.fromEntries(PACK_STAGES.map(([name]) => [name, { patchFile: 'one', sourceBlobHashes: { [path]: 'unused' } }])) };
  const result = analyzeDrift({ pin, patches: { composite: patch + otherPatch, one: patch, two: otherPatch },
    baseFiles: { [path]: before, [otherPath]: before }, targetFiles: { [path]: after, [otherPath]: before }, prStates: { 'pob:2': 'merged' }, identities: true });
  assert.equal(result.entries[0].classification, 'partial');
  assert.equal(result.entries.find(entry => entry.id === 'pr-1').classification, 'absorbed');
  assert.equal(result.entries.find(entry => entry.id === 'pr-2').classification, 'untouched');
  assert.equal(result.identities.compositePatch, null);
  assert.deepEqual(result.identities.adapters, {});
});

test('source-local overlays remain visible in drift and report upstream absorption', () => {
  const pin = { compositePatch: { files: [path], patchFile: 'composite' },
    overlays: [{ kind: 'local-patch', id: 'local-relevance', applicationStage: 'source-composite', files: [path], patchFile: 'local' }],
    adapters: Object.fromEntries(PACK_STAGES.map(([name]) => [name, { patchFile: 'local', sourceBlobHashes: { [path]: 'unused' } }])) };
  for (const [target, expected] of [[before, 'untouched'], [after, 'absorbed'], ['broken\n', 'conflict']]) {
    const result = analyzeDrift({ pin, patches: { composite: patch, local: patch }, baseFiles: { [path]: before }, targetFiles: { [path]: target } });
    assert.equal(result.entries.find(entry => entry.id === 'local-relevance').classification, expected);
  }
});
