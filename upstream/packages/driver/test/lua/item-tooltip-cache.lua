local calls = 0
local function calculate(override, full, extra)
    calls = calls + 1
    return { Life = calls, Minion = { DPS = 42 }, FullDPS = full == false and 0 or 99, extra = extra }
end
local build = { outputRevision = 1, viewMode = "ITEMS", buildFlag = false }
local calcs = { miscCalculator = { calculate, {} } }
local getter = function(self) return table.unpack(self.miscCalculator) end
setmetatable(calcs, { __index = { GetMiscCalculator = getter } })
build.calcsTab = calcs
local items = { build = build }
build.itemsTab = items
items.AddItemStatDifferences = function(self, override, ...)
    local calc, base = self.build.calcsTab:GetMiscCalculator()
    assert(base == self.build.calcsTab.miscCalculator[2])
    return calc(override, ...)
end
local stats = installItemTooltipCache(build, 2)
local item = { raw = "Rarity: RARE\nTest", baseModList = {} }
item.BuildRaw = function(self) return self.raw end
local override = { repSlotName = "Helmet", repItem = item }
local function hover(opts, ...) return items:AddItemStatDifferences(opts or override, ...) end
local first = hover()
assert(calls == 1 and stats.misses == 1)
first.Life, first.Minion.DPS = -100, -100
local second = hover()
assert(calls == 1 and stats.hits == 1 and second.Life == 1 and second.Minion.DPS == 42)
second.Minion.DPS = -200
assert(hover().Minion.DPS == 42 and calls == 1)
assert(stats.copies == 3 and stats.copiedTables == 6 and stats.copiedFields > stats.copiedTables)
assert(stats.copyMs >= 0 and getItemTooltipCacheProfile():find('"copiedFields":', 1, true))
assert(rawget(calcs, "GetMiscCalculator") == nil and calcs.GetMiscCalculator == getter)
-- Calls outside the tooltip scope must always run the real calculator.
calcs:GetMiscCalculator()(override)
calcs:GetMiscCalculator()(override)
assert(calls == 3)
-- Full DPS variants are distinct, including nil versus explicit true.
assert(hover(nil, false).FullDPS == 0 and calls == 4)
assert(hover(nil, false).FullDPS == 0 and calls == 4)
hover(nil, true)
assert(calls == 5)
hover() -- LRU capacity two evicted the omitted-fullDPS entry.
assert(calls == 6)
-- All known edit and build/calculator boundaries invalidate prior results.
local function invalidates(change)
    local before = calls
    change()
    hover()
    assert(calls == before + 1)
    hover()
    assert(calls == before + 1)
end
invalidates(function() build.outputRevision = 2 end)
invalidates(function() calcs.miscCalculator[1] = function(...) return calculate(...) end end)
invalidates(function() calcs.miscCalculator[2] = {} end)
invalidates(function() build.viewMode = "TREE" end)
invalidates(function() item.raw = "Rarity: RARE\nEdited" end)
invalidates(function() item.baseModList = {} end)
local before = calls
build.buildFlag = true
hover(); hover()
assert(calls == before + 2)
build.buildFlag = false
hover()
assert(calls == before + 3)
-- Never memoize unknown override semantics or future extra calculator arguments.
for _, unsupported in ipairs({
    {}, { repSlotName = "Helmet", repItem = item, spec = {} },
    { addNodes = {} }, { removeNodes = {} }, { conditions = {} },
    { repSlotName = "Helmet", futureOption = false },
    { toggleFlask = item, toggleTincture = item },
    { repSlotName = 1 }, { repSlotName = "Helmet", repItem = {} },
    setmetatable({ repSlotName = "Helmet" }, {}),
}) do
    before = calls
    hover(unsupported); hover(unsupported)
    assert(calls == before + 2)
end
before = calls
hover(nil, nil, "extra"); hover(nil, nil, "extra")
assert(calls == before + 2)
for _, supported in ipairs({ { repSlotName = "Helmet" }, { toggleFlask = item }, { toggleTincture = item } }) do
    before = calls
    hover(supported); hover(supported)
    assert(calls == before + 1)
