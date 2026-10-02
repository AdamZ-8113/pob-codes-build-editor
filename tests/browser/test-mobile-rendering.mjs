import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {instrument,fixture,boot,flush,profile,testCommands} from '../../scripts/lib/mobile-test-support.mjs';
const directory=resolve('tmp/desktop-pob-mobile-acceptance/rendering');await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'}),captures=[];
try{
 for(const cap of [1,1.5])for(const [orientation,viewport] of [['portrait',{width:390,height:844}],['landscape',{width:844,height:390}]]){
  const context=await browser.newContext({viewport,deviceScaleFactor:3,hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36'});
  try{
   await instrument(context,undefined,testCommands);const page=await context.newPage();
   await boot(page,'http://127.0.0.1:3010/?payloadPrefetch=0&sortHelpers=0'+(cap===1?'&mobileDpr=1':''),await fixture());
   await page.waitForTimeout(1100);await flush(page);
   const state=(await profile(page)).samples.itemHover,[x,y]=state.listBounds;
   for(const zoom of ['default',1,1.5]){
    if(zoom!=='default')await page.evaluate(({zoom,x,y})=>window.__DESKTOP_POB__.setViewport(zoom,-x*zoom,-y*zoom),{zoom,x,y});
    await flush(page);
    const view=await page.evaluate(()=>window.__DESKTOP_POB__.getViewport());assert.equal(view.pixelRatio,cap);
    const shell=await page.locator('.site-header').boundingBox();
    assert.ok(shell && shell.y>=0 && shell.y+shell.height<=viewport.height,'Mobile shell remains reachable at every camera zoom');
    const filename=`${orientation}-dpr${cap}-zoom${zoom}.png`;
    await page.screenshot({path:resolve(directory,filename),scale:'device'});
    captures.push({filename,orientation,cap,zoom,view,shell,pngWidth:viewport.width*3,pngHeight:viewport.height*3});
   }
  }finally{await context.close();}
 }
 await writeFile(resolve(directory,'captures.json'),JSON.stringify({captures,decision:'Adopt 1.5: cap 1 visibly blurs native item text. Physical finger usability unverified.'},null,2)+'\n');
 console.log(JSON.stringify({passed:true,captures:captures.length,directory}));
}finally{await browser.close();}
