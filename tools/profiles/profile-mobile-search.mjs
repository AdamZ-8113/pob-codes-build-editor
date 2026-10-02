// Local acceptance capture of the unmodified native weighted search consumer.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { instrument,fixture,boot,action,profile,testCommands } from '../../scripts/lib/mobile-test-support.mjs';
const baseline=process.argv[2]; assert.ok(baseline,'Supply isolated original payload directory');
const out=process.argv[3] ?? 'tmp/desktop-pob-mobile-acceptance/search.json';
const report={at:new Date().toISOString(),variants:[]};
const reuse=process.argv[4]?.startsWith('--')?undefined:process.argv[4];
const families=process.argv.includes('--zorath-only')?[11]:[7,8,9,10,11];
const passes=Number(process.argv.find(v=>v.startsWith('--passes='))?.slice(9)??3);
if(reuse) report.variants.push(JSON.parse(await readFile(reuse,'utf8')).variants.find(v=>v.variant==='original'));
const browser=await chromium.launch({headless:true,channel:'chrome'});
try {
  for(const variant of (reuse?['desktop-records','mobile']:['original','desktop-records','mobile'])) {
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    try {
      await instrument(context,variant==='original'?baseline:undefined,testCommands);
      const page=await context.newPage();
      await boot(page,'http://127.0.0.1:3010/?payloadPrefetch=0&sortHelpers=0&deviceProfile='+ (variant==='mobile'?'mobile':'desktop'),await fixture());
      const result={variant,searches:[]};report.variants.push(result);
      for(const family of families) {
        const searches=[];
        for(let pass=0;pass<passes;pass++) {
          const before=await profile(page);
          await action(page,`test:search:${family}`);
          const after=await profile(page),s=after.samples.mobileTest.lookups.at(-1);
          assert.ok(s.weights>0);assert.ok(s.count>0,'Native search must produce weighted results');
          const hash=createHash('sha256').update(JSON.stringify(s.results)).digest('hex');
          searches.push({...s,results:undefined,hash,requests:(after.filesystem.abyss?.requests??0)-(before.filesystem.abyss?.requests??0),broker:after.filesystem.abyss,workerCache:after.samples.abyssCache,wasm:after.wasmBytes});
        }
        result.searches.push({family,passes:searches});
        console.log(JSON.stringify({variant,family,passes:searches}));
        await writeFile(out,JSON.stringify(report,null,2)+'\n');
      }
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
    } finally {await context.close();}
  }
  for(const c of report.variants.slice(1)) for(let i=0;i<families.length;i++) {
    assert.deepEqual(c.searches[i].passes.map(s=>[s.count,s.hash]),report.variants[0].searches[i].passes.map(s=>[s.count,s.hash]));
  }
  report.passed=true;await writeFile(out,JSON.stringify(report,null,2)+'\n');
} finally {await browser.close();}
