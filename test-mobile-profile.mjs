import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { instrument, fixture, boot, flush, profile, action, canonical, point, until, testCommands } from './mobile-test-support.mjs';

const browser = await chromium.launch({headless:true, channel:'chrome'});
const code = await fixture();
const results = [];
try {
  // Original automatic comparison text at the same logical target.
  const referenceContext=await browser.newContext({viewport:{width:1600,height:1000}});
  let referenceLines;
  try {
    await instrument(referenceContext,undefined,testCommands);
    const page=await referenceContext.newPage();
    await boot(page,'http://127.0.0.1:3010/?payloadPrefetch=0&sortHelpers=0',code);
    await page.evaluate(()=>window.__DESKTOP_POB__.setViewport(1));
    const state=(await profile(page)).samples.itemHover,[x,y,w]=state.listBounds;
    const p=await point(page,x+w*.35,y+state.rowLabelOffset+8);
    await page.mouse.move(p.x,p.y);await flush(page);await page.mouse.move(p.x+1,p.y);await flush(page);
    referenceLines=(await profile(page)).samples.itemHover.tooltips.list;
    assert.ok(referenceLines.length);
  } finally {await referenceContext.close();}
  for (const [name, device, expected] of [
    ['phone', {viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/154 Mobile Safari/537.36'}, 'mobile'],
    ['tablet', {viewport:{width:1024,height:768},deviceScaleFactor:2,hasTouch:true,userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'}, 'mobile'],
    ['narrow-desktop', {viewport:{width:500,height:900},deviceScaleFactor:1,hasTouch:true}, 'desktop'],
  ]) {
    const context = await browser.newContext(device);
    try {
      if (name === 'tablet') await context.addInitScript(() => {
        Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'});
        Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});
      });
      await instrument(context, undefined, testCommands);
      const page = await context.newPage();
      await boot(page,'http://127.0.0.1:3010/?payloadPrefetch=0&sortHelpers=3',code);
      const initial = await profile(page), policy = initial.devicePolicy;
      assert.equal(policy.kind, expected);
      const view = await page.evaluate(() => window.__DESKTOP_POB__.getViewport());
      if (expected === 'mobile') {
        assert.equal(initial.helpers.requested, 0);
        assert.equal(view.pixelRatio, 1.5);
        assert.ok(view.scale >= 1.5);
        assert.equal(await page.locator('#mobile-compare').count(),1);
        const targets = await page.locator('#editor-accessibility button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
        assert.ok(targets.every(h => h >= 32));
        await action(page,'test:mode'); await flush(page);
        await action(page,'test:ring'); await flush(page);
        assert.equal((await profile(page)).samples.mobile.sortJobs,0);
        assert.ok((await profile(page)).samples.uniqueDbCount > 0);
        assert.ok((await profile(page)).samples.uniqueDbCount < initial.samples.uniqueDbCount);
      } else assert.equal(await page.locator('#mobile-compare').count(),0);
      // Rotation updates layout; it never reselects device policy or helpers.
      await page.setViewportSize({width:device.viewport.height,height:device.viewport.width});
      await flush(page);
      assert.deepEqual((await profile(page)).devicePolicy,policy);
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code),code);
      assert.deepEqual((await profile(page)).devicePolicy,policy);
      // Unconfigured database jewels use out-of-range seeds. Empty broker
      // replies must cross the native bridge safely without loading a family.
      for (let family=7;family<=11;family++) {
        await action(page,`test:lookup:${family}:0:2491:0`);
        assert.deepEqual((await profile(page)).samples.mobileTest.lookups.at(-1).records,[]);
        if(family!==11) {
          await action(page,`test:lookup:${family}:4050:0:0`);
          assert.deepEqual((await profile(page)).samples.mobileTest.lookups.at(-1).records,[]);
        }
      }
      assert.equal((await profile(page)).filesystem.abyss.loads,0);
      // Inspect native rows at the readable mobile zoom, panning the target into view.
      await page.keyboard.press('Control+3'); await flush(page);
      const state = (await profile(page)).samples.itemHover;
      const [x,y,w] = state.listBounds;
      await page.evaluate(({x,y}) => window.__DESKTOP_POB__.setViewport(1.5, -x*1.5, -y*1.5),{x,y});
      const p = await point(page,x+w*0.35,y+state.rowLabelOffset+8);
      const cdp = await context.newCDPSession(page);
      if (expected === 'mobile') {
        for (const offset of [-3,0,3]) {
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x+offset,y:p.y,radiusX:2,radiusY:2}]});
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          await page.waitForTimeout(60); await flush(page);
          assert.ok((await profile(page)).samples.itemHover.tooltips.list.length > 0);
        }
        const inspected = await profile(page);
        assert.equal(inspected.samples.itemTooltipCache.misses,0,'Simple taps never invoke comparison cache/calculator');
        assert.equal(inspected.filesystem.abyss.loads,0);
        await page.locator('#mobile-compare').click();await flush(page);
        await until(page,s=>s.samples.mobile.comparisons>0);
        const compared=await profile(page);
        // Native tooltip wrapping follows available logical screen width.
        const content=lines=>lines.map(l=>l.text??'').join(' ').replace(/\^x[0-9a-f]{6}|\^[0-9]/gi,'').replace(/\s+/g,' ').trim();
        assert.equal(content(compared.samples.itemHover.tooltips.list),content(referenceLines),'Explicit Compare preserves all native text and numbers across wrapping');
        assert.equal(compared.samples.itemTooltipCache.misses,1);
        await page.locator('#mobile-compare').click();await flush(page);
        assert.equal((await profile(page)).samples.itemTooltipCache.misses,1,'Repeat Compare reuses native cache');
        // A new pointer target loses comparison permission immediately.
        const outside=await point(page,x+w*.35,y+state.rowLabelOffset+8+state.rowHeight*2);
        await page.mouse.move(outside.x,outside.y);await flush(page);
        assert.equal((await profile(page)).samples.itemTooltipCache.misses,1,'Movement returns to inspection');
        await action(page,'test:mode');await action(page,'test:ring');await flush(page);
        assert.equal((await profile(page)).samples.mobileTest.scoreCalls,0);
        await page.locator('#mobile-sort').click();await flush(page);
        await until(page,s=>!s.samples.mobileTest.sortActive);
        const sorted=await profile(page);
        assert.equal(sorted.samples.mobile.sortJobs,1);
        assert.equal(sorted.samples.mobileTest.scoreCalls,sorted.samples.uniqueDbCount);
        await page.locator('#mobile-sort').click();await flush(page);
        await until(page,s=>!s.samples.mobileTest.sortActive);
        assert.equal((await profile(page)).samples.mobileTest.scoreCalls,sorted.samples.mobileTest.scoreCalls,'Unchanged Sort reuses exact native scores');
        await action(page,'test:historic');await flush(page);
        const historic=await profile(page),[dx,dy,dw]=historic.samples.uniqueDbBounds;
        assert.ok(historic.samples.uniqueDbCount>=11);
        await page.setViewportSize({width:1600,height:1000});
        await page.evaluate(()=>window.__DESKTOP_POB__.setViewport(1));
        const misses=historic.samples.itemTooltipCache.misses;
        for(let row=6;row<11;row++) {
          const position=await point(page,dx+dw*.4,dy+8+row*16);
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:position.x,y:position.y}]});
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          await page.waitForTimeout(60);await flush(page);
        }
        const browsed=await profile(page);
        assert.equal(browsed.samples.itemTooltipCache.misses,misses,'Unique database taps never start comparisons');
        assert.equal(browsed.filesystem.abyss.loads,0,'Abyss item text must not fetch lookup data');
      }
      await cdp.detach();
      const exported = await canonical(page);
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors),[]);
      results.push({name,profile:policy.kind,viewport:view,exported});
    } finally { await context.close(); }
  }
  console.log(JSON.stringify({passed:true,devices:results},null,2));
} finally { await browser.close(); }
