// Hash-consistent in-memory acceptance packages; no test diagnostics are shipped.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { canonicalExportTree } from './canonical-export.mjs';
const require = createRequire(new URL('upstream/deno.json', import.meta.url));
const AdmZip = require('adm-zip');
const hash = b => createHash('sha256').update(b).digest('hex');

export async function instrument(context, baseline, extra = '') {
  const directory = baseline ?? new URL('.runtime/payload/', import.meta.url);
  const file = name => baseline ? join(directory, name) : new URL(name, directory);
  const manifest = JSON.parse(await readFile(file('manifest.json')));
  const core = manifest.packages.find(p => p.id === 'core');
  const original = await readFile(file(`packages/${core.sha256}.zip`));
  assert.equal(hash(original), core.sha256);
  const zip = new AdmZip(original);
  const diagnostic = await readFile(new URL('item-hover-profile.lua', import.meta.url), 'utf8');
  const source = Buffer.from(zip.readAsText('Classes/ItemsTab.lua') + '\n' + diagnostic + '\n' + extra);
  zip.updateFile('Classes/ItemsTab.lua', source);
  const member = core.files.find(f => f.path === 'Classes/ItemsTab.lua');
  core.uncompressedBytes += source.length - member.bytes; member.bytes = source.length;
  const bytes = zip.toBuffer(); core.bytes = bytes.length; core.sha256 = hash(bytes);
  await context.routeWebSocket('**', socket => socket.close());
  await context.route('**/payload/manifest.json', route => route.fulfill({json: manifest}));
  if (baseline) for (const pkg of manifest.packages.filter(p => p.id.startsWith('timeless-abyss'))) {
    const body = await readFile(file(`packages/${pkg.sha256}.zip`));
    assert.equal(hash(body), pkg.sha256);
    await context.route(`**/payload/packages/${pkg.sha256}.zip`, route => route.fulfill({body}));
  }
  await context.route(`**/payload/packages/${core.sha256}.zip`, route => route.fulfill({body: bytes}));
  await context.route('**/dist/release/driver.mjs*', async route => route.fulfill({contentType:'text/javascript',
    body: 'Date.now = () => 1790812800000;\n' + await (await route.fetch()).text()}));
  return {pin: manifest.sourceRevision, core: core.sha256};
}
export const fixture = async () => (await readFile(new URL('./fixtures/guided import parity desktop 329.txt', import.meta.url),'utf8')).trim();
export const flush = page => page.evaluate(() => window.__DESKTOP_POB__.flushInput());
export const profile = (page, reset = false) => page.evaluate(reset => window.__DESKTOP_POB__.getRuntimeProfile(reset), reset);
export async function action(page, name) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(name => window.__DESKTOP_POB__.requestMobileAction(name), name),
      new Promise((_,reject)=>{timer=setTimeout(async()=>reject(new Error(`Native action timed out: ${name}; ${JSON.stringify(await page.evaluate(()=>window.__DESKTOP_POB__.errors))}`)),60000);}),
    ]);
  } finally {clearTimeout(timer);}
}
export async function until(page, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (!predicate(await profile(page))) {
    assert.ok(Date.now() < deadline, 'Native operation timed out');
    assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
    await page.waitForTimeout(30); await flush(page);
  }
}
export async function boot(page, origin, code) {
  await page.goto(origin);
  await page.waitForFunction(() => window.__DESKTOP_POB__?.ready || window.__DESKTOP_POB__?.errors.length, null, {timeout: 120000});
  assert.deepEqual(await page.evaluate(() => window.__DESKTOP_POB__.errors), []);
  if (code) await page.evaluate(code => window.__DESKTOP_POB__.loadBuildFromCode(code), code);
  await page.keyboard.press('Control+3'); await flush(page);
  await until(page, p => p.samples.uniqueDbCount > 0);
}
export async function canonical(page) {
  const code = await page.evaluate(() => window.__DESKTOP_POB__.getBuildCode());
  const xml = inflateSync(Buffer.from(code,'base64url')).toString();
  const tree = await page.evaluate(xml => {
    const root = new DOMParser().parseFromString(xml, 'application/xml');
    const walk = node => node.nodeType === 1 ? [node.tagName, [...node.attributes].map(a => [a.name,a.value]),
      [...node.childNodes].map(walk).filter(v => v !== null)] : node.textContent.trim() || null;
    return walk(root.documentElement);
  }, xml);
  return hash(JSON.stringify(canonicalExportTree(tree)));
}
export async function point(page, x, y) {
  const canvas = page.locator('canvas'), box = await canvas.boundingBox();
  const size = await canvas.evaluate(c => [parseFloat(c.style.width), parseFloat(c.style.height)]);
  return {x: box.x + x*box.width/size[0], y: box.y+y*box.height/size[1]};
}

