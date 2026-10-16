// Pack-time mastery-option ModCache supplement. supplement.lua runs in the
// browser's vendored Lua interpreter, compiled for Node by the pinned
// Emscripten image without network access; nothing here is shipped.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must equal scripts/build/build-runtime.mjs, which compiles the browser driver.
export const EMSDK_IMAGE = 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef';
// Mirrors the driver's default POB_COMPACT_VALUES definitions.
const COMPILE_FLAGS = ['-O3', '-DLUA_NANTRICK', '-DLUA_IEEEENDIAN=0', '-sNODERAWFS', '-sENVIRONMENT=node',
  '-sALLOW_MEMORY_GROWTH', '-sSTACK_SIZE=1MB', '-sEXIT_RUNTIME=1'];
const generatorDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(generatorDir, '../../..');
const vendorDir = join(appDir, 'upstream/vendor');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = (path) => access(path).then(() => true, () => false);

function docker(args) {
  const result = spawnSync('docker', ['run', '--rm', '--network=none', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw new Error('Docker is required to generate the ModCache supplement. Start Docker and retry.', { cause: result.error });
  if (result.status !== 0) throw new Error(`ModCache supplement container failed (${result.status}):\n${result.stderr}\n${result.stdout.slice(-4000)}`);
  return result.stdout;
}

async function luaSources() {
  return (await readdir(join(vendorDir, 'lua'))).filter((name) => name.endsWith('.c') && name !== 'lua.c').sort();
}

/** Files and settings that determine the runner and generator behavior. */
export async function generatorInputs() {
  const files = [
    ...(await readdir(join(vendorDir, 'lua'))).sort().map((name) => `upstream/vendor/lua/${name}`),
    'upstream/vendor/luautf8/lutf8lib.c',
    'scripts/build/mod-cache/lua-runner.c',
    'scripts/build/mod-cache/supplement.lua',
    'scripts/build/mod-cache/supplement.mjs',
  ];
  const hash = createHash('sha256').update(`${EMSDK_IMAGE}\0${COMPILE_FLAGS.join(' ')}\0`);
  for (const file of files) hash.update(`${file}\0`).update(await readFile(join(appDir, file))).update('\0');
  return { files, sha256: hash.digest('hex') };
}

/** Compiles lua-runner.c with the vendored interpreter, reusing an identical build. */
export async function buildLuaRunner(runtimeDir) {
  const runnerHash = createHash('sha256').update(`${EMSDK_IMAGE}\0${COMPILE_FLAGS.join(' ')}\0`);
  for (const file of [...(await readdir(join(vendorDir, 'lua'))).sort().map((name) => join(vendorDir, 'lua', name)),
    join(vendorDir, 'luautf8/lutf8lib.c'), join(generatorDir, 'lua-runner.c')]) {
    runnerHash.update(await readFile(file)).update('\0');
  }
  const runnerDir = join(runtimeDir, `mod-cache-runner-${runnerHash.digest('hex').slice(0, 12)}`);
  if (await exists(join(runnerDir, 'lua-runner.js')) && await exists(join(runnerDir, 'lua-runner.wasm'))) return runnerDir;
  const pending = `${runnerDir}.next`;
  await rm(pending, { recursive: true, force: true });
  await mkdir(pending, { recursive: true });
  docker(['--mount', `type=bind,source=${vendorDir},target=/vendor,readonly`,
    '--mount', `type=bind,source=${generatorDir},target=/generator,readonly`,
    '--mount', `type=bind,source=${pending},target=/out`, '--workdir', '/vendor', EMSDK_IMAGE,
    'emcc', ...(await luaSources()).map((name) => `lua/${name}`), 'luautf8/lutf8lib.c', '/generator/lua-runner.c',
    '-Ilua', ...COMPILE_FLAGS, '-o', '/out/lua-runner.js']);
  await rm(runnerDir, { recursive: true, force: true });
  await rename(pending, runnerDir);
  return runnerDir;
}

function runSupplement({ runnerDir, rootDir, workDir, mounts = [], args }) {
  return docker(['--mount', `type=bind,source=${rootDir},target=/pob,readonly`,
    '--mount', `type=bind,source=${runnerDir},target=/runner,readonly`,
    '--mount', `type=bind,source=${generatorDir},target=/generator,readonly`,
    '--mount', `type=bind,source=${workDir},target=/work`, ...mounts, '--workdir', '/work', EMSDK_IMAGE,
    'node', '/runner/lua-runner.js', '/pob', '/generator/supplement.lua', ...args]);
}

/**
 * Generates the supplement from staged (adapted, unsupplemented) PoB sources.
 * Returns the PoB SaveModCache module text and the generator report.
 */
export async function generateSupplement({ runnerDir, stageRoot, workDir, ledger }) {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(join(workDir, 'user'), { recursive: true });
  runSupplement({ runnerDir, rootDir: stageRoot, workDir,
    args: ['generate', ledger.treeVersion, '/work/user', '/work/supplement.lua', '/work/report.json'] });
  const report = JSON.parse(await readFile(join(workDir, 'report.json'), 'utf8'));
  const supplement = await readFile(join(workDir, 'supplement.lua'));
  const excluded = report.excluded.map(({ key, reason }) => ({ key, reason }));
  if (report.entries !== ledger.entries || JSON.stringify(excluded) !== JSON.stringify(ledger.excluded)) {
    throw new Error(`Mastery ModCache supplement inventory changed: ${report.entries} entries, excluded ${JSON.stringify(excluded)}; ` +
      `review ${join(workDir, 'supplement.lua')} and record it in source-pin.json`);
  }
  return { supplement, report: { ...report, supplementSha256: sha256(supplement) } };
}

function safeEntryPath(name) {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Unexpected payload package path');
  }
  return name;
}

/** Writes every manifest-owned package file, after checking each package hash. */
export async function extractPayload(payloadDir, target) {
  const require = createRequire(join(appDir, 'upstream/deno.json'));
  const AdmZip = require('adm-zip');
  const manifest = JSON.parse(await readFile(join(payloadDir, 'manifest.json'), 'utf8'));
  const root = resolve(target);
  for (const pkg of manifest.packages) {
    const bytes = await readFile(join(payloadDir, 'packages', `${pkg.sha256}.zip`));
    if (sha256(bytes) !== pkg.sha256) throw new Error(`Payload package ${pkg.id} hash mismatch`);
    for (const entry of new AdmZip(bytes).getEntries()) {
      if (entry.isDirectory) continue;
      const path = resolve(root, safeEntryPath(entry.entryName));
      if (!path.startsWith(root + sep)) throw new Error('Unexpected payload package path');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.getData());
    }
  }
}

