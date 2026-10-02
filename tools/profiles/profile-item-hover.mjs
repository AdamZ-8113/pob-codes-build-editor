import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalExportTree } from '../../scripts/lib/canonical-export.mjs';
import { startProcessMemory } from '../../scripts/lib/process-memory.mjs';
import { cpus, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';

// Private input remains in memory. Reports retain aggregate timings and hashes only.
const argument = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const origin = argument('origin') ?? 'http://127.0.0.1:3010/';
const output = resolve(argument('out') ?? 'tmp/import2-item-hover/baseline-local.json');
const rounds = Number(argument('rounds') ?? 2);
const buildFile = argument('build-file');
const buildUrl = argument('build-url');
const runtimeDirectory = argument('runtime-dir');
const sourceTransform = argument('source-transform');
const memoryEnabled = process.argv.includes('--memory');
const verifyContext = process.argv.includes('--verify-context');
const includeJewels = process.argv.includes('--jewels');
const diagnosticLines = process.argv.includes('--diagnostic-lines');
const deterministicSeed = process.argv.includes('--deterministic-seed');
const verifyEdits = process.argv.includes('--verify-edits') || verifyContext;
const compareFile = argument('compare');
const referenceReport = compareFile ? JSON.parse(await readFile(resolve(compareFile),'utf8')) : undefined;
assert.ok(buildFile || buildUrl, 'Supply --build-file=<file> or --build-url=https://pob.codes/b/<id>');
let inputUrl;
if(buildUrl){
 const shared = new URL(buildUrl);
 const id = shared.hostname==='pob.codes' && shared.pathname.match(/^\/b\/([\w-]+)\/?$/)?.[1];
 assert.ok(id,'Build URL must be a pob.codes/b/<id> link');
 inputUrl = `https://api.pob.codes/${id}/raw`;
}
const response = !buildFile ? await fetch(inputUrl) : undefined;
if(response)assert.ok(response.ok,`Build input HTTP ${response.status}`);
const buildCode = buildFile ? (await readFile(buildFile, 'utf8')).trim() : (await response.text()).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const app = new URL('../../', import.meta.url);
const require = createRequire(new URL('./upstream/deno.json', app));
const AdmZip = require('adm-zip');
const diagnostics = await readFile(new URL('tools/profiles/item-hover-profile.lua', app), 'utf8');
const production = new URL(origin).hostname === 'pob.codes';
let manifest, archive;
if (production) {
  const html = await (await fetch(origin)).text();
  const release = html.match(/\/import2\/releases\/([a-f0-9]{24})\//)?.[1];
  assert.ok(release, 'Live release pointer');
  const prefix = `https://pob.codes/import2/releases/${release}/payload/`;
  manifest = await (await fetch(`${prefix}manifest.json`)).json();
  archive = Buffer.from(await (await fetch(`${prefix}packages/${manifest.packages.find(p=>p.id==='core').sha256}.zip`)).arrayBuffer());
} else {
  manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', app)));
  archive = await readFile(new URL(`.runtime/payload/packages/${manifest.packages.find(p=>p.id==='core').sha256}.zip`, app));
}
const core = manifest.packages.find(p=>p.id==='core');
assert.equal(sha256(archive), core.sha256);
const originalCoreHash = core.sha256;
const zip = new AdmZip(archive);
const source = zip.readAsText('Classes/ItemsTab.lua');
const transformModule = sourceTransform ? await import(pathToFileURL(resolve(sourceTransform)).href) : undefined;
const transform = transformModule?.transform;
if(sourceTransform)assert.equal(typeof transform,'function','Test-only source transform exports transform(source)');
const transformedSource = transform ? transform(source) : source;
const content = Buffer.from(`${transformedSource}\n${diagnostics}`);
zip.updateFile('Classes/ItemsTab.lua', content);
const file = core.files.find(f=>f.path==='Classes/ItemsTab.lua');
core.uncompressedBytes += content.length - file.bytes;
file.bytes = content.length;
const additionalSourceHashes = {};
for(const extra of transformModule?.additionalTransforms ?? []){
 assert.ok(core.files.some(f=>f.path===extra.path),'Additional source must belong to core package');
 const before = zip.readAsText(extra.path), after = extra.transform(before);
 const updated = Buffer.from(after), entry = core.files.find(f=>f.path===extra.path);
 additionalSourceHashes[extra.path] = {before:sha256(before),after:sha256(after)};
 zip.updateFile(extra.path,updated);
 core.uncompressedBytes += updated.length-entry.bytes; entry.bytes=updated.length;
}
const bytes = zip.toBuffer();
core.bytes = bytes.length; core.sha256 = sha256(bytes);
await mkdir(resolve(output, '..'), {recursive:true});
const browser = await chromium.launch({headless:true,channel:'chrome'});
let memory;
const report = {origin, measuredAt:new Date().toISOString(), browser:browser.version(),cpu:cpus()[0]?.model,logicalCores:cpus().length,systemMemoryBytes:totalmem(),sourceCoreHash:originalCoreHash, sourceItemsHash:sha256(source),
  harnessSha256:sha256(await readFile(new URL(import.meta.url))),diagnosticsSha256:sha256(diagnostics),
  experimentSourceHash:sha256(transformedSource),
  additionalSourceHashes,
  sourceExperiment:transformModule?.experiment,
  transformationEvidence:transformModule?.transformationEvidence,
  includeJewels,
  deterministicSeed,
  scope:'Worker frame CPU and mouse-to-flushed-frame wall time; excludes GPU presentation. Two movements ensure PoB observes the hover.', rounds:[]};
const summarize = values => {const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,median:sorted[Math.floor(sorted.length/2)]??0,p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0,max:sorted.at(-1)??0};};
try {
 if(memoryEnabled){
  const cdp=await browser.newBrowserCDPSession();
  const info=await cdp.send('SystemInfo.getProcessInfo');
  memory=await startProcessMemory(info.processInfo.find(p=>p.type==='browser').id);
  await cdp.detach();
 }
 for(let round=0;round<rounds;round++) {
  const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  // Keep a measured context stable while other agents edit unrelated source.
  // Vite HMR alone uses WebSockets; PoB's runtime RPC uses MessagePorts.
  if(!production)await context.routeWebSocket('**',socket=>socket.close());
  if(runtimeDirectory)for(const name of ['driver.mjs','driver.wasm']){
   const body=await readFile(join(resolve(runtimeDirectory),name));
   await context.route(`**/dist/release/${name}*`,r=>r.fulfill({contentType:name.endsWith('.wasm')?'application/wasm':'text/javascript',body}));
  }
  let seededRuntimeRequests=0;
  if(deterministicSeed)await context.route(production
    ? /^https:\/\/pob\.codes\/import2\/releases\/[a-f0-9]{24}\/shell\/assets\/driver-[\w-]+\.js(?:\?.*)?$/
    : '**/dist/release/driver.mjs*',async route=>{
   const body=runtimeDirectory?await readFile(join(resolve(runtimeDirectory),'driver.mjs'),'utf8'):await (await route.fetch()).text();
   // Lua seeds table hashes from time(NULL). Fix wall-clock time so equally
   // ranked socket blocks have reproducible order; CPU clocks stay real.
   seededRuntimeRequests++;
   await route.fulfill({contentType:'text/javascript',body:'Date.now = () => 1790812800000;\n'+body});
  });
  await context.route('**/payload/manifest.json',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(manifest)}));
  await context.route(`**/payload/packages/${core.sha256}.zip`,r=>r.fulfill({contentType:'application/octet-stream',body:bytes}));
  const page=await context.newPage();
  const nativeResponses=[];
  page.on('response',response=>{
   if(/\/driver(?:-[\w-]+)?\.wasm(?:\?|$)/.test(response.url()))
    nativeResponses.push(response.body().then(body=>sha256(body)));
  });
  const faults=[];page.on('pageerror',e=>faults.push(e.message));
  const flush=()=>page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
  const profile=()=>page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
  const canonicalExport=async()=>{
    const xml=inflateSync(Buffer.from(await page.evaluate(()=>window.__DESKTOP_POB__.getBuildCode()),'base64url')).toString();
    const tree=await page.evaluate(xml=>{
      const root=new DOMParser().parseFromString(xml,'application/xml');
      const walk=node=>node.nodeType===1?[node.tagName,[...node.attributes].map(a=>[a.name,a.value]),[...node.childNodes].map(walk).filter(v=>v!==null)]:node.textContent.trim()||null;
      return walk(root.documentElement);
    },xml);
    return canonicalExportTree(tree);
  };
  try {
   await page.goto(origin);
   await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready,null,{timeout:120000});
   const nativeWasmSha256=[...new Set(await Promise.all(nativeResponses))];
   assert.equal(nativeWasmSha256.length,1,'Actual native runtime identity recorded');
   if(deterministicSeed)assert.ok(seededRuntimeRequests>0,'Test Lua seed applied to the actual native loader');
   await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),buildCode);
   await page.keyboard.press('Control+3');await flush();
   await page.mouse.move(1450,850);await flush();await page.waitForTimeout(1200);
   const initialExport=await canonicalExport();
   const initial=await profile();
   const bounds=await page.locator('canvas').boundingBox(),size=await page.locator('canvas').evaluate(c=>[c.width,c.height]);
   const point=(x,y)=>({x:bounds.x+x*bounds.width/size[0],y:bounds.y+y*bounds.height/size[1]});
   const outside=point(size[0]-50,size[1]-80);
   const state=initial.samples.itemHover;
   assert.ok(state, 'Injected diagnostics loaded');
   const [lx,ly,lw]=state.listBounds;
   const targets=[...['Weapon 1','Helmet','Ring 1','Flask 1','Socket #1','Socket #4'].filter(n=>state.equipped[n]).map(n=>({name:`equipped-${n}`,tooltip:n,p:point(state.equipped[n][0]+80,state.equipped[n][1]+8)})),
    ...[...new Set([0,1,2,3,4,5,6,7,8,9,16,17,18,...(includeJewels?state.jewelIndices.map(i=>i-1):[])])].filter(i=>i<state.listCount).map(i=>({name:`list-row-${i+1}`,row:i,tooltip:'list',p:point(lx+lw*.45,ly+8+i*16)}))];
   const positionTarget=async target=>{
    if(!includeJewels || target.row===undefined)return target.p;
    let current=(await profile()).samples.itemHover;
    for(let step=0;step<80;step++){
     const [x,y,w,h]=current.listBounds;
     const offset=target.row*current.rowHeight-current.scrollOffset+current.rowLabelOffset;
     if(offset>=0 && offset+current.rowHeight<h-4)return point(x+w*.45,y+2+offset+current.rowHeight*.5);
     // Scroll over the scrollbar so preparing a target does not warm another row.
     const center=point(x+w-8,y+h*.5);
     const previousOffset=current.scrollOffset;
     await page.mouse.move(center.x,center.y);await flush();
     await page.mouse.wheel(0,offset<0?-100:100);
     const deadline=performance.now()+5000;
     do {
      await page.waitForTimeout(50);await flush();
      current=(await profile()).samples.itemHover;
      assert.ok(performance.now()<deadline,`${target.name}: native wheel input delivered`);
     } while(current.scrollOffset===previousOffset);
    }
    throw new Error(`${target.name}: native row did not scroll into view`);
   };
   const results=[], firstLines=new Map();
   for(let pass=0;pass<3;pass++)for(const target of targets) {
    const targetPoint=await positionTarget(target);
    await page.mouse.move(outside.x,outside.y);await flush();
    await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile(true));
    await page.evaluate(()=>window.__DESKTOP_POB__.clearFrameSamples());
    const start=performance.now();
    await page.mouse.move(targetPoint.x,targetPoint.y);await flush();
    await page.mouse.move(targetPoint.x+1,targetPoint.y);await flush();
    const wallMs=performance.now()-start;
    const current=await profile(),frames=await page.evaluate(()=>window.__DESKTOP_POB__.frameSamples);
    const hover=current.samples.itemHover;
    if(includeJewels && target.row!==undefined)assert.equal(hover.hoverItemId,state.listItemIds[target.row],`${target.name}: sampled exact requested item`);
    const lines=hover.tooltips[target.tooltip];
    assert.ok(lines.length>0, `${target.name}: tooltip content`);
    const hash=sha256(JSON.stringify(lines));
    const reference=results.find(r=>r.name===target.name);
    if(reference && hash!==reference.tooltipHash){
     const previous=firstLines.get(target.name);
     console.error(JSON.stringify({tooltipMismatch:target.name,pass,differences:lines.map((line,i)=>JSON.stringify(line)!==JSON.stringify(previous[i])?{index:i,previous:previous[i],current:line}:null).filter(Boolean).slice(0,6)}));
    }
    if(!reference)firstLines.set(target.name,lines);
    if(reference)assert.equal(hash,reference.tooltipHash, `${target.name}: complete repeated tooltip parity`);
    if(referenceReport){
     const comparison=referenceReport.rounds.flatMap(r=>r.results).find(r=>r.name===target.name);
     assert.ok(comparison, `${target.name}: baseline target`);
     if(hash!==comparison.tooltipHash && comparison.diagnosticLines){
      console.error(JSON.stringify({baselineMismatch:target.name,pass,differences:lines.map((line,i)=>JSON.stringify(line)!==JSON.stringify(comparison.diagnosticLines[i])?{index:i,previous:comparison.diagnosticLines[i],current:line}:null).filter(Boolean).slice(0,6)}));
     }
     assert.equal(hash,comparison.tooltipHash,`${target.name}: baseline complete tooltip parity`);
    }
    results.push({name:target.name,pass,wallMs,frameCpu:summarize(frames.map(f=>f.duration)),render:summarize(frames.map(f=>f.render)),tooltipMs:hover.tooltipMs,tooltipCalls:hover.calls,tooltipHash:hash,lines:lines.length,cache:hover.cache,bridge:current.bridge,draw:current.draw,phases:current.samples.itemPhases,warmPhases:current.samples.warmPhases,...(diagnosticLines?{diagnosticLines:lines}:{})});
   }
   const verification=[];
   if(verifyEdits){
    const target=targets.find(t=>t.name==='list-row-17')??targets.at(-1);
    const hoverCheck=async name=>{
     const targetPoint=await positionTarget(target);
     await page.mouse.move(outside.x,outside.y);await flush();
     const before=await profile();
     await page.mouse.move(targetPoint.x,targetPoint.y);await flush();await page.mouse.move(targetPoint.x+1,targetPoint.y);await flush();
     const p=await profile(),lines=p.samples.itemHover.tooltips[target.tooltip];
     const result={name,tooltipHash:sha256(JSON.stringify(lines)),lines:lines.length,exportHash:sha256(JSON.stringify(await canonicalExport())),cache:p.samples.itemTooltipCache};
     if(p.samples.itemTooltipCache?.mode==='operations' && p.samples.itemHover.showStatDifferences)
      assert.ok(result.cache.entries>0&&result.cache.entries<=64,`${name}: bounded comparison cache`);
     verification.push(result);return result;
    };
    await hoverCheck('unchanged');
    const level=point(state.levelBounds[0]+30,state.levelBounds[1]+10);
    await page.mouse.click(level.x,level.y);await page.keyboard.press('Control+a');await page.keyboard.type('73');await page.keyboard.press('Enter');await flush();
    const edited=await hoverCheck('level-73');
    assert.notEqual(edited.exportHash,verification[0].exportHash,'Native edit changes exported build');
    if(edited.cache?.mode==='operations')assert.ok(edited.cache.misses>verification[0].cache.misses,'Level edit invalidates comparison cache');
    await page.mouse.move(outside.x,outside.y);await page.keyboard.press('Control+d');await flush();
    const disabled=await hoverCheck('differences-disabled');
    assert.equal((await profile()).samples.itemHover.showStatDifferences,false);
    assert.ok(disabled.lines<edited.lines,'Disabling comparisons removes comparison content');
    await page.mouse.move(outside.x,outside.y);await page.keyboard.press('Control+d');await flush();
    const restored=await hoverCheck('differences-restored');
    assert.equal(restored.tooltipHash,edited.tooltipHash,'Restoring differences restores exact tooltip');
    await page.mouse.move(outside.x,outside.y);await page.keyboard.down('Shift');
    await hoverCheck('shift-details');await page.keyboard.up('Shift');
    if(verifyContext){
     const clickControl=async bounds=>{assert.ok(bounds,'Context control exists');const p=point(bounds[0]+bounds[2]/2,bounds[1]+bounds[3]/2);await page.mouse.click(p.x,p.y);await flush();};
     const restoreCheck=async name=>{const result=await hoverCheck(name);assert.equal(result.exportHash,edited.exportHash,`${name}: exact edited build restored`);assert.equal(result.tooltipHash,edited.tooltipHash,`${name}: exact edited tooltip restored`);};
     await clickControl(state.flaskToggleBounds);
     assert.notEqual((await hoverCheck('flask-toggled')).exportHash,edited.exportHash,'Native flask edit changes export');
     await clickControl(state.flaskToggleBounds);await restoreCheck('flask-restored');
     await clickControl(state.weaponSwapBounds);
     assert.notEqual((await hoverCheck('weapon-swapped')).exportHash,edited.exportHash,'Native weapon swap changes export');
     await clickControl(state.weaponRestoreBounds);await restoreCheck('weapon-restored');
     for(const [kind,bounds,index,count] of [['item-set',state.itemSetBounds,state.itemSetIndex,state.itemSetCount],['spec',state.specBounds,state.specIndex,state.specCount]]){
      assert.ok(count>1,`${kind}: fixture has alternate choices`);
      const key=index<count?'ArrowDown':'ArrowUp';
      await clickControl(bounds);await page.keyboard.press(key);await page.keyboard.press('Escape');await flush();
      assert.notEqual((await hoverCheck(`${kind}-changed`)).exportHash,edited.exportHash,`${kind}: native selection changes export`);
      await clickControl(bounds);await page.keyboard.press(key==='ArrowDown'?'ArrowUp':'ArrowDown');await page.keyboard.press('Escape');await flush();
      await restoreCheck(`${kind}-restored`);
     }
    }
    await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),buildCode);
    await page.keyboard.press('Control+3');await flush();
    const reimported=await hoverCheck('reimported');
    assert.equal(reimported.tooltipHash,verification[0].tooltipHash,'Import restores exact comparison');
    if(referenceReport?.rounds[round]?.verification)assert.deepEqual(verification.map(v=>({name:v.name,tooltipHash:v.tooltipHash,exportHash:v.exportHash})),referenceReport.rounds[round].verification.map(v=>({name:v.name,tooltipHash:v.tooltipHash,exportHash:v.exportHash})),'Edited baseline tooltip and full export parity');
   }
   const final=await profile();
   assert.deepEqual(await canonicalExport(),initialExport,'Complete canonical export unchanged');
   assert.deepEqual(final.errors??[],[]);assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);assert.deepEqual(faults,[]);
   if(memory)await memory.mark(`round-${round}-complete`);
   const result={round,seededRuntimeRequests,nativeWasmSha256:nativeWasmSha256[0],helpers:final.helpers,gcPause:final.samples.gcPause,wasmBytes:final.wasmBytes,luaKiB:final.samples.luaKiB,exportHash:sha256(JSON.stringify(initialExport)),results,verification};
   report.rounds.push(result);
   await page.screenshot({path:join(resolve(output,'..'),`${output.split(/[\\/]/).at(-1).replace('.json','')}-round-${round}.png`)});
   console.log(JSON.stringify({round,gcPause:result.gcPause,helpers:result.helpers,cold:summarize(results.filter(r=>r.pass===0).map(r=>r.frameCpu.max)),warm:summarize(results.filter(r=>r.pass>0).map(r=>r.frameCpu.max))}));
  } finally {await context.close();}
 }
 report.passed=true;
 report.baselineTooltipParity=!!referenceReport;
 if(memory){const {samples,...summary}=memory.report();report.memory=summary;}
 await writeFile(output,JSON.stringify(report,null,2)+'\n');
} finally {if(memory)await memory.stop();await browser.close();}