end
-- Unknown return contracts retain every return and are not cached.
calcs.miscCalculator[1] = function() calls = calls + 1; return { Life = 1 }, "extra", nil end
before = calls
local result = table.pack(hover())
hover()
assert(calls == before + 2 and result.n == 3 and result[2] == "extra")
-- Errors cannot leave the temporary getter installed.
calcs.miscCalculator[1] = function() error("expected failure") end
local ok, err = pcall(hover)
assert(not ok and err:find("expected failure", 1, true))
assert(rawget(calcs, "GetMiscCalculator") == nil and calcs.GetMiscCalculator == getter)
assert(installItemTooltipCache({}) == nil)

-- Copy tracing counts each unique table once per pass and does not recurse
-- through cyclic references again. It retains no diagnostic object references.
do
    local formerTime = GetTime
    local clock = 0
    GetTime = function() clock = clock + 5; return clock end
    local child = {value = 42}
    local graph = {first = child, second = child}
    graph.self = graph
    local b = {outputRevision = 1, viewMode = 'ITEMS', buildFlag = false}
    local c = {miscCalculator = {function() return graph end, {}}}
    c.GetMiscCalculator = getter
    local t = {build = b}
    b.itemsTab, b.calcsTab = t, c
    t.AddItemStatDifferences = function(self, opts) return self.build.calcsTab:GetMiscCalculator()(opts) end
    local s = installItemTooltipCache(b)
    t:AddItemStatDifferences(override)
    local cloned = t:AddItemStatDifferences(override)
    assert(s.copies == 2 and s.copiedTables == 4 and s.copiedFields == 8 and s.copyMs == 10)
    assert(cloned ~= graph and cloned.self == cloned and cloned.first == cloned.second and cloned.first ~= child)
    GetTime = formerTime
end

