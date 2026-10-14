// Exact-VM semantic validation for larger direct luaL_loadfilex buffers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBinaryReopen, applyLoadfBuffer, applyStdioBuffer } from './loadf-buffer.mjs';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const compilerImage = 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef';
const compileFlags = Object.freeze([
  '-DLUA_NANTRICK', '-DLUA_IEEEENDIAN=0', '-O3', '-flto', '-g', '-sNODERAWFS',
  '-sALLOW_MEMORY_GROWTH', '-sMALLOC=mimalloc', '-sSTACK_SIZE=1MB', '-sENVIRONMENT=node',
]);
const variants = Object.freeze([
  { id: 'baseline', transform: source => source, loadBufferBytes: 'LUAL_BUFFERSIZE', binaryReopen: false },
  { id: 'direct-64kib', transform: source => applyLoadfBuffer(source, 64 * 1024), loadBufferBytes: 64 * 1024, binaryReopen: false },
  { id: 'direct-256kib', transform: source => applyLoadfBuffer(source, 256 * 1024), loadBufferBytes: 256 * 1024, binaryReopen: false },
  { id: 'binary-reopen', transform: applyBinaryReopen, loadBufferBytes: 'LUAL_BUFFERSIZE', binaryReopen: true },
  { id: 'direct-256kib-binary-reopen', transform: source => applyLoadfBuffer(source, 256 * 1024, { binaryReopen: true }), loadBufferBytes: 256 * 1024, binaryReopen: true },
  { id: 'stdio-64kib', transform: source => applyStdioBuffer(source, 64 * 1024), loadBufferBytes: 'LUAL_BUFFERSIZE', stdioBufferBytes: 64 * 1024, binaryReopen: true },
  { id: 'stdio-256kib', transform: source => applyStdioBuffer(source, 256 * 1024), loadBufferBytes: 'LUAL_BUFFERSIZE', stdioBufferBytes: 256 * 1024, binaryReopen: true },
]);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const stamp = new Date().toISOString().replaceAll(/[:.]/g, '');
const allowedEvidenceRoot = resolve(root, 'tmp/compiled-calcs-expanded');
const evidenceDirectory = resolve(root, option('output') ?? `tmp/compiled-calcs-expanded/2026-10-11/${stamp}-loadf-reopen-validation`);
assert.ok(evidenceDirectory.startsWith(`${allowedEvidenceRoot}${sep}`), '--output must stay under tmp/compiled-calcs-expanded');
const existingEvidence = await readdir(evidenceDirectory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
assert.equal(existingEvidence.length, 0, '--output must not overwrite an existing nonempty evidence directory');
const scratch = await mkdtemp(join(tmpdir(), 'pob-loadf-validate-'));

try {
  await assertOwnedScratch(scratch, 'pob-loadf-validate-');
  await Promise.all([mkdir(join(scratch, 'root'), { recursive: true }), mkdir(join(scratch, 'build'), { recursive: true })]);
  await prepareFixtures(join(scratch, 'root'));
  const originalLauxlib = await readFile(resolve(root, 'upstream/vendor/lua/lauxlib.c'), 'utf8');
  const variantSources = new Map();
  for (const variant of variants) {
    const source = variant.transform(originalLauxlib);
    variantSources.set(variant.id, source);
    if (variant.id !== 'baseline') await writeFile(join(scratch, `lauxlib-${variant.id}.c`), source);
  }

  const luaSources = (await readdir(resolve(root, 'upstream/vendor/lua')))
    .filter(path => path.endsWith('.c') && !['lua.c', 'lauxlib.c'].includes(path)).sort().map(path => `vendor/lua/${path}`);
  const builds = [];
  for (const variant of variants) {
    const lauxlib = variant.id === 'baseline' ? 'vendor/lua/lauxlib.c' : `/probe/lauxlib-${variant.id}.c`;
    runDocker(['emcc', ...luaSources, lauxlib,
      '/app/tools/experiments/compiled-calcs/expanded/bytecode-runtime.c', '-Ivendor/lua',
      ...compileFlags, '-o', `/probe/build/${variant.id}.js`]);
    builds.push({
      id: variant.id,
      loadBufferBytes: variant.loadBufferBytes,
      stdioBufferBytes: variant.stdioBufferBytes,
      binaryReopen: variant.binaryReopen,
      lauxlibSha256: sha256(variantSources.get(variant.id)),
      jsSha256: sha256(await readFile(join(scratch, 'build', `${variant.id}.js`))),
      wasmSha256: sha256(await readFile(join(scratch, 'build', `${variant.id}.wasm`))),
    });
  }

  const executions = [];
  for (const variant of variants) {
    for (const probeCase of ['suite', 'nested', 'deep', 'parser', 'stdin']) {
      const result = execute(variant.id, probeCase);
      executions.push({ variant: variant.id, case: probeCase, ...result });
    }
  }
  const baseline = new Map(executions.filter(result => result.variant === 'baseline').map(result => [result.case, result]));
  for (const result of executions) {
    const reference = baseline.get(result.case);
    result.matchesBaseline = result.status === reference.status && result.stdoutSha256 === reference.stdoutSha256;
  }
  const passed = executions.every(result => result.status === 0 && result.matchesBaseline);
  const vmInventory = await inventoryHash([
    ...(await readdir(resolve(root, 'upstream/vendor/lua'))).filter(path => /\.[ch]$/.test(path) && path !== 'lua.c')
      .map(path => resolve(root, 'upstream/vendor/lua', path)),
    resolve(root, 'tools/experiments/compiled-calcs/expanded/bytecode-runtime.c'),
  ]);
  const report = {
    generatedAt: new Date().toISOString(),
    experiment: 'lua-loadfile-buffer-and-binary-reopen-semantics',
    timing: 'none; semantic validation only',
    passed,
    compilerImage,
    compileFlags: [...compileFlags],
    stackBytes: 1024 * 1024,
    identities: {
      vmInventory,
      harnessSha256: sha256(await readFile(new URL(import.meta.url))),
      probeSha256: sha256(await readFile(new URL('./loadf-probe.lua', import.meta.url))),
      hostSha256: sha256(await readFile(new URL('./bytecode-runtime.c', import.meta.url))),
      transformModuleSha256: sha256(await readFile(new URL('./loadf-buffer.mjs', import.meta.url))),
    },
    fixtures: await fixtureInventory(join(scratch, 'root')),
    builds,
    executions,
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(resolve(evidenceDirectory, 'raw.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(evidenceDirectory, 'summary.md'), renderSummary(report));
  console.log(JSON.stringify({ evidenceDirectory: relative(root, evidenceDirectory), passed, builds, executions }, null, 2));
  assert.ok(passed, 'LoadF buffer variants did not preserve baseline semantics');
} finally {
  await assertOwnedScratch(scratch, 'pob-loadf-validate-');
  await rm(scratch, { recursive: true, force: true });
}

async function prepareFixtures(directory) {
  const prefix = 'local pad = [[';
  const suffix = ']]\nreturn #pad\n';
  for (const bytes of [1023, 1024, 1025, 16383, 16384, 16385, 65535, 65536, 65537, 262143, 262144, 262145, 524289]) {
    const filler = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    assert.ok(filler >= 0);
    const source = `${prefix}${'x'.repeat(filler)}${suffix}`;
    assert.equal(Buffer.byteLength(source), bytes);
    await writeFile(join(directory, `source-${bytes}.lua`), source);
  }
  const boundaryPrefix = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('#!/usr/bin/env lua\n')]);
  for (const bytes of [262143, 262144, 262145]) {
    const codePrefix = Buffer.from('local pad = [['), codeSuffix = Buffer.from(']]\nreturn #pad\n');
    const filler = bytes - boundaryPrefix.length - codePrefix.length - codeSuffix.length;
    assert.ok(filler >= 0);
    const source = Buffer.concat([boundaryPrefix, codePrefix, Buffer.alloc(filler, 'p'), codeSuffix]);
    assert.equal(source.byteLength, bytes);
    await writeFile(join(directory, `prefixed-${bytes}.lua`), source);
  }
  await Promise.all([
    writeFile(join(directory, 'bom.lua'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("return 'bom'\n")])),
    writeFile(join(directory, 'shebang.lua'), "#!/usr/bin/env lua\nreturn 'shebang'\n"),
    writeFile(join(directory, 'bom-shebang.lua'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("#!/usr/bin/env lua\nreturn 'bom-shebang'\n")])),
    writeFile(join(directory, 'shebang-eof.lua'), '#!/usr/bin/env lua'),
    writeFile(join(directory, 'empty.lua'), ''),
    writeFile(join(directory, 'syntax.lua'), 'local value = {\n'),
    writeFile(join(directory, 'deep.lua'), 'local function descend(n) if n == 0 then return assert(loadfile("source-262145.lua", "t"))() end local value = descend(n - 1); return 0 + value end\nreturn descend(160)\n'),
    writeFile(join(directory, 'parser-accepted.lua'), `return ${'('.repeat(100)}1${')'.repeat(100)}\n`),
    writeFile(join(directory, 'parser-too-deep.lua'), `return ${'('.repeat(400)}1${')'.repeat(400)}\n`),
  ]);
  for (let index = 48; index >= 1; index--) {
    const next = index === 48 ? 'return 48\n' : `return assert(dofile("nested-${String(index + 1).padStart(2, '0')}.lua"))\n`;
    await writeFile(join(directory, `nested-${String(index).padStart(2, '0')}.lua`), next);
  }
}

