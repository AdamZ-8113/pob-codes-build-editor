import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyNodePowerPatch } from '../../scripts/patches/node-power-patch.mjs';
import { transforms } from '../../tools/experiments/node-power-delegation-experiment.mjs';
import { parseDriftPatch, transformDriftPatch } from '../../scripts/build/drift-patch.mjs';
import { validateSourceLedger, validatePreparedRelevance, validateCompositeTree } from '../../scripts/build/source-ledger.mjs';

const { pin } = await validateSourceLedger(fileURLToPath(new URL('../..', import.meta.url)));
const adapter = pin.adapters.nodePowerDelegation;
const patch = await readFile(adapter.patchFile);
const relevancePatch = await readFile('patches/power-report-relevance-pruning.patch');
const environmentPatch = await readFile('patches/power-report-env-reuse.patch');
const source = await readFile(`.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/src/Classes/CalcsTab.lua`, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

test('relevance integration preserves the accepted browser traversal and rejects drift', { skip: source === null }, () => {
  const result = applyNodePowerPatch(source, patch, adapter);
  const reverse = section => ({ ...section, blocks: [...section.blocks].reverse().map(({ before, after }) => ({ before: after, after: before })) });
  const environment = parseDriftPatch(environmentPatch).find(section => section.path === 'src/Classes/CalcsTab.lua');
  const feature = parseDriftPatch(relevancePatch).find(section => section.path === 'src/Classes/CalcsTab.lua');
  const beforeEnvironment = transformDriftPatch({ [environment.path]: source }, [reverse(environment)])[environment.path];
  const original = transformDriftPatch({ [feature.path]: beforeEnvironment }, [reverse(feature)])[feature.path];
  const trial = transforms[0].transform(original);
  assert.equal(result.split('function CalcsTabClass:PowerBuilderPass(')[1], trial.split('function CalcsTabClass:PowerBuilderPass(')[1]);
  assert.match(result, /calcFunc = self:CreateNodePowerCalculator\(calcFunc, disableRelevance\)/);
  assert.match(result, /if not disableRelevance and self.evaluateNodePowerBatch/);
  assert.throws(() => applyNodePowerPatch(source + '\n', patch, adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(source, Buffer.concat([patch, Buffer.from('\n')]), adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(result, patch, adapter), /identity/);
  assert.throws(() => applyNodePowerPatch(source, patch, { ...adapter, resultBlobHashes: { 'src/Classes/CalcsTab.lua': '0'.repeat(40) } }), /identity/);
});

test('node-power ledger rejects unowned patches and changed source chains', async () => {
  for (const field of ['patchSha256', 'patchFile', 'sourceBlobHashes']) {
    const changed = structuredClone(pin);
    changed.adapters.nodePowerDelegation[field] = field === 'sourceBlobHashes' ? {} : 'changed';
    await assert.rejects(validateSourceLedger(process.cwd(), Buffer.from(JSON.stringify(changed))), /Node-power/);
  }
});

test('the composite tree is recomputed and rejects a wrong recorded tree', {skip:source === null}, async () => {
  const root = fileURLToPath(new URL(`../../.runtime/source-${pin.compositePatch.patchSha256.slice(0,12)}`, import.meta.url));
  const composite = await readFile(pin.compositePatch.patchFile);
  await validateCompositeTree(root, pin, composite);
  const changed = structuredClone(pin);
  changed.compositePatch.resultTree = '0'.repeat(40);
  await assert.rejects(validateCompositeTree(root, changed, composite), /result tree identity/);
});

test('Power Report patches remain required source layers across future bundles', async () => {
  for (const mutate of [
    p => { p.overlays = p.overlays.filter(o => o.id !== 'power-report-relevance-pruning'); },
    p => { p.overlays[5].applicationStage = 'pack-time'; },
    p => { delete p.compositePatch.resultBlobHashes['src/Modules/CalcRelevance.lua']; },
    p => { p.overlays[5].resultBlobHashes['src/Classes/CalcsTab.lua'] = '0'.repeat(40); },
    p => { p.overlays = p.overlays.filter(o => o.id !== 'power-report-environment-reuse'); },
    p => { p.overlays[6].applicationStage = 'pack-time'; },
    p => { delete p.compositePatch.resultBlobHashes['src/Modules/CalcSetupReuse.lua']; },
    p => { p.overlays[6].resultBlobHashes['src/Modules/CalcSetup.lua'] = '0'.repeat(40); },
  ]) {
    const changed = structuredClone(pin);
    mutate(changed);
    await assert.rejects(validateSourceLedger(process.cwd(), Buffer.from(JSON.stringify(changed))), /Power-report .*source overlay/);
  }
});

test('prepared source must contain the exact ordered Power Report patches', { skip: source === null }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pob-relevance-ledger-'));
  try {
    const paths = new Set(pin.overlays.filter(overlay => overlay.applicationStage === 'source-composite').flatMap(overlay => overlay.files));
    for (const path of paths) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), await readFile(`.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}/${path}`));
    }
    await validatePreparedRelevance(process.cwd(), directory, pin);
    const existing = 'src/Classes/ModDB.lua';
    const original = await readFile(join(directory, existing));
    await writeFile(join(directory, existing), Buffer.concat([original, Buffer.from('\n-- unrelated edit\n')]));
    await assert.rejects(validatePreparedRelevance(process.cwd(), directory, pin), /composition changed/);
    await writeFile(join(directory, existing), original);
    const path = 'src/Modules/CalcRelevance.lua';
    await writeFile(join(directory, path), '-- omitted local optimization\n');
    await assert.rejects(validatePreparedRelevance(process.cwd(), directory, pin), /composition changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
