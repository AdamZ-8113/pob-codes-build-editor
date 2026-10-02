import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const output = resolve(args.find(arg => !arg.startsWith('--')) ?? 'tmp/desktop-pob-runtime-memory/acceptance.json');
const candidatePause = Number(args.find(arg => arg.startsWith('--gc-pause='))?.split('=')[1] ?? 100);
const baselineRuntime = args.find(arg => arg.startsWith('--baseline-runtime='))?.slice('--baseline-runtime='.length);
const pairs = Number(args.find(arg => arg.startsWith('--pairs='))?.split('=')[1] ?? 3);
assert.ok([1,3,6].includes(pairs));
assert.ok([100,200].includes(candidatePause));
const app = new URL('../../', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const identity = {
  wasmSha256: sha256(await readFile(new URL('upstream/packages/driver/dist/release/driver.wasm',app))),
  harnessSha256: sha256(await readFile(new URL('tools/profiles/profile-unique-memory.mjs',app))),
  canonicalizerSha256: sha256(await readFile(new URL('scripts/lib/canonical-export.mjs',app))),
  samplerSha256: sha256(await readFile(new URL('scripts/lib/process-memory.mjs',app))),
  runtimeSourcesSha256: sha256(Buffer.concat(await Promise.all([
    'src/main.ts','source-pin.json','.runtime/payload/manifest.json','upstream/packages/driver/unique-sort-workers.lua',
    ...['driver','worker','broker','helper-pool','helper-access','calc-helper','rpc','gc-policy'].map(name=>'upstream/packages/driver/src/js/'+name+'.ts'),
  ].map(path=>readFile(new URL(path,app)))))),
};
const fixtureSha256 = sha256(await readFile(new URL('fixtures/guided import parity desktop 329.txt',app)));
const baselineWasm = baselineRuntime ? sha256(await readFile(join(baselineRuntime,'driver.wasm'))) : identity.wasmSha256;
let cached=[];
if(args.includes('--resume')) {
  try {cached=JSON.parse(await readFile(output,'utf8')).reports;}
  catch(error) {if(error.code!=='ENOENT') throw error;}
}
const scratch=await mkdtemp(join(tmpdir(),'pob-runtime-memory-'));
const reports=[];
const median=values=>{const sorted=[...values].sort((a,b)=>a-b), mid=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;};
const sortPhases=report=>report.phases.filter(p=>p.name.startsWith('unique-sort-'));
function warm(report) {
  if (!report.name?.startsWith('baseline-') || !report.phases.at(-1).helpers.recycled) return median(report.sortsMs.slice(1));
  // The old policy can retire its pool under sustained memory pressure. Keep
  // that real peak, but never credit the candidate for a serial-fallback delay.
  const phases=sortPhases(report), stable=[];
  for(let i=1;i<phases.length;i++) {
    const a=phases[i-1].helpers,b=phases[i].helpers;
    if(b.ready===3 && b.recycled===a.recycled && b.completed-a.completed>=phases[i].sort.values.length*3/4) stable.push(report.sortsMs[i]);
  }
  assert.ok(stable.length>=2,'Baseline needs at least two fully parallel warm sorts');
  return Math.min(...stable); // stricter than the usual median for a fallback run
}
async function save(status, summary) {
  await mkdir(resolve(output,'..'),{recursive:true});
  await writeFile(output,JSON.stringify({status,summary,reports},null,2)+'\n');
}
async function run(name,pause,options) {
  const isBaseline = name.startsWith('baseline-');
  const expectedIdentity = {...identity, wasmSha256:isBaseline ? baselineWasm : identity.wasmSha256};
  let report=cached.find(r=>r.name===name && r.gcPause===pause && r.fixtureSha256===fixtureSha256 &&
    JSON.stringify(r.runOptions)===JSON.stringify(options) && Object.entries(expectedIdentity).every(([key,value])=>r[key]===value));
  if(report) console.log('Reusing matching memory scenario:',name);
  else {
    const file=join(scratch,name+'.json');
    await new Promise((accept,reject)=>{
      const child=spawn(process.execPath,['tools/profiles/profile-unique-memory.mjs',file,'--helpers=3',
        '--gc-pause='+pause,'--helper-gc-pause=400',...(isBaseline && baselineRuntime ? ['--runtime='+baselineRuntime] : []),...options],{stdio:'inherit',windowsHide:true});
      child.on('error',reject);child.on('exit',code=>code===0?accept():reject(new Error(name+' exited '+code)));
    });
    report=JSON.parse(await readFile(file,'utf8'));
  }
  reports.push({name,runOptions:options,...report});await save('running');
  assert.deepEqual(report.faults,[]);
  assert.ok(report.phases.every(p=>p.gcPause===pause),'Runtime must actually apply requested policy');
  const helpers=report.phases.at(-1).helpers;
  if(isBaseline) assert.ok(helpers.errors.every(message=>message==='Error: Helper memory reserve exhausted'));
  else {
    assert.equal(helpers.ready,3);
    assert.deepEqual(helpers.errors,[]);
    assert.equal(helpers.recycled,0);
  }
  assert.ok(report.memory.peakBytes<=6*2**30,'6 GiB whole-browser hard acceptance budget');
  return {name,...report};
}
function equivalent(baseline,candidate) {
  const expected=sortPhases(baseline)[0].sort.values;
  for(const p of sortPhases(candidate)) assert.deepEqual(p.sort.values,expected,'Every full-precision score and position');
  assert.deepEqual(candidate.canonicalExportHashes,baseline.canonicalExportHashes,'Complete canonical exports, including after heatmap');
}
try {
  const base=[],candidate=[];
  for(let i=0;i<pairs;i++) {
    const a=await run('baseline-'+i,400,['--rounds=5','--heatmap']);
    const b=await run('candidate-'+candidatePause+'-'+i,candidatePause,['--rounds=5','--heatmap']);
    if(base.length) equivalent(base[0],a);
    equivalent(a,b);base.push(a);candidate.push(b);
    assert.equal(a.phases.at(-1).timelessLoadedMask,2047);
    assert.equal(b.phases.at(-1).timelessLoadedMask,2047);
    assert.ok(b.memory.peakBytes<=5.5*2**30,'5.5 GiB admission ceiling');
  }
  const sortOnly=await run('candidate-sort-only-'+candidatePause,candidatePause,['--rounds=2','--sort-only']);
  assert.deepEqual(sortPhases(sortOnly)[0].sort.values,sortPhases(base[0])[0].sort.values);
  const summary={candidatePause,pairs,
    baselinePeakGiB:median(base.map(r=>r.memory.peakBytes))/2**30,
    candidatePeakGiB:median(candidate.map(r=>r.memory.peakBytes))/2**30,
    baselineSortMs:median(base.map(warm)),candidateSortMs:median(candidate.map(warm)),
    baselineHeatmapMs:median(base.map(r=>r.heatmapMs)),candidateHeatmapMs:median(candidate.map(r=>r.heatmapMs)),
    baselineRetirements:base.map(r=>r.phases.at(-1).helpers.recycled),
    sortOnlyUiMiB:sortPhases(sortOnly).at(-1).wasmBytes/2**20,
    baselineSamples:base.map(r=>({sortMs:warm(r),heatmapMs:r.heatmapMs,peakGiB:r.memory.peakBytes/2**30})),
    candidateSamples:candidate.map(r=>({sortMs:warm(r),heatmapMs:r.heatmapMs,peakGiB:r.memory.peakBytes/2**30})),
  };
  summary.memoryReduction=1-summary.candidatePeakGiB/summary.baselinePeakGiB;
  summary.sortRatio=summary.candidateSortMs/summary.baselineSortMs;
  summary.heatmapRatio=summary.candidateHeatmapMs/summary.baselineHeatmapMs;
  await save('measured',summary);console.log('Runtime memory comparison:',JSON.stringify(summary));
  if(pairs===1) {console.log('Calibration only; final acceptance requires three pairs.');}
  else {
    assert.ok(summary.memoryReduction>=.1,'At least 10% lower whole-browser peak');
    assert.ok(summary.sortOnlyUiMiB<=1300,'UI sort capacity at most 1300 MiB');
    assert.ok(summary.sortRatio<=1.03 && summary.heatmapRatio<=1.03,
      'At most 3% speed regression; use one six-pair pooled run only for ratios <=1.06');
    await save('passed',summary);console.log('Runtime memory acceptance passed.');
  }
} finally {
  const owned=resolve(scratch);
  if(resolve(owned,'..')!==resolve(tmpdir()) || !basename(owned).startsWith('pob-runtime-memory-')) throw new Error('Invalid scratch cleanup path');
  await rm(owned,{recursive:true,force:true});
}