function runDocker(command) {
  const result = spawnSync('docker', [
    'run', '--rm', '--network=none',
    '--mount', `type=bind,source=${root},target=/app,readonly`,
    '--mount', `type=bind,source=${scratch},target=/probe`,
    '--workdir', '/app/upstream', compilerImage, ...command,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`LoadF build failed (${command[0]}): ${result.error?.message ?? ''}${result.stderr}\n${result.stdout}`);
}

function execute(variant, probeCase) {
  const useStdin = probeCase === 'stdin';
  const result = spawnSync('docker', [
    'run', '--rm', ...(useStdin ? ['-i'] : []), '--network=none', '-e', `LOADF_CASE=${probeCase}`,
    '--mount', `type=bind,source=${root},target=/app,readonly`,
    '--mount', `type=bind,source=${scratch},target=/probe`,
    '--workdir', '/app/upstream', compilerImage,
    'node', `/probe/build/${variant}.js`, '/probe/root', '/app/tools/experiments/compiled-calcs/expanded/loadf-probe.lua',
  ], { encoding: 'utf8', input: useStdin ? "return 'stdin-ok'\n" : undefined, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const stdout = result.stdout ?? '';
  return {
    status: result.status,
    signal: result.signal,
    stdoutSha256: sha256(stdout),
    resultRecords: stdout.split(/\r?\n/).filter(line => line.startsWith('RESULT\t')),
    stderr: (result.stderr ?? '').slice(0, 4000),
  };
}

async function fixtureInventory(directory) {
  const entries = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && !entry.name.endsWith('.luac')) {
        const bytes = await readFile(absolute);
        entries.push({ path: relative(directory, absolute).replaceAll('\\', '/'), bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
    }
  }
  await visit(directory);
  return { count: entries.length, sha256: sha256(Buffer.from(JSON.stringify(entries))), entries };
}

async function inventoryHash(paths) {
  const entries = [];
  for (const path of [...paths].sort()) entries.push([relative(root, path).replaceAll('\\', '/'), sha256(await readFile(path))]);
  return { fileCount: entries.length, sha256: sha256(Buffer.from(JSON.stringify(entries))) };
}

async function assertOwnedScratch(path, prefix) {
  const absolute = resolve(path);
  assert.equal(resolve(absolute, '..'), resolve(tmpdir()), 'Scratch must be an immediate OS temp child');
  assert.ok(basename(absolute).startsWith(prefix), 'Scratch prefix mismatch');
  assert.equal(resolve(await realpath(absolute)), absolute, 'Scratch path traverses a reparse point');
  assert.equal((await lstat(absolute)).isSymbolicLink(), false, 'Scratch root must not be a link');
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = resolve(directory, entry.name);
      assert.ok(child.startsWith(`${absolute}${sep}`), 'Scratch descendant escaped its owner');
      assert.equal((await lstat(child)).isSymbolicLink(), false, 'Scratch cleanup refuses nested links');
      assert.equal(resolve(await realpath(child)), child, 'Scratch cleanup refuses nested reparse traversal');
      if (entry.isDirectory()) await visit(child);
    }
  }
  await visit(absolute);
}

function renderSummary(report) {
  const lines = ['# Lua LoadF buffer and binary-reopen semantic validation', '',
    `Result: ${report.passed ? 'PASS' : 'FAIL'}.`,
    `Compiler stack: ${report.stackBytes} bytes. No performance timing was performed.`, '',
    '## Variants', ''];
  for (const build of report.builds) lines.push(`- ${build.id}: buffer ${build.loadBufferBytes}; WASM ${build.wasmSha256}.`);
  lines.push('', '## Cases', '');
  for (const execution of report.executions) lines.push(`- ${execution.variant}/${execution.case}: exit ${execution.status}; baseline match ${execution.matchesBaseline}.`);
  lines.push('', 'Coverage includes source sizes around 1 KiB, 16 KiB, 64 KiB and 256 KiB; source and binary BOM/shebang handling; generated and truncated binary chunks; empty, missing and syntax-error files; 200 repeated source and binary loads; 48 nested dofiles; and a 160-level Lua call before a 256 KiB source load.', '');
  return `${lines.join('\n')}\n`;
}
