import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, deflateSync, deflateRawSync, gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { EMSDK_IMAGE } from './build/mod-cache/supplement.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14);
assert.ok(process.argv.includes('--bridge-only') !== Boolean(sourceRoot), 'Select --bridge-only or --source-root=<PoB checkout>');
const scratch = await mkdtemp(join(tmpdir(), 'pob-compression-'));
function run(args) {
  const result = spawnSync('docker', ['run', '--rm', ...(args[0] === 'node' ? ['--network=none'] : []),
    '--mount', `type=bind,source=${join(app, 'upstream')},target=/source,readonly`,
    '--mount', `type=bind,source=${scratch},target=/probe`,
    '--workdir', '/source', EMSDK_IMAGE, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  const payload = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('binary data'.repeat(30000))]);
  const gzip = gzipSync(payload);
  const corrupt = Buffer.from(gzip); corrupt[corrupt.length - 8] ^= 1;
  const inputs = { payload, empty: Buffer.alloc(0), gzip, zlib: deflateSync(payload),
    raw: deflateRawSync(payload), corrupt, truncated: gzip.subarray(0, -2),
    trailing: Buffer.concat([gzip, Buffer.from('trailing')]),
    members: Buffer.concat([gzip, gzipSync('second member')]) };
  for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(scratch, name), bytes);
  let helper = '';
  if (sourceRoot) {
    // Copy only the modules needed by TradeHelpers, with no source rewriting.
    const src = resolve(sourceRoot);
    await mkdir(join(scratch, 'Classes'));
    for (const name of ['src/Classes/TradeHelpers.lua', 'runtime/lua/base64.lua']) {
      const bytes = await readFile(join(src, name));
      await writeFile(join(scratch, name.endsWith('base64.lua') ? 'base64.lua' : 'Classes/TradeHelpers.lua'), bytes);
      console.log(`${name} sha256=${createHash('sha256').update(bytes).digest('hex')}`);
    }
    helper = `
package.path = './?.lua;' .. package.path
Deflate, Inflate = NativeDeflate, NativeInflate
local helpers = require('Classes.TradeHelpers')
local encoded = assert(helpers.B64GzipEncode(payload))
assert(not encoded:find('[+/]'))
assert(helpers.B64GzipDecode(encoded) == payload)
write('helper.gz', assert(require('base64').decode(encoded:gsub('-', '+'):gsub('_', '/'))))
assert(helpers.B64GzipDecode('!invalid!') == nil)
`;
  }
  await writeFile(join(scratch, 'test.lua'), `
local function read(path) local f=assert(io.open(path,'rb')); local s=f:read('*a'); f:close(); return s end
function write(path,s) local f=assert(io.open(path,'wb')); f:write(s); f:close() end
local payload=read('payload')
for _, name in ipairs({'gzip','zlib','trailing','members'}) do assert(NativeInflate(read(name)) == payload, name) end
for _, name in ipairs({'raw','corrupt','truncated','empty'}) do local value,err=NativeInflate(read(name)); assert(value == nil and type(err)=='string',name) end
write('encoded.gz', assert(NativeDeflate(payload,true)))
write('encoded.zlib', assert(NativeDeflate(payload)))
for _, flag in ipairs({false,0,'true',{}}) do assert(NativeDeflate(payload,flag) == NativeDeflate(payload)) end
assert(NativeDeflate(payload,nil) == NativeDeflate(payload))
assert(NativeInflate(assert(NativeDeflate('',true))) == '')
${helper}
`);
  const sources = (await readdir(join(app, 'upstream/vendor/lua'))).filter(p => p.endsWith('.c') && p !== 'lua.c').sort().map(p => `vendor/lua/${p}`);
  run(['emcc', ...sources, 'vendor/luautf8/lutf8lib.c', 'packages/driver/src/c/compression.c',
    'packages/driver/test/c/runtime_probe.c', '-Ivendor/lua', '-Ipackages/driver/src/c',
    '-O3', '-DLUA_NANTRICK', '-DLUA_IEEEENDIAN=0', '-sUSE_ZLIB', '-sNODERAWFS',
    '-sALLOW_MEMORY_GROWTH', '-sMALLOC=mimalloc', '-sSTACK_SIZE=1MB', '-sENVIRONMENT=node',
    '-o', '/probe/run.js']);
  run(['node', '/probe/run.js', '/probe', '/probe/test.lua']);
  assert.deepEqual(gunzipSync(await readFile(join(scratch, 'encoded.gz'))), payload);
  assert.deepEqual(inflateSync(await readFile(join(scratch, 'encoded.zlib'))), payload);
  if (sourceRoot) assert.deepEqual(gunzipSync(await readFile(join(scratch, 'helper.gz'))), payload);
  console.log(`Compression interoperability passed: ${sourceRoot ? 'exact TradeHelpers and ' : ''}native gzip/zlib, independent Node vectors, malformed/raw/checksum rejection, first-stream policy, boolean option.`);
} finally {
  assert.equal(dirname(scratch), tmpdir());
  await rm(scratch, { recursive: true, force: true });
}
