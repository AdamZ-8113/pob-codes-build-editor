-- Opt-in aggregate diagnostics; never retain build, item, or filesystem strings.
local enabled = false
local samples = { MAIN = {}, CALCS = {}, heatmap = {} }
local totals = { MAIN = {0,0,0}, CALCS = {0,0,0}, heatmap = {0,0,0} }
local wrapped = setmetatable({}, { __mode = 'k' })
local activeTab
local activeBuild
local function record(kind, elapsed)
    local values = samples[kind]
    if not values then return end
    local total = totals[kind]
    total[1], total[2], total[3] = total[1] + 1, total[2] + elapsed, math.max(total[3], elapsed)
    if #values >= 128 then table.remove(values, 1) end
    values[#values + 1] = elapsed
end
function getRuntimeProfile(reset)
    enabled = true
    local fields = {}
    for _, kind in ipairs({'MAIN', 'CALCS', 'heatmap'}) do
        local values = {}
        for _, value in ipairs(samples[kind]) do values[#values + 1] = tostring(value) end
        fields[#fields + 1] = '"' .. kind .. '":[' .. table.concat(values, ',') .. ']'
    end
    local result = '{' .. table.concat(fields, ',') .. '}'
    local summary = {}
    for _, kind in ipairs({'MAIN', 'CALCS', 'heatmap'}) do
        local t = totals[kind]
        summary[#summary + 1] = '"' .. kind .. '":{"count":' .. t[1] .. ',"totalMs":' .. t[2] .. ',"maxMs":' .. t[3] .. '}'
    end
    result = result:sub(1,-2) .. ',"summary":{' .. table.concat(summary, ',') .. '},"heatmapPending":' .. tostring(activeTab ~= nil and activeTab.powerBuilder ~= nil) .. '}'
    if getCalculationSchedulingProfile then result = result:sub(1,-2) .. ',"scheduler":' .. getCalculationSchedulingProfile() .. '}' end
    if getUniqueComparisonProfile then result = result:sub(1,-2) .. ',"uniqueComparisons":' .. getUniqueComparisonProfile() .. '}' end
    if getItemTooltipCacheProfile then result = result:sub(1,-2) .. ',"itemTooltipCache":' .. getItemTooltipCacheProfile() .. '}' end
    local loaded = 0
    for family = 1, 11 do
        local lut = data and data.timelessJewelLUTs and data.timelessJewelLUTs[family]
        if lut and lut.data then loaded = loaded + 2 ^ (family - 1) end
    end
    result = result:sub(1,-2) .. ',"luaKiB":' .. collectgarbage('count') .. ',"timelessLoadedMask":' .. loaded .. ',"gcPause":' .. (runtimeGCPolicy and runtimeGCPolicy.pause or 400) .. '}'
    local db = activeBuild and activeBuild.itemsTab and activeBuild.itemsTab.controls.uniqueDB
    if db and db.controls and db.controls.search and db.GetPos and db.GetSize then
        -- Off-screen tabs may not have resolved their layout anchors yet.
        local ok, bounds = pcall(function()
            local x, y = db:GetPos()
            local w, h = db:GetSize()
            local sx, sy = db.controls.search:GetPos()
            local sw, sh = db.controls.search:GetSize()
            local values = {x,y,w,h,sx,sy,sw,sh}
            for i = 1, 8 do assert(type(values[i]) == 'number') end
            return table.concat(values, ',')
        end)
        if ok then result = result:sub(1,-2) .. ',"uniqueDbBounds":[' .. bounds .. '],"uniqueDbCount":' .. #(db.list or {}) .. '}' end
    end
    if reset then
        samples = { MAIN = {}, CALCS = {}, heatmap = {} }
        totals = { MAIN = {0,0,0}, CALCS = {0,0,0}, heatmap = {0,0,0} }
    end
    return result
end
return function(build)
    activeBuild = build
    local tab = build.calcsTab
    activeTab = tab
    if not tab or type(tab.BuildPower) ~= 'function' or not tab.calcs or type(tab.calcs.buildOutput) ~= 'function' then
        error('Desktop profiling adapter: unsupported calculation interface')
    end
    local calcs = tab.calcs
    if not wrapped[calcs] then
        wrapped[calcs] = true
        local original = calcs.buildOutput
        calcs.buildOutput = function(build, mode, ...)
            if not enabled then return original(build, mode, ...) end
            local start = GetTime()
            local result = table.pack(original(build, mode, ...))
            record(mode, GetTime() - start)
            return table.unpack(result, 1, result.n)
        end
    end
    if not wrapped[tab] then
        wrapped[tab] = true
        local original = tab.BuildPower
        tab.BuildPower = function(self, ...)
            if not enabled then return original(self, ...) end
            local start = GetTime()
            local result = table.pack(original(self, ...))
            record('heatmap', GetTime() - start)
            return table.unpack(result, 1, result.n)
        end
    end
end
