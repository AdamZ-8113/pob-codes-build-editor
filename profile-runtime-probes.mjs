// Isolated public-input experiments; no experimental code enters the app bundle.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inflateSync, deflateSync } from 'node:zlib';
const app = dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL('./upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const mode = process.argv[2] ?? 'headless';
if (!['headless', 'bytecode'].includes(mode)) throw new Error('Use headless or bytecode');
const allocator = process.argv.includes('--dlmalloc') ? 'dlmalloc' : 'mimalloc';
const initialBytes = process.argv.includes('--initial-256m') ? 256 * 1024 * 1024 : undefined;
const scratch = await mkdtemp(join(tmpdir(), 'codex-desktop-probe-'));
const image = 'emscripten/emsdk:6.0.6@sha256:be96eff5810e42c632f3f8b795388a6b596e4fb21ec28b9e1fb1bc49bb3b1eef';
function docker(args) {
  const result = spawnSync('docker', ['run','--rm',...(args[0]==='node'?['--network=none']:[]),'--mount',`type=bind,source=${app},target=/app,readonly`,
    '--mount',`type=bind,source=${scratch},target=/probe`,'--workdir','/app/upstream', image,...args],
    { encoding:'utf8', maxBuffer:4*1024*1024, windowsHide:true });
  if (result.error || result.status !== 0) throw new Error(`${result.error?.message ?? ''}${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
try {
  const zip = new AdmZip(await readFile(join(app,'.runtime/payload/root.zip')));
  const paths=[]; let sourceCompressed=0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path=entry.entryName;
    if (path.startsWith('/') || path.split('/').some(s=>s==='..')) throw new Error('Unexpected archive path');
    const target=join(scratch,'root',path);
    await mkdir(dirname(target),{recursive:true}); await writeFile(target, entry.getData());
    if (path.endsWith('.lua')) {
      paths.push(path); sourceCompressed+=deflateSync(entry.getData()).length;
      await mkdir(dirname(join(scratch,'bytecode',path)),{recursive:true});
    } else if(mode==='bytecode') {
      const bytecodeTarget=join(scratch,'bytecode',path);
      await mkdir(dirname(bytecodeTarget),{recursive:true}); await writeFile(bytecodeTarget,entry.getData());
    }
  }
  await mkdir(join(scratch,'user'),{recursive:true});
  await writeFile(join(scratch,'lua-files.txt'), paths.join('\n')+'\n');
  const fixture=(await readFile(join(app,'fixtures/guided import parity desktop 329.txt'),'utf8')).trim();
  await writeFile(join(scratch,'build.xml'),inflateSync(Buffer.from(fixture,'base64url')));
  const sources=(await readdir(join(app,'upstream/vendor/lua'))).filter(p=>p.endsWith('.c')&&p!=='lua.c').map(p=>`vendor/lua/${p}`);
  // sdk includes zlib port; network is disabled for the actual experiment.
  docker(['emcc',...sources,'vendor/luautf8/lutf8lib.c','packages/driver/src/c/compression.c','packages/driver/test/c/runtime_probe.c',
    '-Ivendor/lua','-Ipackages/driver/src/c','-O3','-sUSE_ZLIB','-sNODERAWFS','-sALLOW_MEMORY_GROWTH',`-sMALLOC=${allocator}`,
    ...(initialBytes?[`-sINITIAL_MEMORY=${initialBytes}`]:[]),
    '-sSTACK_SIZE=1MB','-sENVIRONMENT=node','-o','/probe/run.js']);
  const samples=[];
  const readiness=[];
  for(let i=0;i<3;i++) {
    const stdout=docker(['node','/probe/run.js','/probe/root',`/app/upstream/packages/driver/test/lua/${mode}-probe.lua`]);
    samples.push(stdout.split(/\r?\n/).filter(s=>s.startsWith('PROBE ')).map(s=>JSON.parse(s.slice(6))));
    if(mode==='bytecode') for(const payload of ['root','bytecode']) {
      const ready=docker(['node','/probe/run.js',`/probe/${payload}`,'/app/upstream/packages/driver/test/lua/headless-probe.lua']);
      readiness.push({round:i,payload,samples:ready.split(/\r?\n/).filter(s=>s.startsWith('PROBE ')).map(s=>JSON.parse(s.slice(6)))});
    }
  }
  let bytecodeCompressed=0;
  if(mode==='bytecode') for(const path of paths) bytecodeCompressed+=deflateSync(await readFile(join(scratch,'bytecode',path))).length;
  const report={mode,allocator,initialBytes,cpu:cpus()[0]?.model,sourceRevision:JSON.parse(await readFile(join(app,'source-pin.json'))).revision,
    samples,...(mode==='bytecode'?{sourceCompressed,bytecodeCompressed,readiness}:{})};
  if(process.argv[3]&&!process.argv[3].startsWith('--')) await writeFile(resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  if(dirname(scratch)!==tmpdir() || !scratch.startsWith(join(tmpdir(),'codex-desktop-probe-'))) throw new Error('Unexpected scratch cleanup path');
  await rm(scratch,{recursive:true,force:true});
}
