-- Host adapter only. The packaged PoB headless wrapper owns initialization.
package.path = package.path .. ';/app/root/lua/?.lua;/app/root/lua/?/init.lua'
unpack, loadstring = table.unpack, load
bit = { lshift=bit32.lshift, rshift=bit32.rshift, band=bit32.band, bor=bit32.bor,
    bxor=bit32.bxor, bnot=bit32.bnot, tobit=function(n) n=n%0x100000000; return n>=0x80000000 and n-0x100000000 or n end }
jit = { opt = { start=function() end, stop=function() end } }
arg = {}
local nativeInflate, nativeDeflate, nativeTime = Inflate, Deflate, GetTime
local realDofile = dofile
function dofile(path)
    local result = realDofile(path)
    if path == '_SimpleGraphic.def.lua' then
        Inflate, Deflate, GetTime = nativeInflate, nativeDeflate, nativeTime
        GetUserPath = function() return '' end
    end
    return result
end
dofile('HeadlessWrapper.lua')
assert(build and not __mainObject__.promptMsg, 'Helper PoB boot failed')
local json = require('dkjson')
local loadedIdentity, operation, calc, calcBase, loadedKind
-- One parsed object per immutable database key; scores are always recalculated.
-- PoB itself retains this database across builds. Raw equality also captures
-- variants/quality and any other candidate edits from the displayed UI.
local candidates = {}
function helperCall(text)
    local job = assert(json.decode(text))
    runtimeGCPolicy.applyWorkload(job.kind == 'nodePower' and 'nodePower' or 'unique')
    if job.xml then
        loadBuildFromXML(job.xml, 'Calculation helper')
        assert(not __mainObject__.promptMsg, 'Helper import failed')
        local started = GetTime()
        while job.kind ~= 'nodePower' and __mainObject__.main.uniqueDB.loading do
            runCallback('OnFrame')
            assert(GetTime() - started < 15000, 'Helper unique database timeout')
        end
        loadedIdentity = job.identity
        loadedKind = job.kind
        operation, calc = nil, nil
        collectgarbage('collect')
        return json.encode({ready=true})
    end
    assert(loadedIdentity == job.identity, 'Stale helper build')
    if job.kind == 'nodePower' then
        assert(loadedKind == job.kind and build.calcsTab.EvaluateNodePowerItem, 'Missing node-power seam')
        assert(job.metric == 'Hit DPS', 'Prototype supports Hit DPS only')
        for _, stat in ipairs(data.powerStatList) do
            if stat.label == job.metric then build.calcsTab.powerStat = stat; break end
        end
        if operation ~= job.operation then
            calc, calcBase = build.calcsTab:GetMiscCalculator()
            operation = job.operation
        end
        local function resolveNode(ref)
            if ref.cluster then return assert(build.spec.tree.clusterNodeMap[ref.cluster]) end
            local node = assert(build.spec.nodes[ref.id], 'Missing helper node')
            if not ref.effect then return node end
            local effect = assert(build.spec.tree.masteryEffects[ref.effect])
            local value = {id=node.id, type=node.type, name=node.name, sd={}}
            for i, sd in ipairs(effect.sd or {}) do value.sd[i] = sd end
            build.spec.tree:ProcessStats(value)
            return value
        end
        local result = {}
        for index, item in ipairs(job.items) do
            local args = {}
            for _, key in ipairs({'addNodes', 'removeNodes'}) do
                if item[key] then
                    args[key] = {}
                    for _, ref in ipairs(item[key]) do args[key][resolveNode(ref)] = true end
                end
            end
            local value = build.calcsTab:EvaluateNodePowerItem(args, calc, calcBase)
            result[index] = {}
            for key, number in pairs(value) do result[index][key] = string.format('%.17g', number) end
        end
        local encoded = json.encode(result)
        collectgarbage('collect')
        return encoded
    end
    local db = build.itemsTab.controls.uniqueDB
    db:SetSortMode(job.sortMode)
    assert(db.sortDetail and db.sortDetail.stat and db.EvaluateItemPower, 'Unsupported helper evaluator')
    build.itemsTab.activeItemSet.useSecondWeaponSet = job.weaponSet
    if operation ~= job.operation then
        calc = build.calcsTab:GetMiscCalculator(db.build)
        operation = job.operation
    end
    local result = {}
    for index, candidate in ipairs(job.items) do
        assert(db.db.list[candidate.key], 'Helper candidate not found')
        local cached = candidates[candidate.key]
        if not cached or cached.raw ~= candidate.raw then
            cached = {raw=candidate.raw, item=new('Item'):Item(candidate.raw, 'UNIQUE', true)}
            candidates[candidate.key] = cached
        end
        local item = cached.item
        assert(item.base, 'Helper candidate could not be parsed')
        local value = db:EvaluateItemPower(item, calc, db.sortDetail.stat == 'FullDPS')
        -- Lua's default number-to-string conversion loses double precision.
        -- Preserve all bits across JSON so equal UI/helper scores remain ties.
        result[index] = value == -math.huge and '-inf' or string.format('%.17g', value)
    end
    local encoded = json.encode(result)
    collectgarbage('collect')
    return encoded
end
