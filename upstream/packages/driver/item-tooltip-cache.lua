-- Desktop adapter only: leave the packaged PoB calculator and UI untouched.
-- Cache only item-tooltip calls, never passive-tree, crafting or gem calculations.
local function copy(value, seen, stats)
    if type(value) ~= "table" then return value end
    local root = seen == nil
    local start = root and stats and type(GetTime) == 'function' and GetTime()
    if root and stats then stats.copies = stats.copies + 1 end
    seen = seen or {}
    if seen[value] then return seen[value] end
    local result = {}
    seen[value] = result
    if stats then stats.copiedTables = stats.copiedTables + 1 end
    for key, child in pairs(value) do
        if stats then stats.copiedFields = stats.copiedFields + 1 end
        result[key] = copy(child, seen, stats)
    end
    setmetatable(result, getmetatable(value))
    if start then stats.copyMs = stats.copyMs + math.max(0, GetTime() - start) end
    return result
end

local allowed = { repSlotName = true, repItem = true, toggleFlask = true, toggleTincture = true }
local function keyFor(override, useFullDPS)
    if type(override) ~= "table" or getmetatable(override) then return end
    if useFullDPS ~= nil and type(useFullDPS) ~= "boolean" then return end
    for key in pairs(override) do if not allowed[key] then return end end
    local item, kind, slot
    if type(override.repSlotName) == "string" and not override.toggleFlask and not override.toggleTincture then
        item, kind, slot = override.repItem, "replace", override.repSlotName
    elseif override.toggleFlask and not override.repSlotName and not override.repItem and not override.toggleTincture then
        item, kind = override.toggleFlask, "flask"
    elseif override.toggleTincture and not override.repSlotName and not override.repItem and not override.toggleFlask then
        item, kind = override.toggleTincture, "tincture"
    else
        return
    end
    if item ~= nil and (type(item) ~= "table" or type(item.BuildRaw) ~= "function" or not item.baseModList) then return end
    -- BuildModList replaces baseModList even when editing an existing Item object.
    -- BuildRaw also catches pending quality/variant/roll changes before that rebuild.
    return { kind, slot, item, item and item.baseModList, item and item:BuildRaw(), useFullDPS }
end

local function sameKey(a, b)
    for index = 1, 6 do if a[index] ~= b[index] then return false end end
    return true
end

local activeStats
function getItemTooltipCacheProfile()
    local stats = activeStats or {}
    return '{"mode":"' .. (stats.mode or 'none') .. '","hits":' .. (stats.hits or 0)
        .. ',"misses":' .. (stats.misses or 0) .. ',"bypasses":' .. (stats.bypasses or 0)
        .. ',"evictions":' .. (stats.evictions or 0) .. ',"entries":' .. (stats.entries or 0)
        .. ',"copies":' .. (stats.copies or 0) .. ',"copyMs":' .. (stats.copyMs or 0)
        .. ',"copiedTables":' .. (stats.copiedTables or 0) .. ',"copiedFields":' .. (stats.copiedFields or 0) .. '}'
end

