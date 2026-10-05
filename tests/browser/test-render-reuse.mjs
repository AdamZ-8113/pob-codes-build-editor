import { chromium } from '@playwright/test';
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
const fixture=(await readFile(new URL('../../fixtures/guided import parity desktop 329.txt',import.meta.url),'utf8')).trim();
const browser=await chromium.launch({headless:true,channel: browserChannel()});
const rounds=[];
try {
  const page=await browser.newPage({viewport:{width:1600,height:1000}});
  // Isolate command identity from PoB's rotating jewel-radius artwork, as in
  // the existing culling pixel oracle. Worker/render performance clocks stay real.
  await page.route(/\/dist\/release\/driver\.mjs(?:\?|$)/,async route=>{
    const response=await route.fetch(), source=await response.text();
    const clock='var _emscripten_get_now = () => performance.now();';
    assert.ok(source.includes(clock));
    await route.fulfill({response,body:source.replace(clock,'var _emscripten_get_now = () => 1000;')});
  });
  await page.goto('http://127.0.0.1:3010');
  await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready,null,{timeout:120000});
  const canvas=page.locator('canvas');
  const stats=async()=>{
    const xml=inflateSync(Buffer.from(await page.evaluate(()=>window.__DESKTOP_POB__.getBuildCode()),'base64url')).toString();
    return [...xml.matchAll(/<PlayerStat\b[^>]*>/g)].map(m=>m[0]).sort();
  };
  for(let round=0;round<3;round++) {
    for(const enabled of [false,true]) {
      await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),fixture);
      await page.keyboard.press('Control+1');
      await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
      await page.evaluate(enabled=>window.__DESKTOP_POB__.configureRenderReuse(enabled),enabled);
      const before=await stats();
      const bounds=await canvas.boundingBox();
      await page.mouse.move(bounds.x+1300,bounds.y+820);
      await page.waitForTimeout(800);
      const pixelsBefore=await canvas.screenshot();
      await page.evaluate(()=>window.__DESKTOP_POB__.clearFrameSamples());
      for(let i=0;i<40;i++) { await page.mouse.move(bounds.x+1300,bounds.y+820); await page.waitForTimeout(18); }
      const staticFrames=await page.evaluate(()=>window.__DESKTOP_POB__.frameSamples);
      if(enabled) assert.ok(staticFrames.some(f=>f.reused),'Identical commands must actually reuse rendered output');
      else assert.ok(staticFrames.every(f=>!f.reused),'Disabled reuse must render every frame');
      const pixelsAfter=await canvas.screenshot();
      const beforePixels=await sharp(pixelsBefore).removeAlpha().raw().toBuffer();
      const afterPixels=await sharp(pixelsAfter).removeAlpha().raw().toBuffer();
      let changed=0;
      for(let i=0;i<beforePixels.length;i+=3) if([0,1,2].some(c=>Math.abs(beforePixels[i+c]-afterPixels[i+c])>2))changed++;
      assert.ok(changed/(beforePixels.length/3)<.001,`Canvas pixels changed: ${changed}, reuse=${enabled}`);
      await page.evaluate(()=>window.__DESKTOP_POB__.clearFrameSamples());
      await page.mouse.move(bounds.x+1000,bounds.y+600); await page.mouse.down();
      for(let i=1;i<=40;i++) { await page.mouse.move(bounds.x+1000-i*2,bounds.y+600-i); await page.waitForTimeout(18); }
      await page.mouse.up(); await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
      const movingFrames=await page.evaluate(()=>window.__DESKTOP_POB__.frameSamples);
      assert.deepEqual(await stats(),before,'Frame reuse never skips Lua or changes player stats');
      assert.ok(!(await canvas.screenshot()).equals(pixelsAfter),'Changing commands update the canvas');
      rounds.push({round,enabled,staticFrames,movingFrames});
      console.log(`Renderer round ${round}, reuse ${enabled}: ${staticFrames.filter(f=>f.reused).length}/${staticFrames.length} identical frames reused`);
    }
  }
  const client=await page.context().newCDPSession(page);
  // Keep the viewport wider than the shell's explicit 1550px minimum so an
  // element screenshot cannot temporarily enlarge/reset the viewport itself.
  for(const [width,height,deviceScaleFactor] of [[1800,1100,1],[1700,1050,2]]) {
    await page.setViewportSize({width,height});
    await client.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor,mobile:false});
    await page.waitForFunction(()=>{
      const c=document.querySelector('canvas'),r=c.getBoundingClientRect();
      return Math.abs(c.width-r.width*devicePixelRatio)<=1 && Math.abs(c.height-r.height*devicePixelRatio)<=1;
    });
    const bound=await canvas.boundingBox();
    await page.mouse.move(bound.x+bound.width-10,bound.y+bound.height-10); await page.waitForTimeout(500);
    const reused=await canvas.screenshot();
    await page.evaluate(()=>window.__DESKTOP_POB__.configureRenderReuse(false));
    await page.mouse.move(bound.x+bound.width-10,bound.y+bound.height-10); await page.waitForTimeout(100);
    const baseline=await canvas.screenshot();
    const a=await sharp(reused).removeAlpha().raw().toBuffer(),b=await sharp(baseline).removeAlpha().raw().toBuffer();
    assert.equal(a.length,b.length);let changed=0;
    for(let i=0;i<a.length;i+=3) if([0,1,2].some(c=>Math.abs(a[i+c]-b[i+c])>2))changed++;
    assert.ok(changed/(a.length/3)<.001,`Resize/DPR ${deviceScaleFactor} must match fresh rendering`);
    await page.evaluate(()=>window.__DESKTOP_POB__.configureRenderReuse(true));
  }
  await client.detach();
  assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify({browser:browser.version(),rounds},null,2)+'\n');
  const summary=frames=>{const r=frames.map(f=>f.render).sort((a,b)=>a-b);return {frames:frames.length,reused:frames.filter(f=>f.reused).length,median:r[Math.floor(r.length/2)],p95:r[Math.floor(r.length*.95)]};};
  console.log(JSON.stringify(rounds.map(r=>({round:r.round,enabled:r.enabled,static:summary(r.staticFrames),moving:summary(r.movingFrames)}))));
} finally {await browser.close();}
