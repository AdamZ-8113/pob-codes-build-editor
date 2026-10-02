import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateSourceLedger } from './source-ledger.mjs';

const appDir = dirname(fileURLToPath(import.meta.url));
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
for (const [adapter, compatibility] of Object.entries(pin.adapters)) {
  // Chained pack-time overlays verify their untouched checkout separately from
  // the previous overlay's in-memory result, which their own adapter checks.
  for (const [path, hash] of Object.entries(compatibility.preparedSourceBlobHashes ?? compatibility.sourceBlobHashes ?? compatibility.resultBlobHashes)) {
    if (run('git', ['hash-object', '--no-filters', path], sourceDir) !== hash) throw new Error(`${adapter} source compatibility changed: ${path}`);
  }
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
  await readFile(join(appDir, 'upstream/packages/packer/src/abyss-records.mjs')),
  await readFile(join(appDir, 'upstream/packages/packer/src/abyss-records.lua')),
  await readFile(join(appDir, 'upstream/abyss-lookup-format.js')),
  await readFile(join(appDir, 'upstream/packages/packer/src/timeless-seeds.lua')),
  await readFile(join(appDir, 'upstream/packages/packer/src/timeless-inflate.lua')),
  await readFile(join(appDir, 'gem-hover-patch.mjs')),
  await readFile(join(appDir, 'item-comparison-patch.mjs')),
  await readFile(join(appDir, 'jewel-spec-patch.mjs')),
  await readFile(join(appDir, 'importtab-host-patch.mjs')),
  await readFile(join(appDir, 'unique-sort-patch.mjs')),
  await readFile(join(appDir, pin.adapters.uniqueSortDelegation.patchFile)),
  await readFile(join(appDir, pin.adapters.gemDropdownHover.patchFile)),
  await readFile(join(appDir, pin.adapters.limitedUniqueItemComparisons.patchFile)),
  await readFile(join(appDir, pin.adapters.calculationOnlyJewelSpecs.patchFile)),
  await readFile(join(appDir, pin.adapters.importTabHostCapabilities.patchFile)),
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
console.log(`Packing full desktop PoB beta ${pin.revision} with PRs ${pin.overlays.filter(overlay => overlay.kind === 'upstream-pr').map(overlay => `#${overlay.number}`).join(', ')}…`);
const packed = spawnSync(process.env.DENO ?? 'deno', ['run', '--allow-read', `--allow-write=${resolve(payloadDir)}`, '--allow-env', 'packages/packer/src/pack.ts', sourceDir, payloadDir], {
  cwd: join(appDir, 'upstream'), stdio: 'inherit',
});
if (packed.error || packed.status !== 0) throw new Error(packed.error?.message ?? `PoB packer exited ${packed.status}`);
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
  inputSha256: inputHash,
  manifestSha256: sha256(await readFile(join(payloadDir, 'manifest.json'))),
  packages: JSON.parse(await readFile(join(payloadDir, 'manifest.json'), 'utf8')).packages.map(p => p.sha256),
  rootZipSha256: sha256(await readFile(join(payloadDir, 'root.zip'))),
}, null, 2)}\n`);
console.log(`Pinned full PoB payload ready: ${payloadDir}`);