export const testCommands = `
do
  local active, installed, lookups = nil, false, {}
  local scoreCalls, scoreMs, listJobs = 0, 0, 0
  local wrapped = setmetatable({}, {__mode='k'})
  local draw = ItemsTabClass.Draw
  ItemsTabClass.Draw = function(self, ...)
    active = self
    local db = self.controls.uniqueDB
    if db and not wrapped[db] then
      wrapped[db]=true
      local evaluate = db.EvaluateItemPower
      db.EvaluateItemPower = function(control,...)
        local at=GetTime(); local result=table.pack(evaluate(control,...))
        scoreCalls,scoreMs=scoreCalls+1,scoreMs+GetTime()-at
        return table.unpack(result,1,result.n)
      end
    end
    if not installed and requestMobileAction and getRuntimeProfile then
      installed = true
      local request, get = requestMobileAction, getRuntimeProfile
      requestMobileAction = function(command)
        local db = active.controls.uniqueDB
        if command == 'test:mode' then db:SetSortMode('FullDPS')
        elseif command == 'test:ring' then db.controls.type:SelByValue('Ring'); db.listBuildFlag = true
        elseif command == 'test:historic' then db:SetSortMode('name');db.controls.type:SelByValue('Any type');db.controls.search:SetText('Historic',true);db.listBuildFlag=true
        elseif command == 'test:reset-filter' then db.controls.type:SelByValue('Any type'); db.listBuildFlag=true
        elseif command:match('^test:lookup:') then
          local _,_,family,seed,socket,bulk = command:find('test:lookup:(%d+):(%d+):(%d+):(%d+)')
          family,seed,socket = tonumber(family),tonumber(seed),tonumber(socket)
          local path = {}; for id in pairs(active.build.spec.allocNodes) do path[id]=true end
          local at=GetTime()
          local nodes=data.readAbyssJewelLUT(seed,socket,family,path,active.build.spec.curAscendClassName,bulk=='1')
          local keys={};for id in pairs(nodes) do keys[#keys+1]=id end; table.sort(keys)
          local records={};for _,id in ipairs(keys) do records[#records+1]={id,nodes[id]} end
          lookups[#lookups+1]={family=family,seed=seed,socket=socket,ms=GetTime()-at,records=records}
        elseif command:match('^test:search:') then
          local family=tonumber(command:match('(%d+)$'))
          local build=active.build; local saved=build.timelessData
          local state=copyTable(saved); state.jewelType={id=family};state.jewelSocket={id=2491}
          if family==11 then
            local sockets={};for id,node in pairs(build.spec.allocNodes) do
              if node.isJewelSocket and build.spec:GetShortestPathToClassStart(id) then sockets[#sockets+1]=id end
            end
            table.sort(sockets);assert(sockets[1],'Public fixture needs an allocated Zorath path');state.jewelSocket={id=sockets[1]}
          end
          local names={[7]='abyss_murderous',[8]='abyss_searching',[9]='abyss_hypnotic',[10]='abyss_ghastly',[11]='abyss_special'}
          local rows={}
          for _,entries in ipairs({build.spec.tree.legion.nodes,build.spec.tree.legion.additions}) do
            for _,node in ipairs(entries) do if node.id:match('^'..names[family]..'_') and not node.ks then rows[#rows+1]=node.id..',1.25,0.75' end end
          end
          state.searchList=table.concat(rows,'\\n');state.searchListFallback='';state.searchResults={};state.sharedResults={}
          build.timelessData=state;build.treeTab:FindTimelessJewel()
          local popup=main.popups[1];local before=collectgarbage('count');local at=GetTime()
          popup.controls.searchButton.onClick()
          local elapsed=GetTime()-at;local results={}
          for _,r in ipairs(state.searchResults) do
            local row={seed=r.seed,total=string.format('%.17g',r.total)}
            -- Native list already owns result order and eligibility.
            results[#results+1]=row
          end
          lookups[#lookups+1]={search=family,socket=state.jewelSocket.id,ms=elapsed,results=results,count=#results,luaKiB=collectgarbage('count')-before,weights=#rows}
          main:ClosePopup();build.timelessData=saved
        elseif command:match('^test:scan:') then
          local family=tonumber(command:match('(%d+)$'))
          local path={}; for id in pairs(active.build.spec.allocNodes) do path[id]=true end
          local at=GetTime();local count,hash=0,5381
          for seed=100,8000 do
            local nodes=data.readAbyssJewelLUT(seed,2491,family,path,active.build.spec.curAscendClassName,true)
            local ids={};for id in pairs(nodes) do ids[#ids+1]=id end;table.sort(ids)
            for _,id in ipairs(ids) do
              hash=(hash*33+id)%4294967296;count=count+1
              for _,component in ipairs(nodes[id]) do
                hash=(hash*33+component.type)%4294967296
                hash=(hash*33+component.id)%4294967296
                for _,roll in ipairs(component.rolls) do hash=(hash*33+roll)%4294967296 end
              end
            end
          end
          lookups[#lookups+1]={scan=family,ms=GetTime()-at,count=count,hash=hash}
        elseif command == 'test:level' then active.build.controls.characterLevel:SetText('73',true)
        else return request(command) end
        RequestFrames(2)
      end
      getRuntimeProfile = function(reset)
        local result=get(reset)
        local db=active.controls.uniqueDB
        local scores={}; for _,item in ipairs(db.list or {}) do scores[#scores+1]={item.name,item.measuredPower and string.format('%.17g',item.measuredPower) or tostring(item.measuredPower)} end
        local state={lookups=lookups,scores=scores,mode=db.sortMode,sortActive=db.listBuilder~=nil or db.listBuildFlag or false,scoreCalls=scoreCalls,scoreMs=scoreMs,listJobs=listJobs}
        if reset then lookups={};scoreCalls,scoreMs,listJobs=0,0,0 end
        return result:sub(1,-2)..',"mobileTest":'..require('dkjson').encode(state)..'}'
      end
    end
    return draw(self,...)
  end
end
`;
