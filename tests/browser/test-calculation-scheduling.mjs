import { chromium } from '@playwright/test';
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const codeFile = async name => (await readFile(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8')).trim();
const decode = code => inflateSync(Buffer.from(code, 'base64url')).toString();
const normal = await codeFile('guided import parity desktop 329.txt');
const fixtures = [
  ['current', normal],
  ['minion-historical', await codeFile('dominating blow of inspiring guardian 328.txt')],
  ['alternate-historical', await codeFile('lightning strike daughter of oshabi 328 alternate.txt')],
  ['ruthless', deflateSync(decode(normal).replaceAll('treeVersion="3_29"', 'treeVersion="3_29_ruthless"')).toString('base64url')],
];
if (process.argv[3]) fixtures.push(['private-timeless', (await readFile(process.argv[3], 'utf8')).trim()]);
const browser = await chromium.launch({ headless:true, channel: browserChannel() });
const rounds=[];
try {
  for (const [fixture, code] of fixtures) {
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    try {
      const page=await context.newPage();
      page.on('console', message => { if(message.type()==='error'||message.type()==='warning') console.error(message.text().slice(0,1400)); });
      await page.goto('http://127.0.0.1:3010');
      await page.waitForFunction(()=>window.__DESKTOP_POB__?.ready||window.__DESKTOP_POB__?.errors.length,null,{timeout:120000});
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      const canvas=page.locator('canvas');
      const exportXml=async()=>decode(await page.evaluate(()=>window.__DESKTOP_POB__.getBuildCode()));
      const canonical=async xml=>page.evaluate(xml=>{
        const root=new DOMParser().parseFromString(xml,'application/xml');
        const walk=node=>node.nodeType===1 ? [node.tagName,[...node.attributes].map(a=>[a.name,a.value]).sort(),
          [...node.childNodes].map(walk).filter(v=>v!==null)] : node.textContent.trim()||null;
        return JSON.stringify(walk(root.documentElement));
      },xml);
      for(const interaction of fixture==='current'?['character-level','map-mod-effect']:['character-level']) {
        for(let round=0;round<(fixture==='current'?3:1);round++) {
          let expected;
          for(const enabled of [false,true]) {
            await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),code);
            await page.evaluate(enabled=>window.__DESKTOP_POB__.configureCalculationScheduling(enabled),enabled);
            await page.keyboard.press(interaction==='character-level'?'Control+1':'Control+5');
            await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
            const bounds=await canvas.boundingBox(),dims=await canvas.evaluate(c=>({width:c.width,height:c.height}));
            const [x,y]=interaction==='character-level'?[910,16]:[995,234];
            await canvas.click({position:{x:x*bounds.width/dims.width,y:y*bounds.height/dims.height}});
            await page.keyboard.press('Control+a');
            await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
            await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile(true));
            await page.evaluate(()=>window.__DESKTOP_POB__.clearFrameSamples());
            const start=performance.now();
            await page.keyboard.type('73',{delay:65});
            const beforeFlush=await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
            // Export is itself a required flush consumer, without an Enter crutch.
            const xml=await exportXml(),elapsed=performance.now()-start;
            const profile=await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile());
            const frames=await page.evaluate(()=>window.__DESKTOP_POB__.frameSamples);
            assert.equal(profile.samples.scheduler.pending,false);
            assert.equal(await page.locator('#calculation-status').isVisible(),false);
            const edited=interaction==='character-level'?/level="73"/:/name="multiplierMapModEffect"[^>]*number="73"|number="73"[^>]*name="multiplierMapModEffect"/;
            assert.ok(edited.test(xml), `${fixture}/${interaction}/${enabled}: intended control must change`);
            const semantic=await canonical(xml);
            if(!enabled) expected=semantic;
            else assert.ok(semantic===expected,`${fixture}/${interaction}: every exported semantic value must match`);
            rounds.push({fixture,interaction,round,enabled,elapsed,beforeFlush:beforeFlush.samples.summary,
              pendingBeforeFlush:beforeFlush.samples.scheduler.pending,profile,frames,
              semanticSha256:createHash('sha256').update(semantic).digest('hex')});
            // The pinned UI retains top-level edit focus across a host import.
            // Finish this scenario after checking export, before the next load.
            await page.keyboard.press('Enter');
            await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
          }
        }
      }
      if(fixture==='current') {
        let expectedUndo,expectedRedo;
        for(const enabled of [false,true]) {
          await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),code);
          await page.evaluate(enabled=>window.__DESKTOP_POB__.configureCalculationScheduling(enabled),enabled);
          await page.keyboard.press('Control+5'); await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
          await canvas.click({position:{x:995,y:234}});
          await page.keyboard.press('Control+a'); await page.keyboard.type('73',{delay:65});
          await page.keyboard.press('Enter'); await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
          const edited=await canonical(await exportXml());
          await page.keyboard.press('Control+z');
          const undo=await canonical(await exportXml());
          assert.ok(undo!==edited,'Undo must change the edited build');
          await page.keyboard.press('Control+y');
          const redo=await canonical(await exportXml());
          assert.ok(redo===edited,'Redo must restore the complete edited build');
          if(!enabled) {expectedUndo=undo;expectedRedo=redo;}
          else {assert.ok(undo===expectedUndo,'Scheduled undo must match synchronous undo');assert.ok(redo===expectedRedo,'Scheduled redo must match synchronous redo');}
        }
      }
      // First exact details access following an unfinished edit must flush.
      for(const key of ['Enter','Tab','Control+4','Control+3','Control+5']) {
        await page.evaluate(code=>window.__DESKTOP_POB__.loadBuildFromCode(code),code);
        await page.keyboard.press('Control+1');
        await page.evaluate(()=>window.__DESKTOP_POB__.flushInput());
        await canvas.click({position:{x:910,y:16}});
        await page.keyboard.press('Control+a'); await page.keyboard.type('73');
        await page.keyboard.press(key);
        const xml=await exportXml(); assert.ok(/level="73"/.test(xml), `${fixture}/${key}: level must change`);
        assert.equal((await page.evaluate(()=>window.__DESKTOP_POB__.getRuntimeProfile())).samples.scheduler.pending,false);
      }
      assert.deepEqual(await page.evaluate(()=>window.__DESKTOP_POB__.errors),[]);
      console.log(`Calculation exactness passed: ${fixture}`);
    } finally { await context.close(); }
  }
  const report={browser:browser.version(),rounds};
  if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(rounds.map(r=>({fixture:r.fixture,interaction:r.interaction,enabled:r.enabled,
    elapsed:r.elapsed,pending:r.pendingBeforeFlush,main:r.profile.samples.summary.MAIN}))));
} finally { await browser.close(); }
