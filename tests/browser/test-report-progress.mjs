import { chromium } from '@playwright/test';
import { browserChannel } from '../../scripts/lib/browser-channel.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadBuildInput, readCorePackage, rewriteCorePackage, routeCorePackage } from '../../tools/profiles/core-package-overlay.mjs';

const origin = 'http://127.0.0.1:3010/';
const input = await loadBuildInput({ buildFile: fileURLToPath(new URL('../../fixtures/guided import parity desktop 329.txt', import.meta.url)) });
const diagnostics = 'local observedToastIds = {}\n' + (await readFile(new URL('../../tools/profiles/heatmap-profile.lua', import.meta.url), 'utf8')).replace(
  'state.toastShown =', `local unique = active.build.itemsTab.controls.uniqueDB
                    state.controls.itemSort = controlState(unique.controls.sort)
                    state.itemSortMessage = unique.defaultText
                    state.itemSortPending = unique.listBuilder ~= nil or unique.listBuildFlag or false
                    state.itemCount = #(unique.list or {})
                    local id = active.powerBuilderToastId
                    if id then observedToastIds[id] = true end
                    local toast = id and ToastNotification:Get(id)
                    state.toastMessage = toast and toast.message
                    state.toastMode = toast and toast.mode
                    state.reportToasts = 0
                    for seen in pairs(observedToastIds) do
                        local entry = ToastNotification:Get(seen)
                        if entry and entry.mode ~= 'HIDING' then state.reportToasts = state.reportToasts + 1 end
                    end
                    state.toastShown =`);
const overlay = rewriteCorePackage(await readCorePackage(origin), [{path:'Classes/TreeTab.lua', transform: text => text + '\n' + diagnostics}]);
const browser = await chromium.launch({headless:true, channel:browserChannel()});
try {
  for (const helpers of [true, false]) {
    const context = await browser.newContext({viewport:{width:1600,height:1000}});
    try {
      await routeCorePackage(context, overlay);
      let heldReply = false;
      if (helpers) await context.route(/\/src\/js\/worker\.ts\?worker_file/, async route => {
        const response = await route.fetch(), source = await response.text();
        const marker = 'sortRequest({ ...JSON.parse(text), uiBytes: module.HEAPU8.buffer.byteLength })';
        assert.ok(source.includes(marker)); heldReply = true;
        // Guarantee a waiting interval even on fast machines. Work still runs
        // through the real pool, then its result is delayed only in this test.
        await route.fulfill({response, body:source.replace(marker,
          `Promise.all([${marker}, new Promise(resolve => setTimeout(resolve, 3000))]).then(([values]) => values)`)});
      });
      const page = await context.newPage(), faults = [];
      page.on('pageerror', error => faults.push(error.name));
      await page.goto(origin + '?helpers=3&nodePowerHelpers=' + Number(helpers));
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, {timeout:120000});
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), input.buildCode);
      const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      const profile = () => page.evaluate(() => window.__DESKTOP_POB__.getRuntimeProfile());
      const state = async () => (await profile()).samples.nodePower;
      const click = async (x,y) => {
        const canvas = page.locator('canvas'), bounds = await canvas.boundingBox();
        const [width,height] = await canvas.evaluate(c => [c.width,c.height]);
        await page.mouse.click(bounds.x+x*bounds.width/width,bounds.y+y*bounds.height/height); await flush();
      };
      const control = async key => { const [x,y,w,h] = (await state()).controls[key].bounds; await click(x+w/2,y+h/2); };
      const select = async (key,label) => {
        let c = (await state()).controls[key], index = c.options.indexOf(label);
        assert.ok(index >= 0); if (c.selected === index+1) return;
        await control(key); c = (await state()).controls[key];
        const [x,y,w,h] = c.bounds, offset = index*(h-4)-c.scrollOffset;
        assert.ok(offset >= 0 && offset+h-4 <= c.dropHeight);
        await click(x+w/2,(c.dropUp ? y-c.dropHeight-4 : y+h)+offset+(h-4)/2);
      };
      const until = async (predicate, message) => {
        const deadline = performance.now()+120000;
        let s;
        while (!predicate(s=await state())) {
          assert.ok(performance.now()<deadline,message); await page.waitForTimeout(25);
        }
        return s;
      };
      await page.keyboard.press('Control+1'); await flush();
      if (helpers) {
        const deadline = performance.now()+45000;
        while (!(await profile()).helperAvailability.count) {
          assert.ok(performance.now()<deadline,'Helpers ready'); await page.waitForTimeout(100);
        }
        assert.ok(heldReply);
      }
      await select('depth','5'); await control('heatmap'); await control('report');
      const pending = await until(s => s.runs.length && s.toastMode === 'SHOWN', 'Toast fully appears during calculation');
      assert.equal(pending.runs.at(-1).reportReadyAt,undefined,'Indicator appears before completion');
      assert.equal(pending.reportToasts,1);
      if (helpers) {
        assert.match(pending.toastMessage,/^Building Power Report\.\.\. \(\d+%\)$/);
        assert.equal(pending.delegation.completed,false);
        const advanced = await until(s => /\(([1-9]\d*)%\)/.test(s.toastMessage) && !s.delegation.completed,
          'Percentage advances while helpers are still calculating');
        assert.equal(advanced.runs.at(-1).reportReadyAt,undefined);
      }
      // A replacement must retain an indicator and remove the previous toast.
      await select('metric','Life');
      const replacement = await until(s => s.runs.at(-1).id > pending.runs.at(-1).id && s.toastMode === 'SHOWN', 'Restart shows progress');
      assert.equal(replacement.runs.at(-1).reportReadyAt,undefined);
      assert.equal(replacement.reportToasts,1);
      const completed = await until(s => s.runs.at(-1).reportReadyAt, 'Report completes');
      assert.equal(completed.runs.at(-1).reportCallbacks,1);
      assert.equal(completed.toastShown,false);
      assert.equal(completed.reportToasts,0);
      assert.equal(completed.runs.find(r => r.id === pending.runs.at(-1).id).reportCallbacks,0);
      await select('metric','Hit DPS');
      await until(s => s.toastMode === 'SHOWN', 'Next report starts');
      await control('heatmap');
      assert.equal((await state()).reportToasts,0,'Hiding heatmap removes progress');
      await page.waitForTimeout(120);
      await control('heatmap');
      await until(s => s.toastMode === 'SHOWN', 'Reopening pending report restores progress');
      await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), input.buildCode);
      await flush();
      assert.equal((await state()).reportToasts,0,'Import clears the abandoned build toast');
      if (helpers) {
        await page.keyboard.press('Control+3'); await flush();
        await until(s => !s.itemSortPending, 'Unique database is ready');
        await select('itemSort','Sort by Hit DPS');
        const sorting = await until(s => s.itemSortPending && /Sorting\.\.\. \(([1-9]\d*)%\)/.test(s.itemSortMessage),
          'Items sorting displays measured percentage before completion');
        assert.match(sorting.itemSortMessage,/^\^7Sorting\.\.\. \(\d+%\)$/);
        const sorted = await until(s => !s.itemSortPending, 'Unique item sorting completes');
        assert.ok(sorted.itemCount > 0);
        console.log('Items sorting percentage and completion with helpers passed');
      }
      assert.deepEqual(faults,[]);
      assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors),[]);
      console.log(`Persistent report indicator, restart, completion, hide/reopen and import: helpers=${helpers} passed`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
