import { chromium } from '@playwright/test';
import { browserChannel } from "../../scripts/lib/browser-channel.mjs";
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalExportTree } from '../../scripts/lib/canonical-export.mjs';
import { applyJewelSpecPatch } from '../../scripts/patches/jewel-spec-patch.mjs';
import { applyItemComparisonPatch } from '../../scripts/patches/item-comparison-patch.mjs';
import { blobHash } from '../../scripts/patches/gem-hover-patch.mjs';

// Functional acceptance only. Authoritative PoB unique objects are inserted
// into a public build in isolated browser memory before its first export.
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(process.argv.slice(2).every(value => /^--(?:build-file|out)=.+$/.test(value)), 'Options: --build-file=<public fixture>, --out=<report>');
const app = new URL('../../', import.meta.url);
const buildFile = argument('build-file');
const code = (await readFile(buildFile ? resolve(buildFile) : new URL('./fixtures/guided import parity desktop 329.txt', app), 'utf8')).trim();
const pin = JSON.parse(await readFile(new URL('source-pin.json', app)));
const patchPin = pin.adapters.calculationOnlyJewelSpecs;
const patch = await readFile(new URL(patchPin.patchFile, app));
const limitedPin = pin.adapters.limitedUniqueItemComparisons;
const limitedPatch = await readFile(new URL(limitedPin.patchFile, app));
const manifest = JSON.parse(await readFile(new URL('.runtime/payload/manifest.json', app)));
const core = manifest.packages.find(pkg => pkg.id === 'core');
const archive = await readFile(new URL(`.runtime/payload/packages/${core.sha256}.zip`, app));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(archive), core.sha256, 'Original package identity');
const require = createRequire(new URL('upstream/deno.json', app));
const AdmZip = require('adm-zip');
const packagedZip = new AdmZip(archive);
const sourceVariants = new Map();
const sourceIdentities = {};
let packagedOverlayPresent;
for (const path of ['Classes/ItemsTab.lua', 'Classes/PassiveSpec.lua']) {
  const pinPath = `src/${path}`;
  // Reconstruct only from the pinned prepared checkout. Never reverse a
  // packaged experimental hunk or accept an unverified local source version.
  const prepared = await readFile(new URL(`.runtime/source-${pin.compositePatch.patchSha256.slice(0,12)}/${pinPath}`, app), 'utf8');
  assert.equal(blobHash(prepared), patchPin.preparedSourceBlobHashes[pinPath], `Prepared source identity: ${path}`);
  const original = path === 'Classes/ItemsTab.lua' ? applyItemComparisonPatch(prepared, limitedPatch, limitedPin) : prepared;
  assert.equal(blobHash(original), patchPin.sourceBlobHashes[pinPath], `Original comparison source identity: ${path}`);
  const candidate = applyJewelSpecPatch(original, patch, patchPin, pinPath);
  const packaged = packagedZip.readAsText(path), packagedHash = blobHash(packaged);
  assert.ok(packagedHash === patchPin.sourceBlobHashes[pinPath] || packagedHash === patchPin.resultBlobHashes[pinPath], `Packaged comparison source identity: ${path}`);
  const present = packagedHash === patchPin.resultBlobHashes[pinPath];
  packagedOverlayPresent ??= present;
  assert.equal(present, packagedOverlayPresent, 'Both packaged source files must use the same overlay state');
  assert.equal(packaged, present ? candidate : original, `Checked reconstructed source must match the packaged result: ${path}`);
  sourceVariants.set(path, { original, candidate });
  sourceIdentities[path] = { prepared: blobHash(prepared), original: blobHash(original), candidate: blobHash(candidate), packaged: packagedHash };
}
const diagnostics = `
do
    local encode = require('dkjson').encode
    local active, fixture, installed, drawn
    local prepared = setmetatable({}, {__mode='k'})
    local widths, types, outputs, scales = {}, {}, {}, {}
    local add, draw = ItemsTabClass.AddItemTooltip, ItemsTabClass.Draw
    local tooltipClass = getmetatable(new('Tooltip'):Tooltip())
    local tooltipDraw = tooltipClass.Draw
    tooltipClass.Draw = function(self, ...)
        if #self.lines > 0 then drawn = self end
        return tooltipDraw(self, ...)
    end
    function recordJewelSpecTestScale(spec, nodeId, distance, effect, scale)
        if active then
            local key = tostring(nodeId)..':'..tostring(distance)..':'..tostring(effect)..':'..tostring(scale)..':'..tostring(spec == active.build.spec)
            scales[key] = {nodeId=nodeId, distance=distance, effect=effect, scale=scale, main=spec == active.build.spec}
        end
    end
    -- The real constructed class is available once ItemsTab's build exists.
    local calculatorInstalled, calculatorWrapper = false, nil
    local function installCalculator(self)
        if calculatorInstalled then self.build.calcsTab.GetMiscCalculator = calculatorWrapper; return end
        calculatorInstalled = true
        local class = getmetatable(self.build.calcsTab)
        local original = class.GetMiscCalculator
        calculatorWrapper = function(tab)
            local calculate, base = original(tab)
            return function(override, ...)
                local output = calculate(override, ...)
                if override.spec then
                    local values = {}
                    for key, value in pairs(output) do
                        if type(value) == 'number' or type(value) == 'boolean' or type(value) == 'string' then values[key] = value end
                    end
                    local spec = override.spec
                    local node = fixture and spec.nodes[fixture.socketId]
                    outputs[#outputs+1] = {slot=override.repSlotName, distance=node and node.distanceToClassStart,
                        values=values, item=override.repItem and override.repItem.title or 'removed'}
                end
                return output
            end, base
        end
        class.GetMiscCalculator = calculatorWrapper
        self.build.calcsTab.GetMiscCalculator = calculatorWrapper
    end
    local function bounds(control)
        local x,y = control:GetPos(); local w,h = control:GetSize()
        return {x,y,w,h}
    end
    local function ensureFixture(self)
        if prepared[self.items] then fixture = prepared[self.items]; return end
        if main.uniqueDB.loading then return end
        local items = {}
        for _, title in ipairs({'Split Personality', 'Thread of Hope', 'Lethal Pride'}) do
            local unique = assert(main.uniqueDB.byTitle[title:lower()], 'Authoritative unique missing')
            local item = new('Item'):Item(unique.raw, 'UNIQUE')
            -- Keep all fixture jewels visible so scrolling cannot warm a
            -- neighbouring comparison before this test samples it.
            self:AddItem(item, true, 1)
            items[title] = item.id
        end
        self:PopulateSlots()
        local slots = {}
        for _, slot in pairs(self.slots) do
            local node = slot.nodeId and self.build.spec.allocNodes[slot.nodeId]
            if node and self.build.spec.tree.nodes[slot.nodeId] and slot.shown() then slots[#slots+1] = slot end
        end
        table.sort(slots, function(a,b) return a.nodeId < b.nodeId end)
        local slot = assert(slots[1], 'Public fixture needs an allocated tree socket')
        slot:SetSelItemId(items['Split Personality'])
        self:PopulateSlots()
        self.build.spec:BuildAllDependsAndPaths()
        local item, node = self.items[items['Split Personality']], self.build.spec.nodes[slot.nodeId]
        assert(item.jewelData.jewelIncEffectFromClassStart > 0, 'Split Personality effect must be active')
        assert(node.alloc and node.distanceToClassStart > 0, 'Split Personality socket must have a real allocated distance')
        fixture = {items=items, socketId=slot.nodeId, slotName=slot.slotName}
        prepared[self.items] = fixture
        self.build.buildFlag = true
    end
    ItemsTabClass.AddItemTooltip = function(self, tooltip, item, ...)
        local result = table.pack(add(self, tooltip, item, ...))
        types[tooltip] = item.title
        local samples = {}
        for _, line in ipairs(tooltip.lines) do
            if line.text then samples[#samples+1] = DrawStringWidth(line.size, line.font or 'VAR', line.text) end
        end
        widths[tooltip] = samples
        return table.unpack(result, 1, result.n)
    end
    ItemsTabClass.Draw = function(self, ...)
        active, drawn = self, nil
        ensureFixture(self)
        if fixture then installCalculator(self) end
        local result = table.pack(draw(self, ...))
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local original = profile(reset)
                local state = {ready=fixture ~= nil, outputs=outputs, scales={}, lines={}, widths=widths[drawn] or {}}
                for _, value in pairs(scales) do state.scales[#state.scales+1] = value end
                if fixture then
                    local list, spec = active.controls.itemList, active.build.spec
                    local item, node = active.items[fixture.items['Split Personality']], spec.nodes[fixture.socketId]
                    state.socketId, state.distance, state.effect = fixture.socketId, node.distanceToClassStart, item.jewelData.jewelIncEffectFromClassStart
                    state.scale = 1 + state.distance * state.effect / 100
                    state.allocated, state.equippedSplit = node.alloc, spec.jewels[fixture.socketId] == item.id
                    local evaluated = active.build.calcsTab.mainEnv.player.itemList[fixture.slotName]
                    state.mainItem = evaluated and evaluated.title
                    state.selectedItem = active.slots[fixture.slotName].selItemId
                    state.splitItemId, state.buildFlag = item.id, active.build.buildFlag
                    state.slotBounds = bounds(active.slots[fixture.slotName])
                    state.listBounds, state.rowHeight = bounds(list), list.rowHeight
                    state.scrollOffset, state.rowLabelOffset = list.controls.scrollBarV.offset, list.colLabels and 18 or 0
                    state.indices = {}
                    for index, id in ipairs(list.list) do
                        for title, itemId in pairs(fixture.items) do if id == itemId then state.indices[title] = index end end
                    end
                    state.screenWidth, state.screenHeight = GetVirtualScreenSize()
                    state.drawnTitle = types[drawn]
                    state.drawnKind = drawn == list.tooltip and 'list' or drawn == active.slots[fixture.slotName].tooltip and 'slot' or 'other'
                    for _, line in ipairs(drawn and drawn.lines or {}) do
                        state.lines[#state.lines+1] = {text=line.text, size=line.size, font=line.font, height=line.height, center=line.center, block=line.block}
                    end
                end
                if reset then outputs, scales = {}, {} end
                return original:sub(1,-2) .. ',"jewelSpecTest":' .. encode(state) .. '}'
            end
        end
        return table.unpack(result, 1, result.n)
    end
end
`;
const scaleAnchor = '\t\t\t\t\tscale = scale + node.distanceToClassStart * (item.jewelData.jewelIncEffectFromClassStart / 100)';
const packages = [false, true].map(candidate => {
  const updatedManifest = structuredClone(manifest), entry = updatedManifest.packages.find(pkg => pkg.id === 'core');
  const zip = new AdmZip(archive);
  for (const path of ['Classes/ItemsTab.lua', 'Classes/PassiveSpec.lua', 'Modules/CalcSetup.lua']) {
    let source = zip.readAsText(path);
    if (path !== 'Modules/CalcSetup.lua') source = sourceVariants.get(path)[candidate ? 'candidate' : 'original'];
    if (path === 'Classes/ItemsTab.lua') source += '\n' + diagnostics;
    if (path === 'Modules/CalcSetup.lua') {
      assert.equal(source.split(scaleAnchor).length, 2, 'Observe the authoritative CalcSetup scale calculation exactly once');
      source = source.replace(scaleAnchor, scaleAnchor + '\n\t\t\t\t\tif recordJewelSpecTestScale then recordJewelSpecTestScale(env.spec, slot.nodeId, node.distanceToClassStart, item.jewelData.jewelIncEffectFromClassStart, scale) end');
    }
    const bytes = Buffer.from(source), file = entry.files.find(file => file.path === path);
    entry.uncompressedBytes += bytes.length - file.bytes; file.bytes = bytes.length; zip.updateFile(path, bytes);
  }
  const bytes = zip.toBuffer(); entry.bytes = bytes.length; entry.sha256 = sha256(bytes);
  return { manifest: updatedManifest, bytes, hash: entry.sha256 };
});
const browser = await chromium.launch({ headless: true, channel: browserChannel() });
const results = [];
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value;
let nativeSource, nativeWasm;
try {
  for (const [mode, payload] of packages.entries()) {
    console.error(`Jewel comparison context: ${mode ? 'candidate' : 'original'}`);
    const context = await browser.newContext({ viewport: { width: 1800, height: 1100 } });
    try {
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/payload/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload.manifest) }));
      await context.route(`**/payload/packages/${payload.hash}.zip`, route => route.fulfill({ contentType: 'application/octet-stream', body: payload.bytes }));
      for (const name of ['driver.mjs', 'driver.wasm']) await context.route(`**/dist/release/${name}*`, async route => {
        if (name === 'driver.mjs') {
          nativeSource ??= 'Date.now = () => 1790812800000;\n' + await (await route.fetch()).text();
          await route.fulfill({ contentType: 'text/javascript', body: nativeSource });
        } else {
          nativeWasm ??= await (await route.fetch()).body();
          await route.fulfill({ contentType: 'application/wasm', body: nativeWasm });
        }
      });
      const page = await context.newPage();
      const faults = []; page.on('pageerror', error => faults.push(error.message));
      await page.goto('http://127.0.0.1:3010/?helpers=0&payloadPrefetch=0');
      await page.waitForFunction(() => window.__DESKTOP_POB__?.ready, null, { timeout: 30000 });
      const flush = () => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
      const profile = async (reset = false) => (await page.evaluate(value => window.__DESKTOP_POB__.getRuntimeProfile(value), reset)).samples.jewelSpecTest;
      const exportHash = async () => {
        const exported = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
        const xml = inflateSync(Buffer.from(exported, 'base64url')).toString();
        const tree = await page.evaluate(value => {
          const root = new DOMParser().parseFromString(value, 'application/xml');
          const walk = node => node.nodeType === 1 ? [node.tagName, [...node.attributes].map(attr => [attr.name, attr.value]), [...node.childNodes].map(walk).filter(value => value !== null)] : node.textContent.trim() || null;
          return walk(root.documentElement);
        }, xml);
        return sha256(JSON.stringify(canonicalExportTree(tree)));
      };
      const scenes = [];
      let initialExport;
      for (let imported = 0; imported < 2; imported++) {
        await page.evaluate(value => window.__DESKTOP_POB__.loadBuildFromCode(value), code);
        await page.keyboard.press('Control+3'); await flush();
        await page.waitForFunction(async () => (await window.__DESKTOP_POB__.getRuntimeProfile()).samples.jewelSpecTest?.ready, null, { timeout: 30000 });
        // Native frames are demand driven. Setup changes buildFlag during the
        // first Items draw; a subsequent real input must calculate that build.
        for(let step=0;step<20;step++) {
          await page.mouse.move(1700+step%2,950); await flush();
          const current=await profile();
          if(current.ready && current.mainItem==='Split Personality' && !current.buildFlag) break;
          await page.waitForTimeout(50);
        }
        const setupErrors=await page.evaluate(()=>window.__DESKTOP_POB__.errors);
        assert.equal(setupErrors.length,0,`Public fixture setup must have no runtime errors (${JSON.stringify(setupErrors)})`);
        const state = await profile();
        assert.ok(state.allocated && state.equippedSplit && state.distance > 0 && state.effect > 0 && state.scale > 1, `Fixture must exercise allocated Split Personality scaling (${JSON.stringify({ ready:state.ready, allocated:state.allocated,equipped:state.equippedSplit,distance:state.distance,effect:state.effect,scale:state.scale, mainItem:state.mainItem, selectedItem:state.selectedItem, splitItemId:state.splitItemId, buildFlag:state.buildFlag })})`);
        assert.ok(state.scales.some(record => record.main && record.nodeId === state.socketId && record.scale === state.scale), `Actual CalcSetup must apply the nonzero main-build scaling (${JSON.stringify({ socketId: state.socketId, scale: state.scale, records: state.scales, mainItem: state.mainItem, selectedItem: state.selectedItem, splitItemId: state.splitItemId, buildFlag: state.buildFlag })})`);
        const canonical = await exportHash(); initialExport ??= canonical;
        assert.equal(canonical, initialExport, 'Repeated import must insert identical fixture items exactly once');
        const point = async (x,y) => {
          const rect = await page.locator('canvas').boundingBox(), current = await profile();
          return {x:rect.x+x*rect.width/current.screenWidth,y:rect.y+y*rect.height/current.screenHeight};
        };
        for (const title of ['Split Personality', 'Thread of Hope', 'Lethal Pride', 'equipped Split Personality']) {
          await profile(true);
          let current = await profile(), target;
          if (title.startsWith('equipped')) {
            const [x,y] = current.slotBounds; target = await point(x+80,y+8);
          } else {
            for (let step=0; step<70; step++) {
              current = await profile();
              const [x,y,w,h] = current.listBounds;
              const offset=(current.indices[title]-1)*current.rowHeight-current.scrollOffset+current.rowLabelOffset;
              if (offset>=0 && offset+current.rowHeight<h-4) { target=await point(x+w*.45,y+2+offset+current.rowHeight*.5); break; }
              const position=await point(x+w-8,y+h*.5);
              await page.mouse.move(position.x,position.y); await page.mouse.wheel(0,offset<0?-100:100); await flush();
            }
          }
          assert.ok(target, `Requested authoritative jewel must be visible (${JSON.stringify({title,indices:current.indices,rowHeight:current.rowHeight,scrollOffset:current.scrollOffset,bounds:current.listBounds})})`);
          const outside=await point(current.screenWidth-20,current.screenHeight-20);
          await page.mouse.move(outside.x,outside.y); await flush();
          await page.mouse.move(target.x,target.y); await flush(); await page.mouse.move(target.x+1,target.y); await flush();
          const result=await profile();
          assert.equal(result.drawnTitle,title.replace('equipped ',''),'Requested native tooltip must draw');
          assert.equal(result.drawnKind,title.startsWith('equipped')?'slot':'list');
          assert.ok(result.lines.length>0 && result.widths.length>0,'Complete tooltip and native layout must be present');
          assert.equal(await exportHash(),initialExport,'Jewel comparisons must preserve all exported build state');
          const scaling=result.scales.map(normalize).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
          scenes.push({title,imported,tooltipHash:sha256(JSON.stringify(normalize(result.lines))),layoutHash:sha256(JSON.stringify(result.widths)),outputHash:sha256(JSON.stringify(normalize(result.outputs))),
            scalingHash:sha256(JSON.stringify(scaling)),distance:result.distance,effect:result.effect,scale:result.scale,calculations:result.outputs.length,scalingRecords:scaling.length});
        }
      }
      assert.equal(faults.length,0,'No browser page errors');
      assert.equal((await page.evaluate(()=>window.__DESKTOP_POB__.errors)).length,0,'No PoB runtime errors');
      results.push({exportHash:initialExport,scenes});
    } finally { await context.close(); }
  }
  assert.deepEqual(results[1],results[0],'Candidate must preserve complete tooltips, layouts, scalar calculator outputs, actual scales, distances and canonical exports');
  assert.ok(results[0].scenes.filter(scene=>!scene.title.startsWith('equipped')).some(scene=>scene.calculations>0 && scene.scalingRecords>0),'Cold native jewel hover must exercise comparison specs with actual Split Personality scaling');
  const report={status:'passed',scope:'Functional parity only; public authoritative-jewel fixture, no performance claim',runtimeSha256:sha256(nativeWasm),packagedCoreSha256:core.sha256,packagedOverlayPresent,sourceIdentities,cases:results[0].scenes,exactCanonicalExport:true};
  if(argument('out')) { const output=resolve(argument('out')); await mkdir(dirname(output),{recursive:true}); await writeFile(output,JSON.stringify(report,null,2)+'\n'); }
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
