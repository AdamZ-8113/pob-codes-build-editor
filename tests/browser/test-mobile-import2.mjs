import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile,readdir,stat,writeFile } from 'node:fs/promises';
import { resolve,join,extname,sep } from 'node:path';
import { fixture,canonical } from '../../scripts/lib/mobile-test-support.mjs';
const root=resolve('.runtime/import2-release');
const release=JSON.parse(await readFile(join(root,'import2/release.json'),'utf8'));
const current=join(root,'import2/releases',release.current);
const manifest=JSON.parse(await readFile(join(current,'payload/manifest.json'),'utf8'));
assert.ok(manifest.packages.length<=1800);
const abyss=manifest.packages.filter(p=>p.id.startsWith('abyss-'));
assert.equal(abyss.length,1591);
assert.ok(abyss.reduce((n,p)=>n+p.bytes,0)<=160*1024*1024);
assert.equal(abyss.some(p=>p.startup),false);
assert.equal(manifest.packages.some(p=>p.files.some(f=>/Abyss\w+\.zip\.part\d$/.test(f.path))),false);
assert.ok((await stat(join(current,'payload/manifest.json'))).size<=1024*1024);
async function inventory(dir){let bytes=0,files=0;for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory()){const n=await inventory(p);bytes+=n.bytes;files+=n.files;}else{const s=await stat(p);assert.ok(s.size<=25*1024*1024);bytes+=s.size;files++;}}return{bytes,files};}
const currentSize=await inventory(current),totalSize=await inventory(root);
assert.ok(currentSize.bytes<=615*1024*1024&&currentSize.files<=3000);
assert.ok(totalSize.bytes<=1250*1024*1024&&totalSize.files<=6000);
assert.equal(release.retained.length,1,'Preserve one actual previous generation');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.zip':'application/zip','.png':'image/png','.woff2':'font/woff2','.ttf':'font/ttf','.svg':'image/svg+xml'};
const browser=await chromium.launch({headless:true,channel:'chrome'}),devices=[];
try {
  for(const [name,settings,expected,query] of [
    ['desktop',{viewport:{width:500,height:900},hasTouch:true},'desktop','deviceProfile=mobile&mobileDpr=1&sortHelpers=0'],
    ['phone',{viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:3,userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36'},'mobile','deviceProfile=desktop&mobileDpr=1&sortHelpers=3&payloadPrefetch=1'],
    ['tablet',{viewport:{width:1024,height:768},hasTouch:true,deviceScaleFactor:2,userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'},'mobile','deviceProfile=desktop&mobileDpr=1&sortHelpers=3'],
  ]) {
    const context=await browser.newContext(settings);
    try {
      if(name==='tablet')await context.addInitScript(()=>{Object.defineProperty(navigator,'platform',{get:()=>'MacIntel'});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});});
      await context.route('http://127.0.0.1:3010/import2/**',async route=>{
        const pathname=new URL(route.request().url()).pathname;
        const path=resolve(root,'.'+decodeURIComponent(pathname)+(pathname.endsWith('/')?'index.html':''));
        assert.ok(path.startsWith(root+sep));
        let body;
        try{body=await readFile(path);}catch(error){if(error.code!=='ENOENT')throw error;await route.fulfill({status:404,body:'Not found'});return;}
        await route.fulfill({body,contentType:types[extname(path)]??'application/octet-stream',headers:{'cross-origin-opener-policy':'same-origin','cross-origin-embedder-policy':'require-corp','cross-origin-resource-policy':'same-origin'}});
      });
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:3010/import2/?'+query);
      await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready||window.__DESKTOP_POB__?.errors.length,null,{timeout:120000});
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      const policy=await page.evaluate(()=>window.__DESKTOP_POB__.devicePolicy);
      assert.equal(policy.kind,expected,'Production ignores development override');
      const profile=await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
      assert.equal(profile.filesystem.abyss.loads,0);
      if(expected==='mobile'){assert.equal(profile.helpers.requested,0);assert.equal((await page.evaluate(()=>window.__DESKTOP_POB__.getViewport())).pixelRatio,1.5);}
      await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),await fixture());
      devices.push({name,kind:policy.kind,export:await canonical(page)});
    }finally{await context.close();}
  }
  assert.equal(new Set(devices.map(d=>d.export)).size,1);
  const result={passed:true,release:release.current,retained:release.retained,currentSize,totalSize,packages:manifest.packages.length,abyssBytes:abyss.reduce((n,p)=>n+p.bytes,0),devices};
  await writeFile('tmp/desktop-pob-mobile-acceptance/import2.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
