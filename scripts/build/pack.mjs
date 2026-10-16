import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateSourceLedger, validatePreparedRelevance } from './source-ledger.mjs';
import { buildLuaRunner, generateSupplement, generatorInputs, verifyPackedSupplement } from './mod-cache/supplement.mjs';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtimeDir = join(appDir, '.runtime');
const payloadDir = join(runtimeDir, 'payload');
const { pinBytes, pin, overlayBytes, compositeBytes: patch } = await validateSourceLedger(appDir);
const sourceDir = join(runtimeDir, `source-${pin.compositePatch.patchSha256.slice(0, 12)}`);
const patchFile = join(appDir, pin.compositePatch.patchFile);
const run = (command, args, cwd = appDir) => {
  const commandArgs = command === 'git' ? ['-c', `safe.directory=${cwd}`, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed:\n${result.error?.message ?? ''}${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout.trim();
};
const succeeds = (command, args, cwd = appDir) => {
  const commandArgs = command === 'git' ? ['-c', `safe.directory=${cwd}`, '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args] : args;
  return spawnSync(command, commandArgs, { cwd, stdio: 'ignore', windowsHide: true }).status === 0;
};
const exists = async (path) => access(path).then(() => true, () => false);

await mkdir(runtimeDir, { recursive: true });
if (!(await exists(join(sourceDir, '.git')))) {
  await mkdir(sourceDir, { recursive: true });
  run('git', ['init', sourceDir]);
}
if (!succeeds('git', ['remote', 'get-url', 'origin'], sourceDir)) {
  run('git', ['remote', 'add', 'origin', pin.repository], sourceDir);
}
if (!succeeds('git', ['rev-parse', '--verify', 'HEAD'], sourceDir)) {
  run('git', ['-c', 'core.autocrlf=false', 'fetch', '--depth=1', 'origin', pin.revision], sourceDir);
  run('git', ['-c', 'core.autocrlf=false', 'checkout', '--detach', 'FETCH_HEAD'], sourceDir);
}
const actualRevision = run('git', ['rev-parse', 'HEAD'], sourceDir);
if (actualRevision !== pin.revision) throw new Error(`Local source is ${actualRevision}; expected ${pin.revision}. Preserve any edits and move .runtime/source aside before preparing a changed pin.`);
const status = run('git', ['status', '--porcelain', '--untracked-files=all'], sourceDir);
if (!status) {
  run('git', ['apply', '--check', patchFile], sourceDir);
  run('git', ['apply', patchFile], sourceDir);
} else {
  // A previous preparation may have applied the patch. Require every change to
  // exactly match it, rather than silently packing unrelated local modifications.
  run('git', ['apply', '--reverse', '--check', patchFile], sourceDir);
}
// Compare the patched tree to the exact PR blob hashes (git's index is separate
// from the maintainer's source index) and reject additional changes/untracked files.
const changed = [
  ...run('git', ['diff', 'HEAD', '--name-only'], sourceDir).split(/\r?\n/),
  ...run('git', ['ls-files', '--others', '--exclude-standard'], sourceDir).split(/\r?\n/),
].filter(Boolean).sort();
const expected = [...pin.compositePatch.files].sort();
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  throw new Error('Local source changes differ from the pinned PR composite. Preserve edits and move the versioned .runtime source aside.');
}
for (const [path, hash] of Object.entries(pin.compositePatch.resultBlobHashes)) {
  if (run('git', ['hash-object', '--no-filters', path], sourceDir) !== hash) throw new Error(`Patched source differs from the pinned PR composite: ${path}`);
}
await validatePreparedRelevance(appDir, sourceDir, pin);
for (const [adapter, compatibility] of Object.entries(pin.adapters)) {
  // Chained pack-time overlays verify their untouched checkout separately from
  // the previous overlay's in-memory result, which their own adapter checks.
  for (const [path, hash] of Object.entries(compatibility.preparedSourceBlobHashes ?? compatibility.sourceBlobHashes ?? compatibility.resultBlobHashes)) {
    if (run('git', ['hash-object', '--no-filters', path], sourceDir) !== hash) throw new Error(`${adapter} source compatibility changed: ${path}`);
  }
}
const modCacheSupplement = pin.generated.masteryModCacheSupplement;
for (const [path, hash] of Object.entries(modCacheSupplement.sourceBlobHashes)) {
  if (run('git', ['hash-object', '--no-filters', path], sourceDir) !== hash) throw new Error(`Mastery ModCache supplement source changed: ${path}`);
}

const inputHash = sha256(Buffer.concat([
  pinBytes,
  patch,
  ...overlayBytes,
  await readFile(fileURLToPath(import.meta.url)),
  await readFile(join(appDir, 'upstream/packages/packer/src/pack.ts')),
  await readFile(join(appDir, 'upstream/packages/packer/src/packages.ts')),
  await readFile(join(appDir, 'upstream/packages/packer/src/calculation-adapter.ts')),
  await readFile(join(appDir, 'upstream/packages/packer/src/timeless-adapter.ts')),
  await readFile(join(appDir, 'upstream/packages/packer/src/ui-defaults-adapter.ts')),
  await readFile(join(appDir, 'upstream/packages/packer/src/timeless-seeds.lua')),
  await readFile(join(appDir, 'upstream/packages/packer/src/timeless-inflate.lua')),
  await readFile(join(appDir, 'scripts/patches/gem-hover-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/item-comparison-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/jewel-spec-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/importtab-host-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/preferred-export-site-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/unique-sort-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/node-power-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/status-text-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/build-list-pending-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/power-node-depth-patch.mjs')),
  await readFile(join(appDir, 'scripts/patches/mod-cache-supplement-patch.mjs')),
  Buffer.from((await generatorInputs()).sha256),
  await readFile(join(appDir, 'scripts/build/drift-patch.mjs')),
  await readFile(join(appDir, pin.adapters.uniqueSortDelegation.patchFile)),
  await readFile(join(appDir, pin.adapters.gemDropdownHover.patchFile)),
  await readFile(join(appDir, pin.adapters.limitedUniqueItemComparisons.patchFile)),
  await readFile(join(appDir, pin.adapters.calculationOnlyJewelSpecs.patchFile)),
  await readFile(join(appDir, pin.adapters.importTabHostCapabilities.patchFile)),
  await readFile(join(appDir, pin.adapters.preferredExportSite.patchFile)),
  await readFile(join(appDir, pin.adapters.buildListPendingFolders.patchFile)),
  await readFile(join(appDir, pin.adapters.powerNodeDepthDefault.patchFile)),
  await readFile(join(appDir, 'upstream/payload-manifest.ts')),
  await readFile(join(appDir, 'upstream/deno.json')),
  await readFile(join(appDir, 'upstream/deno.lock')),
]));
const provenanceFile = join(payloadDir, 'provenance.json');
if (await exists(provenanceFile)) {
  const previous = JSON.parse(await readFile(provenanceFile, 'utf8'));
  const packagesValid = previous.packages && await exists(join(payloadDir, 'manifest.json')) &&
    previous.manifestSha256 === sha256(await readFile(join(payloadDir, 'manifest.json'))) &&
    (await Promise.all(previous.packages.map(async hash => /^[a-f0-9]{64}$/.test(hash) &&
      await exists(join(payloadDir, 'packages', `${hash}.zip`)) && hash === sha256(await readFile(join(payloadDir, 'packages', `${hash}.zip`)))))).every(Boolean);
  if (packagesValid && previous.inputSha256 === inputHash && await exists(join(payloadDir, 'root')) && await exists(join(payloadDir, 'root.zip')) && previous.rootZipSha256 === sha256(await readFile(join(payloadDir, 'root.zip')))) {
    console.log(`Pinned full PoB payload ready: ${payloadDir}`);
    process.exit(0);
  }
}
await mkdir(payloadDir, { recursive: true });
const packer = (destination, option) => {
  const packed = spawnSync(process.env.DENO ?? 'deno', ['run', '--allow-read', `--allow-write=${resolve(destination)}`, '--allow-env',
    'packages/packer/src/pack.ts', sourceDir, destination, option], { cwd: join(appDir, 'upstream'), stdio: 'inherit' });
  if (packed.error || packed.status !== 0) throw new Error(packed.error?.message ?? `PoB packer exited ${packed.status}`);
};
// Generate the mastery-option ModCache supplement from the exact adapted
// sources that are packed, then prove the packed payload against PoB's parser.
const modCacheDir = join(runtimeDir, 'mod-cache-supplement');
await rm(modCacheDir, { recursive: true, force: true });
await mkdir(modCacheDir, { recursive: true });
console.log(`Generating the ${modCacheSupplement.treeVersion} mastery-option ModCache supplement…`);
packer(join(modCacheDir, 'stage'), '--stage');
const runnerDir = await buildLuaRunner(runtimeDir);
const generated = await generateSupplement({ runnerDir, stageRoot: join(modCacheDir, 'stage', 'root'),
  workDir: join(modCacheDir, 'generate'), ledger: modCacheSupplement });
const supplementFile = join(modCacheDir, 'supplement.lua');
await writeFile(supplementFile, generated.supplement);
await rm(join(modCacheDir, 'stage'), { recursive: true, force: true });
console.log(`Packing full desktop PoB beta ${pin.revision} with PRs ${pin.overlays.filter(overlay => overlay.kind === 'upstream-pr').map(overlay => `#${overlay.number}`).join(', ')}…`);
packer(payloadDir, `--mod-cache-supplement=${supplementFile}`);
const verified = await verifyPackedSupplement({ runnerDir, payloadDir, shippedModCache: join(sourceDir, 'src/Data/ModCache.lua'),
  workDir: join(modCacheDir, 'verify'), ledger: modCacheSupplement });
await rm(modCacheDir, { recursive: true, force: true });
console.log(`Verified ${verified.entries} mastery-option ModCache entries against PoB's on-demand parser.`);
await writeFile(provenanceFile, `${JSON.stringify({
  schema: 2,
  sourceRevision: pin.revision,
  adapters: pin.adapters,
  overlays: pin.overlays,
  compositePatch: {
    baseRevision: pin.compositePatch.baseRevision,
    resultTree: pin.compositePatch.resultTree,
    patchSha256: pin.compositePatch.patchSha256,
  },
  generated: {
    masteryModCacheSupplement: {
      ...modCacheSupplement,
      requested: generated.report.requested,
      missing: generated.report.missing,
      supplementSha256: generated.report.supplementSha256,
      verifiedEntries: verified.entries,
    },
  },
  inputSha256: inputHash,
  manifestSha256: sha256(await readFile(join(payloadDir, 'manifest.json'))),
  packages: JSON.parse(await readFile(join(payloadDir, 'manifest.json'), 'utf8')).packages.map(p => p.sha256),
  rootZipSha256: sha256(await readFile(join(payloadDir, 'root.zip'))),
}, null, 2)}\n`);
console.log(`Pinned full PoB payload ready: ${payloadDir}`);
