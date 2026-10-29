import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractPayload } from './build/mod-cache/supplement.mjs';
import { sha256, validateSourceLedger, validatePreparedRelevance } from './build/source-ledger.mjs';
import { parseDriftPatch, transformDriftPatch } from './build/drift-patch.mjs';

export const compatibilitySpecs = Object.freeze([
  'TestPowerReport', 'TestItemDBControl', 'TestGemSocketQuality', 'TestTriggers',
  'TestItemMods', 'TestSkills', 'TestImport', 'TestGemSelectControl',
  'TestItemListControl', 'TestCompareBuySimilar',
]);
export function selectCompatibilitySpecs(names) {
  assert.ok(names.length && new Set(names).size === names.length && names.every(name => compatibilitySpecs.includes(name)), 'Nonempty, known, unique spec selection');
  return names.map(name => `spec/System/${name}_spec.lua`);
}

async function main() {
  const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const { pin } = await validateSourceLedger(process.cwd());
  const source = resolve(option('source-root', `.runtime/source-${pin.compositePatch.patchSha256.slice(0, 12)}`));
  const payload = resolve(option('payload', '.runtime/payload'));
  const image = option('image', 'ghcr.io/pathofbuildingcommunity/pathofbuilding-tests@sha256:171dc3da232b8c874882e4ae3b3aa4a6e130a6c9450a31904b312435a6bf5daf');
  assert.match(image, /^ghcr\.io\/pathofbuildingcommunity\/pathofbuilding-tests@sha256:[a-f0-9]{64}$/, 'Immutable upstream test image');
  assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(), pin.revision, 'Spec checkout matches pinned target');
  await validatePreparedRelevance(process.cwd(), source, pin);
  const manifestBytes = await readFile(join(payload, 'manifest.json'));
  const provenance = JSON.parse(await readFile(join(payload, 'provenance.json')));
  assert.equal(JSON.parse(manifestBytes).sourceRevision, pin.revision, 'Payload target identity');
  assert.equal(provenance.manifestSha256, sha256(manifestBytes), 'Payload manifest identity');
  assert.equal(provenance.compositePatch.patchSha256, pin.compositePatch.patchSha256, 'Payload source-chain identity');
  assert.deepEqual(provenance.adapters, pin.adapters, 'Payload adapter identities');
  const specs = selectCompatibilitySpecs(option('specs', compatibilitySpecs.join(',')).split(','));
  const scratch = await mkdtemp(join(tmpdir(), 'pob-upstream-tests-'));
  try {
    await extractPayload(payload, join(scratch, 'src'));
    await cp(join(source, 'spec'), join(scratch, 'spec'), { recursive: true });
    // Specs are retained in the original adapter patches but are not shipped.
    for (const name of ['gemDropdownHover', 'uniqueSortDelegation']) {
      const sections = parseDriftPatch(await readFile(pin.adapters[name].patchFile)).filter(section => section.path.startsWith('spec/'));
      assert.ok(sections.length, `${name} retains its upstream regression specs`);
      const files = Object.fromEntries(await Promise.all(sections.map(async section => [section.path, await readFile(join(scratch, section.path), 'utf8')])));
      for (const [path, text] of Object.entries(transformDriftPatch(files, sections))) await writeFile(join(scratch, path), text);
    }
    for (const path of specs) await access(join(scratch, path));
    // Headless-only files omitted by the packer are test scaffolding, never
    // replacements for any runtime module extracted from verified packages.
    for (const path of ['HeadlessWrapper.lua', '_SimpleGraphic.def.lua']) {
      try { await access(join(scratch, 'src', path)); }
      catch { await cp(join(source, 'src', path), join(scratch, 'src', path)); }
    }
    await mkdir(join(scratch, 'src', 'Builds'), {recursive:true});
    const args = ['run', '--rm', '--network=none',
      '--mount', `type=bind,src=${source},dst=/pob,readonly`,
      '--mount', `type=bind,src=${join(scratch,'src')},dst=/pob/src,readonly`,
      '--mount', `type=bind,src=${join(scratch,'spec')},dst=/pob/spec,readonly`,
      '--mount', `type=bind,src=${resolve('tests/lua/upstream-stage-engagement_spec.lua')},dst=/tests/stage-engagement_spec.lua,readonly`,
      '--workdir', '/pob', image, 'busted', '--lua=luajit', ...specs.map(path => `../${path}`), '/tests/stage-engagement_spec.lua'];
    console.log(`Testing ${specs.length} selected spec files against verified packed Lua at ${pin.revision}`);
    execFileSync('docker', args, {stdio:'inherit', windowsHide:true, timeout:300000});
  } finally { await rm(scratch, {recursive:true, force:true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
