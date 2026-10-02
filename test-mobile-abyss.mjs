// Public equipped-build parity against the original full-family loader.
import {chromium} from '@playwright/test';
import {deflateSync} from 'node:zlib';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {loadInput} from './fixture-loader.mjs';
import {instrument,boot,canonical,profile,testCommands} from './mobile-test-support.mjs';
const baseline=process.argv[2];assert.ok(baseline,'Supply isolated original payload directory');
const fixtures=['festering vengeance','extinguishing grasp','baleful dominion','destructive aspiration','reclaimed malevolence'].map(name=>({name,code:deflateSync(loadInput(fileURLToPath(new URL('./fixtures/abyss timeless '+name+' 329.json',import.meta.url))).xml).toString('base64url')}));
const browser=await chromium.launch({headless:true,channel:'chrome'}),variants=[];
try{
 for(const variant of ['original','desktop-records','mobile','legacy']){
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  try{
   await instrument(context,variant==='original'?baseline:undefined,testCommands);
   const page=await context.newPage(),cases=[];variants.push({variant,cases});
   for(const f of (variant==='legacy'?[fixtures.at(-1)]:fixtures)){
    const url='http://127.0.0.1:3010/?payloadPrefetch=0&sortHelpers=0&deviceProfile='+(variant==='mobile'?'mobile':'desktop')+(variant==='legacy'?'&legacyPayload=1':'');
    if(!cases.length)await page.goto(url);
    await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready||window.__DESKTOP_POB__?.errors.length,null,{timeout:120000});
    await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),f.code);
    assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
    cases.push({name:f.name,canonical:await canonical(page),wasm:(await profile(page)).wasmBytes});
   }
  }finally{await context.close();}
 }
 for(const v of variants.slice(1))for(const c of v.cases)assert.equal(c.canonical,variants[0].cases.find(b=>b.name===c.name).canonical,'Equipped native stats and complete export parity: '+c.name);
 const result={passed:true,variants};await writeFile('tmp/desktop-pob-mobile-acceptance/equipped-abyss.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
