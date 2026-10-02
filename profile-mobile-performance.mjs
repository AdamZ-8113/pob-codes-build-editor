import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { startProcessMemory } from './process-memory.mjs';
import { instrument, fixture, boot, flush, profile, action, canonical, point, until, testCommands } from './mobile-test-support.mjs';
const arg = name => process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const origin = arg('origin') ?? 'http://127.0.0.1:3010/';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname) && new URL(origin).port === '3010','Local loopback port 3010 only');
const output = resolve(arg('out') ?? 'tmp/desktop-pob-mobile-acceptance/results.json');
const baseline = arg('baseline');
const reused = arg('reuseBaseline');
assert.ok(baseline,'Supply the isolated original --baseline directory retained before packing');
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const code = await fixture();
const report = {at:new Date().toISOString(),cpu:cpus()[0].model,scope:'Headless Chrome on desktop hardware. Original source loader/scheduling vs candidate on the same native interpreter, with test-only dispatch. Worker CPU is not phone CPU. Windows private commit includes browser/GPU processes. No physical phone connected.',variants:[]};
if(reused) report.variants.push(JSON.parse(await readFile(reused,'utf8')).variants.find(v=>v.variant==='original'));
await mkdir(dirname(output),{recursive:true});
const save = () => writeFile(output,JSON.stringify(report,null,2)+'\n');
for (const variant of (reused ? ['desktop-records','mobile'] : ['original','scoped-original','desktop-records','mobile'])) {
  const browser = await chromium.launch({headless:true,channel:'chrome'});
  let memory;
  try {
    const cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send('SystemInfo.getProcessInfo');
    memory = await startProcessMemory(info.processInfo.find(p=>p.type==='browser').id);
    await cdp.detach();
    const context = await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:3,
      hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36'});
    const identity = await instrument(context,variant.endsWith('original')?baseline:undefined,testCommands);
    const page = await context.newPage();
    const faults=[];page.on('pageerror',e=>faults.push(e.message));
    const requested=[];page.on('request',r=>{if(r.url().includes('/payload/packages/'))requested.push(r.url().split('/').pop());});
    const start=performance.now();
    const url = new URL(origin);url.search='?payloadPrefetch=0&sortHelpers=0&deviceProfile='+ (variant==='mobile'?'mobile':'desktop');
    await boot(page,url.href,code);
    await page.evaluate(()=>window.__DESKTOP_POB__.setViewport(1));
    const initial = await profile(page), exported = await canonical(page);
    const result={variant,identity,bootImportMs:performance.now()-start,policy:initial.devicePolicy,initialWasm:initial.wasmBytes,prefetch:false,inspections:[],lookups:[],scans:[]};
    report.variants.push(result);
    const state=initial.samples.itemHover,[x,y,w]=state.listBounds;
    for (let pass=0;pass<2;pass++) for (const row of [0,2,4,7,9]) {
      // The original five native item-list targets; same zoom/logical positions.
      const outside=await point(page,1450,850);await page.mouse.move(outside.x,outside.y);await flush(page);
      await profile(page,true);
      const p=await point(page,x+w*.45,y+state.rowLabelOffset+8+row*state.rowHeight);
      const at=performance.now();await page.mouse.move(p.x,p.y);await flush(page);await page.mouse.move(p.x+1,p.y);await flush(page);
      if(variant==='mobile') await until(page,p=>p.samples.itemHover.tooltips.list.length>0,5000);
      const current=await profile(page),lines=current.samples.itemHover.tooltips.list;
      assert.ok(lines.length>0);
      result.inspections.push({row:row+1,pass,tooltipMs:current.samples.itemHover.tooltipMs,wallMs:performance.now()-at,cacheMisses:current.samples.itemTooltipCache.misses,linesHash:hash(lines),wasm:current.wasmBytes});
      if(variant==='mobile') {
        assert.equal(current.samples.itemTooltipCache.misses,initial.samples.itemTooltipCache.misses);
        assert.equal(current.filesystem.abyss.loads,0);
      }
    }
    // Full workflow: mode selection, then type filter, then request exact results.
    await profile(page,true);
    if(variant==='scoped-original'){await action(page,'test:ring');await flush(page);await until(page,p=>!p.samples.mobileTest.sortActive);}
    let at=performance.now();await action(page,'test:mode');await flush(page);
    if(variant!=='mobile')await until(page,p=>!p.samples.mobileTest.sortActive);
    const mode=await profile(page);result.modeSelectionMs=performance.now()-at;
    at=performance.now();await action(page,'test:ring');await flush(page);
    if(variant!=='mobile')await until(page,p=>!p.samples.mobileTest.sortActive);
    const filtered=await profile(page);result.filterMs=performance.now()-at;
    if(variant==='mobile')assert.equal(filtered.samples.mobile.sortJobs,0);
    at=performance.now();if(variant==='mobile')await action(page,'sort');await flush(page);
    await until(page,p=>!p.samples.mobileTest.sortActive);
    const sorted=await profile(page);result.sortMs=performance.now()-at;
    result.sort={candidates:sorted.samples.uniqueDbCount,scoresHash:hash(sorted.samples.mobileTest.scores),modeWork:mode.samples.summary,filterWork:filtered.samples.summary,sortWork:sorted.samples.summary,modeScoring:{calls:mode.samples.mobileTest.scoreCalls,ms:mode.samples.mobileTest.scoreMs},filterScoring:{calls:filtered.samples.mobileTest.scoreCalls,ms:filtered.samples.mobileTest.scoreMs},mobile:sorted.samples.mobile};
    // All five families, edge seeds, multiple sockets, repeat and a 20-change eviction stress.
    for (const family of (variant==='scoped-original'?[]:[7,8,9,10,11])) for(const [seed,socket] of [[4050,2491],[100,2491],[8000,2491],[4050,54127],[4050,2491]]) {
      const before=await profile(page);await action(page,`test:lookup:${family}:${seed}:${socket}:0`);
      const after=await profile(page);const lookup=after.samples.mobileTest.lookups.at(-1);
      result.lookups.push({...lookup,recordsHash:hash(lookup.records),records:undefined,beforeWasm:before.wasmBytes,afterWasm:after.wasmBytes,broker:after.filesystem.abyss});
      await save();
    }
    for (const family of (variant==='scoped-original'?[]:[7,8,9,10,11])) {
      const before=await profile(page);await action(page,`test:scan:${family}`);
      const after=await profile(page);const scan=after.samples.mobileTest.lookups.at(-1);
      await action(page,`test:scan:${family}`);
      const warmed=await profile(page);
      result.scans.push({...scan,warmMs:warmed.samples.mobileTest.lookups.at(-1).ms,beforeWasm:before.wasmBytes,afterWasm:after.wasmBytes,broker:after.filesystem.abyss});
      await save();
    }
    if(!variant.endsWith('original')) for(let i=0;i<20;i++) await action(page,`test:lookup:11:${100+i*390}:0:0`);
    const final=await profile(page);result.finalWasm=final.wasmBytes;result.finalBroker=final.filesystem.abyss;
    assert.equal(await canonical(page),exported,'Inspection, sorting and lookups preserve complete native export');
    assert.deepEqual(faults,[]);assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
    result.requests=requested.length;
    result.memory=memory.report();delete result.memory.samples;
    if(variant==='mobile') {
      // Device-scale image quality comparison. Startup cap selected on separate pages.
      await page.setViewportSize({width:390,height:844});
      await page.evaluate(()=>window.__DESKTOP_POB__.setViewport(1.5));
      await page.screenshot({path:resolve(dirname(output),'mobile-portrait-dpr1.5.png'),scale:'device'});
      await page.evaluate(({x,y})=>window.__DESKTOP_POB__.setViewport(1.5,-x*1.5,-y*1.5),{x,y});
      await page.screenshot({path:resolve(dirname(output),'mobile-items-dpr1.5.png'),scale:'device'});
      result.rendering=await page.evaluate(()=>window.__DESKTOP_POB__.getViewport());
      const cap1Page=await context.newPage();await boot(cap1Page,url.href+'&mobileDpr=1',code);
      await cap1Page.setViewportSize({width:390,height:844});
      await cap1Page.evaluate(({x,y})=>window.__DESKTOP_POB__.setViewport(1.5,-x*1.5,-y*1.5),{x,y});
      await cap1Page.screenshot({path:resolve(dirname(output),'mobile-items-dpr1.png'),scale:'device'});
      result.cap1Rendering=await cap1Page.evaluate(()=>window.__DESKTOP_POB__.getViewport());
      await cap1Page.close();
    }
    await context.close();await save();
    console.log(JSON.stringify({variant,initialWasm:result.initialWasm,finalWasm:result.finalWasm,inspections:result.inspections.map(s=>s.tooltipMs),sort:{candidates:result.sort.candidates,mobile:result.sort.mobile},firstLookup:result.lookups[0],scans:result.scans}));
  } finally {await memory?.stop();await browser.close();}
}
const original=report.variants[0];
for(const candidate of report.variants.slice(1)) {
  assert.equal(candidate.sort.scoresHash,original.sort.scoresHash,'Native score strings/order match');
  if(candidate.variant==='scoped-original')continue;
  assert.deepEqual(candidate.lookups.map(x=>x.recordsHash),original.lookups.map(x=>x.recordsHash),'Every native lookup matches full archives');
  assert.deepEqual(candidate.scans.map(x=>[x.count,x.hash]),original.scans.map(x=>[x.count,x.hash]),'Full-seed scan node/roll parity');
}
report.passed=true;await save();