-- Comparison-operation cache: preserve exact PoB calls without caching a full
-- item tooltip or constructing unsupported special-jewel calculator keys.
do
    local operationCalls, specialSpecBuilds = 0, 0
    local formerMain = main
    main = {slotOnlyTooltips = true, showFlavourText = true, notSupportedModTooltips = true}
    local b = {outputRevision = 1, viewMode = 'ITEMS', buildFlag = false,
        displayStats = {}, minionDisplayStats = {}}
    local c = {miscCalculator = {function() end, {}}}
    c.GetMiscCalculator = getter
    local tab = {build = b}
    b.itemsTab, b.calcsTab = tab, c
    local methods = {}
    function methods:AddLine(...) self.lines[#self.lines + 1] = table.pack('line', ...) end
    function methods:AddSeparator(...) self.lines[#self.lines + 1] = table.pack('separator', ...) end
    function methods:AddTable(value) self.lines[#self.lines + 1] = value end
    function methods:Clear() self.lines = {} end
    local function tt() return setmetatable({lines = {}, blocks = {}}, {__index = methods}) end
    local jewel = {raw = 'special jewel', baseModList = {}, base = {}, special = true, BuildRaw = item.BuildRaw}
    local ordinary = {raw = 'helmet', baseModList = {}, base = {}, BuildRaw = item.BuildRaw}
    local errorNow, unsupportedOperation, unsupportedReturn, mutatesBuild
    tab.AddItemStatDifferences = function(self, tooltip, target, targetBase, slot, ...)
        operationCalls = operationCalls + 1
        if target.special then specialSpecBuilds = specialSpecBuilds + 1 end
        tooltip:AddSeparator(10)
        tooltip:AddLine(14, target.raw .. ':' .. tostring(main.showFlavourText), nil, nil, nil)
        if unsupportedOperation then tooltip:AddTable({value = 1}) end
        if errorNow then error('operation cache test error') end
        if mutatesBuild then b.buildFlag = true end
        if unsupportedReturn then return unsupportedReturn, nil end
        return 'complete', nil, 3, nil
    end
    local s = installItemTooltipCache(b, 2, 'operations')
    local function hoverItem(target, slot, tooltip, ...)
        tooltip = tooltip or tt()
        local result = table.pack(tab:AddItemStatDifferences(tooltip, target or jewel,
            (target or jewel).base, slot, ...))
        return tooltip, result
    end
    local firstTooltip, firstReturn = hoverItem()
    local repeatedTooltip, repeatedReturn = hoverItem()
    assert(operationCalls == 1 and specialSpecBuilds == 1 and s.hits == 1 and s.entries == 1)
    assert(s.copies == 0 and s.copyMs == 0 and s.copiedTables == 0 and s.copiedFields == 0)
    assert(firstReturn.n == 4 and repeatedReturn.n == 4 and repeatedReturn[1] == 'complete'
        and repeatedReturn[2] == nil and repeatedReturn[3] == 3 and repeatedReturn[4] == nil)
    for index, op in ipairs(firstTooltip.lines) do
        local repeated = repeatedTooltip.lines[index]
        assert(op.n == repeated.n)
        for i = 1, op.n do assert(op[i] == repeated[i]) end
    end
    firstTooltip.lines[2][3] = 'mutated tooltip'
    local clean = hoverItem()
    assert(clean.lines[2][3] ~= 'mutated tooltip' and operationCalls == 1)
    assert(rawget(firstTooltip, 'AddLine') == nil and rawget(firstTooltip, 'AddSeparator') == nil
        and rawget(firstTooltip, 'Clear') == nil and rawget(firstTooltip, 'AddTable') == nil)

    local function invalidate(change)
        local count = operationCalls
        change()
        hoverItem(); hoverItem()
        assert(operationCalls == count + 1)
    end
    invalidate(function() b.outputRevision = b.outputRevision + 1 end)
    invalidate(function() c.miscCalculator[1] = function() end end)
    invalidate(function() c.miscCalculator[2] = {} end)
    invalidate(function() b.viewMode = 'TREE' end)
    invalidate(function() main.slotOnlyTooltips = false end)
    invalidate(function() main.showFlavourText = false end)
    invalidate(function() main.notSupportedModTooltips = false end)
    invalidate(function() main.showThousandsSeparators = false end)
    invalidate(function() main.thousandsSeparator = ' ' end)
    invalidate(function() main.decimalSeparator = ',' end)
    invalidate(function() b.displayStats = {} end)
    invalidate(function() b.minionDisplayStats = {} end)
    invalidate(function() jewel.raw = 'edited special jewel' end)
    invalidate(function() jewel.baseModList = {} end)
    invalidate(function() jewel.base = {} end)
    local before = operationCalls
    b.buildFlag = true
    hoverItem(); hoverItem()
    assert(operationCalls == before + 2 and s.entries == 0)
    b.buildFlag = false
    hoverItem(); hoverItem()
    assert(operationCalls == before + 3)

    local socket = {slotName = 'Socket 1'}
    before = operationCalls
    hoverItem(jewel, socket); hoverItem(jewel, socket)
    assert(operationCalls == before + 1)
    socket.slotName = 'Socket 2'
    hoverItem(jewel, socket)
    assert(operationCalls == before + 2)
    hoverItem(ordinary, 'Helmet')
    before = operationCalls
    hoverItem() -- capacity two evicts the nil-slot special-jewel entry
    assert(operationCalls == before + 1 and s.evictions > 0)

    -- Unsupported arguments, base contracts, operations and return objects
    -- always execute the authoritative comparison, preserving its result.
    before = operationCalls
    hoverItem(nil, nil, nil, 'future'); hoverItem(nil, nil, nil, 'future')
    assert(operationCalls == before + 2)
    before = operationCalls
    tab:AddItemStatDifferences(tt(), jewel, {}); tab:AddItemStatDifferences(tt(), jewel, {})
    assert(operationCalls == before + 2)
    b.outputRevision = b.outputRevision + 1
    unsupportedOperation = true
    before = operationCalls
    hoverItem(); hoverItem()
    assert(operationCalls == before + 2 and s.entries == 0)
    unsupportedOperation = false
    unsupportedReturn = {}
    before = operationCalls
    local _, result = hoverItem()
    hoverItem()
    assert(operationCalls == before + 2 and result.n == 2 and result[1] == unsupportedReturn)
    unsupportedReturn = nil
    mutatesBuild = true
    hoverItem()
    assert(s.entries == 0)
    mutatesBuild, b.buildFlag = false, false

    errorNow = true
    local failing = tt()
    local ok, err = pcall(function() hoverItem(nil, nil, failing) end)
    assert(not ok and err:find('operation cache test error', 1, true))
    assert(rawget(failing, 'AddLine') == nil and rawget(failing, 'AddSeparator') == nil
        and rawget(failing, 'AddTable') == nil and rawget(failing, 'Clear') == nil)
    errorNow = false
    hoverItem(); hoverItem()
    assert(getItemTooltipCacheProfile():find('"mode":"operations"', 1, true))
    main = formerMain
end
