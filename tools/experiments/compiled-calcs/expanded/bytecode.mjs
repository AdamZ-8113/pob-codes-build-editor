// Experiment-only exact-VM Lua bytecode package overlay.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../../upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const generatorUrl = new URL('./bytecode-generator.lua', import.meta.url);
const moduleUrl = new URL(import.meta.url);
const defaultCompilerImage = 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef';
const compileFlags = Object.freeze([
  '-DLUA_NANTRICK', '-DLUA_IEEEENDIAN=0', '-O3', '-flto', '-g', '-sNODERAWFS',
  '-sALLOW_MEMORY_GROWTH', '-sMALLOC=mimalloc', '-sSTACK_SIZE=1MB', '-sENVIRONMENT=node',
]);
const expectedLua52WasmHeader = Buffer.from([
  0x1b, 0x4c, 0x75, 0x61, 0x52, 0x00, 0x01, 0x04, 0x04, 0x04, 0x08, 0x00, 0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function buildBytecodeOverlay({
  repoRoot,
  manifest: originalManifest,
  packages: originalPackages,
  compilerImage = defaultCompilerImage,
  packageIds,
}) {
  assert.equal(typeof repoRoot, 'string', 'repoRoot is required');
  assert.ok(originalManifest && Array.isArray(originalManifest.packages), 'Payload manifest is required');
  assert.ok(originalPackages instanceof Map, 'packages must be a Map keyed by package sha256');
  assert.match(compilerImage, /^emscripten\/emsdk:[^@]+@sha256:[a-f0-9]{64}$/, 'Pinned compiler image required');

  const root = resolve(repoRoot);
  const manifest = structuredClone(originalManifest);
  const selectedIds = packageIds ?? manifest.packages.filter(entry => entry.startup).map(entry => entry.id);
  assert.ok(Array.isArray(selectedIds) && selectedIds.length > 0, 'At least one package must be selected');
  assert.equal(new Set(selectedIds).size, selectedIds.length, 'Duplicate package id');
  const selected = selectedIds.map(id => {
    const entry = manifest.packages.find(pkg => pkg.id === id);
    assert.ok(entry, `Unknown payload package ${id}`);
    assert.ok(originalPackages.has(entry.sha256), `Missing bytes for payload package ${id}`);
    return entry;
  });

  const scratch = await mkdtemp(join(tmpdir(), 'pob-bytecode-overlay-'));
  try {
    await assertOwnedScratch(scratch, 'pob-bytecode-overlay-');
    const files = [];
    const owners = new Map();
    const archives = new Map();
    for (const pkg of selected) {
      const archive = Buffer.from(originalPackages.get(pkg.sha256));
      assert.equal(sha256(archive), pkg.sha256, `Package identity mismatch for ${pkg.id}`);
      const zip = new AdmZip(archive);
      archives.set(pkg.id, zip);
      for (const file of pkg.files.filter(file => file.path.endsWith('.lua'))) {
        assertSafePayloadPath(file.path);
        assert.ok(!owners.has(file.path), `Selected packages overlap at ${file.path}`);
        const entry = zip.getEntry(file.path);
        assert.ok(entry && !entry.isDirectory, `Missing ${file.path} in ${pkg.id}`);
        const source = entry.getData();
        assert.equal(source.byteLength, file.bytes, `Manifest byte mismatch for ${file.path}`);
        owners.set(file.path, { pkg, file, source });
        files.push(file.path);
        await mkdir(dirname(join(scratch, 'root', file.path)), { recursive: true });
        await mkdir(dirname(join(scratch, 'bytecode', file.path)), { recursive: true });
        await writeFile(join(scratch, 'root', file.path), source);
      }
    }
    files.sort();
    assert.ok(files.length > 0, 'Selected packages contain no Lua files');
    await writeFile(join(scratch, 'lua-files.txt'), `${files.join('\n')}\n`);

    const luaSources = (await readdir(join(root, 'upstream', 'vendor', 'lua')))
      .filter(path => path.endsWith('.c') && path !== 'lua.c')
      .sort()
      .map(path => `vendor/lua/${path}`);
    const vmInventoryPaths = [
      ...(await readdir(join(root, 'upstream', 'vendor', 'lua')))
        .filter(path => /\.[ch]$/.test(path) && path !== 'lua.c')
        .map(path => join(root, 'upstream', 'vendor', 'lua', path)),
      fileURLToPath(new URL('./bytecode-runtime.c', import.meta.url)),
    ];
    const vmInventory = await inventoryHash(root, vmInventoryPaths);
    const driverCmakeSha256 = sha256(await readFile(join(root, 'upstream', 'packages', 'driver', 'CMakeLists.txt')));
    runDocker(root, scratch, compilerImage, [
      'emcc', ...luaSources, '/app/tools/experiments/compiled-calcs/expanded/bytecode-runtime.c', '-Ivendor/lua',
      ...compileFlags, '-o', '/probe/run.js',
    ]);
    runDocker(root, scratch, compilerImage, [
      'node', '/probe/run.js', '/probe/root', '/app/tools/experiments/compiled-calcs/expanded/bytecode-generator.lua',
    ]);

    const generatedHeader = await readFile(join(scratch, 'bytecode-header.bin'));
    assert.deepEqual(generatedHeader, expectedLua52WasmHeader, 'Generator VM is not the expected Lua 5.2 wasm32 ABI');

    const records = parseResults(await readFile(join(scratch, 'bytecode-results.tsv'), 'utf8'));
    assert.equal(records.size, files.length, 'Generator result count mismatch');
    let sourceBytes = 0;
    let bytecodeBytes = 0;
    let compiledFiles = 0;
    const fallbacks = [];
    for (const path of files) {
      const owner = owners.get(path);
      const record = records.get(path);
      assert.ok(record, `Missing generator result for ${path}`);
      assert.equal(record.sourceBytes, owner.source.byteLength, `Generator source size mismatch for ${path}`);
      const output = await readFile(join(scratch, 'bytecode', path));
      assert.equal(output.byteLength, record.outputBytes, `Generator output size mismatch for ${path}`);
      if (record.kind === 'bytecode') {
        assert.deepEqual(output.subarray(0, generatedHeader.byteLength), generatedHeader, `Invalid bytecode ABI header for ${path}`);
        compiledFiles++;
      } else {
        assert.deepEqual(output, owner.source, `Fallback source changed for ${path}`);
        fallbacks.push(path);
      }
      sourceBytes += owner.source.byteLength;
      bytecodeBytes += output.byteLength;
      archives.get(owner.pkg.id).updateFile(path, output);
      owner.pkg.uncompressedBytes += output.byteLength - owner.file.bytes;
      owner.file.bytes = output.byteLength;
    }

    const packages = new Map(originalPackages);
    const packageIdentities = [];
    let sourceArchiveBytes = 0;
    let overlayArchiveBytes = 0;
    for (const pkg of selected) {
      const originalSha256 = originalManifest.packages.find(entry => entry.id === pkg.id).sha256;
      const originalBytes = Buffer.from(originalPackages.get(originalSha256));
      const overlayBytes = archives.get(pkg.id).toBuffer();
      const overlaySha256 = sha256(overlayBytes);
      packages.delete(originalSha256);
      packages.set(overlaySha256, overlayBytes);
      pkg.sha256 = overlaySha256;
      pkg.bytes = overlayBytes.byteLength;
      sourceArchiveBytes += originalBytes.byteLength;
      overlayArchiveBytes += overlayBytes.byteLength;
      packageIdentities.push({ id: pkg.id, sourceSha256: originalSha256, overlaySha256 });
    }

    const [generatorSource, moduleSource] = await Promise.all([readFile(generatorUrl), readFile(moduleUrl)]);
    const identities = {
      compilerImage,
      compileFlags: [...compileFlags],
      vmInventory,
      driverCmakeSha256,
      luaBytecodeHeaderHex: generatedHeader.toString('hex'),
      sourceManifestSha256: sha256(Buffer.from(JSON.stringify(originalManifest))),
      overlayManifestSha256: sha256(Buffer.from(JSON.stringify(manifest))),
      generatorSha256: sha256(generatorSource),
      moduleSha256: sha256(moduleSource),
      packages: packageIdentities,
    };
    const stats = {
      selectedPackageIds: [...selectedIds],
      selectedLuaFiles: files.length,
      compiledFiles,
      fallbackFiles: fallbacks.length,
      fallbacks,
      sourceBytes,
      overlayLuaBytes: bytecodeBytes,
      sourceArchiveBytes,
      overlayArchiveBytes,
    };
    return { manifest, packages, identities, stats };
  } finally {
    await assertOwnedScratch(scratch, 'pob-bytecode-overlay-');
    await rm(scratch, { recursive: true, force: true });
  }
}

function runDocker(repoRoot, scratch, image, command) {
  const result = spawnSync('docker', [
    'run', '--rm', '--network=none',
    '--mount', `type=bind,source=${repoRoot},target=/app,readonly`,
    '--mount', `type=bind,source=${scratch},target=/probe`,
    '--workdir', '/app/upstream', image, ...command,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Bytecode generator failed (${command[0]}): ${result.error?.message ?? ''}${result.stderr}\n${result.stdout}`);
  }
}

function assertSafePayloadPath(path) {
  assert.equal(typeof path, 'string');
  assert.ok(path && !path.startsWith('/') && !path.includes('\\'), `Unsafe payload path ${path}`);
  assert.ok(!path.split('/').some(segment => segment === '' || segment === '..' || segment === '.'), `Unsafe payload path ${path}`);
}

function parseResults(text) {
  const records = new Map();
  for (const line of text.trimEnd().split('\n')) {
    const [kind, path, sourceBytesText, outputBytesText, ...extra] = line.replace(/\r$/, '').split('\t');
    assert.ok(!extra.length && ['bytecode', 'fallback'].includes(kind), 'Invalid generator result');
    assertSafePayloadPath(path);
    const sourceBytes = Number(sourceBytesText);
    const outputBytes = Number(outputBytesText);
    assert.ok(Number.isSafeInteger(sourceBytes) && sourceBytes >= 0, 'Invalid source byte count');
    assert.ok(Number.isSafeInteger(outputBytes) && outputBytes >= 0, 'Invalid output byte count');
    assert.ok(!records.has(path), `Duplicate generator result for ${path}`);
    records.set(path, { kind, sourceBytes, outputBytes });
  }
  return records;
}

async function inventoryHash(root, paths) {
  const entries = [];
  for (const path of [...paths].sort()) {
    const absolute = resolve(path);
    assert.ok(absolute.startsWith(`${root}${sep}`), 'VM inventory escaped repository root');
    const stat = await lstat(absolute);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `VM inventory input must be a regular file: ${absolute}`);
    assert.equal(resolve(await realpath(absolute)), absolute, `VM inventory input traverses a reparse point: ${absolute}`);
    entries.push([relative(root, absolute).replaceAll('\\', '/'), sha256(await readFile(absolute))]);
  }
  return { fileCount: entries.length, sha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

async function assertOwnedScratch(path, prefix) {
  const absolute = resolve(path);
  const parent = resolve(absolute, '..');
  assert.equal(parent, resolve(tmpdir()), 'Scratch must be an immediate OS temp child');
  assert.ok(basename(absolute).startsWith(prefix), 'Scratch prefix mismatch');
  assert.equal(resolve(await realpath(absolute)), absolute, 'Scratch path must not traverse a reparse point');
  assert.equal((await lstat(absolute)).isSymbolicLink(), false, 'Scratch root must not be a link');
  async function checkChildren(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = resolve(directory, entry.name);
      assert.ok(child.startsWith(`${absolute}${sep}`), 'Scratch descendant escaped its owner');
      assert.equal((await lstat(child)).isSymbolicLink(), false, 'Scratch cleanup refuses nested links');
      assert.equal(resolve(await realpath(child)), child, 'Scratch cleanup refuses nested reparse traversal');
      if (entry.isDirectory()) await checkChildren(child);
    }
  }
  await checkChildren(absolute);
}

export const bytecodeExperiment = Object.freeze({
  id: 'exact-wasm32-lua-bytecode-overlay',
  compilerImage: defaultCompilerImage,
  compileFlags: [...compileFlags],
});