/**
 * Proves the packed payload's ModCache keeps every shipped entry, that each
 * added entry equals PoB's on-demand parse in the browser interpreter, and that
 * the latest tree's mastery options miss only the ledgered exclusions.
 */
export async function verifyPackedSupplement({ runnerDir, payloadDir, shippedModCache, workDir, ledger }) {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(join(workDir, 'run', 'user'), { recursive: true });
  const rootDir = join(workDir, 'payload');
  await extractPayload(payloadDir, rootDir);
  runSupplement({ runnerDir, rootDir, workDir: join(workDir, 'run'),
    mounts: ['--mount', `type=bind,source=${resolve(shippedModCache)},target=/shipped/ModCache.lua,readonly`],
    args: ['verify', ledger.treeVersion, '/work/user', '/shipped/ModCache.lua', '/work/report.json'] });
  const report = JSON.parse(await readFile(join(workDir, 'run', 'report.json'), 'utf8'));
  const misses = report.misses.map(({ key }) => key);
  if (report.entries !== ledger.entries || JSON.stringify(misses) !== JSON.stringify(ledger.excluded.map(({ key }) => key))) {
    throw new Error(`Packed ModCache supplement verification failed: ${report.entries} entries, misses ${JSON.stringify(misses)}`);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Standalone proof for an existing payload: node scripts/build/mod-cache/supplement.mjs [payload-dir]
  const { validateSourceLedger } = await import('../source-ledger.mjs');
  const { pin } = await validateSourceLedger(appDir);
  const runtimeDir = join(appDir, '.runtime');
  const payloadDir = resolve(process.argv[2] ?? join(runtimeDir, 'payload'));
  const sourceDir = join(runtimeDir, `source-${pin.compositePatch.patchSha256.slice(0, 12)}`);
  const ledger = pin.generated.masteryModCacheSupplement;
  const workDir = join(runtimeDir, 'mod-cache-verify');
  try {
    const report = await verifyPackedSupplement({ runnerDir: await buildLuaRunner(runtimeDir), payloadDir,
      shippedModCache: join(sourceDir, 'src/Data/ModCache.lua'), workDir, ledger });
    console.log(JSON.stringify(report));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