-- Record only the primitive AddLine/AddSeparator operations produced by the
-- pinned comparison method. Replay through PoB's real tooltip methods so block
-- layout, fonts, separators and wrapping still use the current tooltip state.
-- This scope also includes PoB's special-jewel spec rebuild on a cold miss;
-- arbitrary calculator overrides remain unsupported by the calculator cache.
local function installOperationCache(build, limit, stats)
    local items, calcs = build.itemsTab, build.calcsTab
    local original = items.AddItemStatDifferences
    local entries, generation = {}, nil
    local function scalarArguments(args)
        for i = 1, args.n do
            local kind = type(args[i])
            if kind ~= 'nil' and kind ~= 'number' and kind ~= 'string' and kind ~= 'boolean' then return false end
        end
        return true
    end
    local function equal(a, b)
        if a.n ~= b.n then return false end
        for i = 1, a.n do if a[i] ~= b[i] then return false end end
        return true
    end
    items.AddItemStatDifferences = function(self, tooltip, item, base, slot, ...)
        local calc, output = calcs:GetMiscCalculator()
        local current = table.pack(build.outputRevision, calc, output, build.viewMode,
            main and main.slotOnlyTooltips, main and main.showFlavourText,
            main and main.notSupportedModTooltips, main and main.showThousandsSeparators,
            main and main.thousandsSeparator, main and main.decimalSeparator,
            build.displayStats, build.minionDisplayStats)
        if not generation or not equal(generation, current) or build.buildFlag then
            entries, generation, stats.entries = {}, current, 0
        end
        local supported = self == items and select('#', ...) == 0 and not build.buildFlag
            and type(calc) == 'function' and type(output) == 'table'
            and type(tooltip) == 'table' and type(tooltip.AddLine) == 'function'
            and type(tooltip.AddSeparator) == 'function' and type(tooltip.lines) == 'table'
            and type(tooltip.blocks) == 'table' and type(item) == 'table'
            and type(item.BuildRaw) == 'function' and type(item.baseModList) == 'table'
            and type(base) == 'table' and base == item.base
            and (slot == nil or type(slot) == 'string' or type(slot) == 'table')
        if not supported then
            stats.bypasses = stats.bypasses + 1
            return original(self, tooltip, item, base, slot, ...)
        end
        local key = table.pack(item, item.baseModList, item:BuildRaw(), base, slot,
            type(slot) == 'table' and slot.slotName or nil,
            type(slot) == 'table' and slot.nodeId or nil,
            type(slot) == 'table' and slot.selItemId or nil,
            type(slot) == 'table' and slot.label or nil, tooltip.AddLine, tooltip.AddSeparator)
        for index, entry in ipairs(entries) do
            if equal(entry.key, key) then
                table.remove(entries, index)
                entries[#entries + 1] = entry
                stats.hits = stats.hits + 1
                for _, op in ipairs(entry.operations) do
                    tooltip[op.name](tooltip, table.unpack(op.args, 1, op.args.n))
                end
                return table.unpack(entry.result, 1, entry.result.n)
            end
        end
        stats.misses = stats.misses + 1
        local operations, safe = {}, true
        local saved = {}
        local function capture(name, record)
            local method = tooltip[name]
            if type(method) ~= 'function' then return end
            saved[#saved + 1] = {name = name, own = rawget(tooltip, name)}
            tooltip[name] = function(target, ...)
                local args = table.pack(...)
                if target ~= tooltip or not record or not scalarArguments(args) then
                    safe = false
                else
                    operations[#operations + 1] = {name = name, args = args}
                end
                return method(target, ...)
            end
        end
        capture('AddLine', true)
        capture('AddSeparator', true)
        -- Future pinned-source changes using any other tooltip mutation fail
        -- open. Do not cache child tooltips, tables, recipes or clearing calls.
        for _, name in ipairs({'AddTable', 'SetRecipe', 'Clear', 'CheckForUpdate'}) do capture(name, false) end
        local result = table.pack(pcall(original, self, tooltip, item, base, slot, ...))
        for _, method in ipairs(saved) do tooltip[method.name] = method.own end
        if not result[1] then error(result[2], 0) end
        local returns = table.pack(table.unpack(result, 2, result.n))
        if safe and scalarArguments(returns) and not build.buildFlag then
            if #entries >= limit then table.remove(entries, 1); stats.evictions = stats.evictions + 1 end
            entries[#entries + 1] = {key = key, operations = operations, result = returns}
            stats.entries = #entries
        else
            stats.bypasses = stats.bypasses + 1
        end
        return table.unpack(returns, 1, returns.n)
    end
end

return function(build, limit, mode)
    local items, calcs = build.itemsTab, build.calcsTab
    if not items or not calcs or type(items.AddItemStatDifferences) ~= "function"
        or type(calcs.GetMiscCalculator) ~= "function" then return end
    local original = items.AddItemStatDifferences
    local entries, revision, calculator, base, view = {}, nil, nil, nil, nil
    local stats = { hits = 0, misses = 0, bypasses = 0, evictions = 0, entries = 0,
        copies = 0, copyMs = 0, copiedTables = 0, copiedFields = 0,
        mode = mode == 'operations' and 'operations' or mode == 'off' and 'off' or 'calculator' }
    activeStats = stats
    if mode == 'off' then return stats end
    if mode == 'operations' then
        installOperationCache(build, limit or 64, stats)
        return stats
    end
    limit = limit or 32

    items.AddItemStatDifferences = function(self, ...)
        local getter = calcs.GetMiscCalculator
        local ownGetter = rawget(calcs, "GetMiscCalculator")
        calcs.GetMiscCalculator = function(tab, ...)
            local calc, output = getter(tab, ...)
            if select("#", ...) ~= 0 or type(calc) ~= "function" then return calc, output end
            if revision ~= build.outputRevision or calculator ~= calc or base ~= output or view ~= build.viewMode or build.buildFlag then
                entries = {}
                stats.entries = 0
                revision, calculator, base, view = build.outputRevision, calc, output, build.viewMode
            end
            return function(override, useFullDPS, ...)
                local key = not build.buildFlag and select("#", ...) == 0 and keyFor(override, useFullDPS)
                if not key then
                    stats.bypasses = stats.bypasses + 1
                    return calc(override, useFullDPS, ...)
                end
                for index, entry in ipairs(entries) do
                    if sameKey(entry.key, key) then
                        table.remove(entries, index)
                        entries[#entries + 1] = entry
                        stats.hits = stats.hits + 1
                        return copy(entry.output, nil, stats)
                    end
                end
                stats.misses = stats.misses + 1
                local result = table.pack(calc(override, useFullDPS))
                -- Fail open if a future PoB calculator changes its return contract.
                if result.n == 1 and type(result[1]) == "table" then
                    if #entries >= limit then table.remove(entries, 1); stats.evictions = stats.evictions + 1 end
                    entries[#entries + 1] = { key = key, output = copy(result[1], nil, stats) }
                    stats.entries = #entries
                end
                return table.unpack(result, 1, result.n)
            end, output
        end
        local result = table.pack(pcall(original, self, ...))
        calcs.GetMiscCalculator = ownGetter
        if not result[1] then error(result[2], 0) end
        return table.unpack(result, 2, result.n)
    end
    return stats
end
