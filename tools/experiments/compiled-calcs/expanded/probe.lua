local state

local function reset()
    state = { calculationModes = {}, regions = { calculation = { calls = 0, totalMs = 0, maxMs = 0 } } }
end

local function breakdownItemReference(item, stats)
    stats.breakdownItemReferences = (stats.breakdownItemReferences or 0) + 1
    local reference = { __snapshotType = "breakdown-item-reference" }
    for _, name in ipairs({ "id", "name", "baseName", "title", "raw", "source", "slot", "type", "rarity", "league" }) do
        local value = rawget(item, name)
        local kind = type(value)
        if kind == "string" or kind == "number" or kind == "boolean" then reference[name] = value end
    end
    return reference
end

local function tagged(value, seen, stats, breakdown)
    local kind = type(value)
    if kind == "number" then
        if value ~= value then return { type = "number", value = "nan" } end
        if value == math.huge then return { type = "number", value = "+inf" } end
        if value == -math.huge then return { type = "number", value = "-inf" } end
        return { type = "number", value = string.format("%.17g", value) }
    elseif kind == "string" or kind == "boolean" then
        return { type = kind, value = value }
    elseif kind == "nil" then
        return { type = "nil" }
    elseif kind ~= "table" then
        stats.unsupportedValueTypes[kind] = (stats.unsupportedValueTypes[kind] or 0) + 1
        return { type = kind }
    end
    seen = seen or { ids = {}, nextId = 1 }
    if seen.ids[value] then return { type = "cycle", id = seen.ids[value] } end
    local id = seen.nextId
    seen.nextId = id + 1
    seen.ids[value] = id
    local entries = setmetatable({}, { __jsontype = "array" })
    local keys = {}
    local function keyToken(key)
        local keyType = type(key)
        assert(keyType == "string" or keyType == "number" or keyType == "boolean", "Unsupported output table key type: " .. keyType)
        if keyType == "number" then return keyType .. ":" .. string.format("%.17g", key) end
        return keyType .. ":" .. tostring(key)
    end
    for key in pairs(value) do keys[#keys + 1] = key end
    table.sort(keys, function(a, b) return keyToken(a) < keyToken(b) end)
    for _, key in ipairs(keys) do
        local child = value[key]
        if breakdown and key == "item" and type(child) == "table" then
            child = breakdownItemReference(child, stats)
        end
        entries[#entries + 1] = { key = tagged(key, seen, stats, breakdown), value = tagged(child, seen, stats, breakdown) }
    end
    return { type = "table", id = id, entries = entries }
end

local function fieldCount(output)
    local count = 0
    for _ in pairs(output or {}) do count = count + 1 end
    return count
end

local function fieldSnapshot(output, names, stats)
    local result = {}
    for _, name in ipairs(names) do
        local value = output and rawget(output, name)
        result[name] = { present = value ~= nil, value = tagged(value, nil, stats) }
    end
    return result
end

local function displayedModList(breakdown, stats)
    local source = breakdown and breakdown.modList or {}
    local rows = {}
    for index, entry in ipairs(source) do rows[index] = entry end
    table.sort(rows, function(a, b)
        local aName, bName = a.mod.name, b.mod.name
        return aName > bName or (aName == bName and type(a.value) == "number" and type(b.value) == "number" and a.value > b.value)
    end)
    local ambiguousTies = 0
    for index = 2, #rows do
        local a, b = rows[index - 1], rows[index]
        local sameName = a.mod.name == b.mod.name
        local bothNumbers = type(a.value) == "number" and type(b.value) == "number"
        if sameName and ((bothNumbers and a.value == b.value) or not bothNumbers) then
            ambiguousTies = ambiguousTies + 1
        end
    end
    return {
        rows = tagged(rows, nil, stats, true),
        ambiguousTies = ambiguousTies,
        ambiguousRawOrder = ambiguousTies > 0 and tagged(source, nil, stats, true) or nil,
    }
end

local function breakdownWithoutDisplayedRawLists(breakdown)
    local result = {}
    for key, value in pairs(breakdown or {}) do
        if (key == "SkillBuffs" or key == "SkillDebuffs") and type(value) == "table" then
            local section = {}
            for sectionKey, sectionValue in pairs(value) do
                if sectionKey ~= "modList" then section[sectionKey] = sectionValue end
            end
            result[key] = section
        else
            result[key] = value
        end
    end
    return result
end

local function outputSnapshot(build)
    local calcs = assert(build.calcsTab, "Missing calcs tab")
    local mainEnv, calcsEnv = calcs.mainEnv, calcs.calcsEnv
    local material = { "FullDPS", "FullDotDPS", "SkillDPS", "CombinedDPS", "TotalDPS", "TotalDotDPS", "Life", "EnergyShield", "Mana", "TotalEHP" }
    local stats = { unsupportedValueTypes = {} }
    local fullDPSSkills = setmetatable({}, { __jsontype = "array" })
    for _, skill in ipairs(mainEnv and mainEnv.player and mainEnv.player.activeSkillList or {}) do
        if skill.socketGroup and skill.socketGroup.includeInFullDPS then
            fullDPSSkills[#fullDPSSkills + 1] = {
                name = skill.activeEffect and skill.activeEffect.grantedEffect and skill.activeEffect.grantedEffect.name,
                skillPart = skill.skillPart,
                source = skill.source,
                trigger = skill.trigger,
            }
        end
    end
    return {
        mainPlayer = tagged(mainEnv and mainEnv.player and mainEnv.player.output, nil, stats),
        mainMinion = tagged(mainEnv and mainEnv.minion and mainEnv.minion.output, nil, stats),
        calcsPlayer = tagged(calcsEnv and calcsEnv.player and calcsEnv.player.output, nil, stats),
        calcsMinion = tagged(calcsEnv and calcsEnv.minion and calcsEnv.minion.output, nil, stats),
        mainPlayerBreakdown = tagged(mainEnv and mainEnv.player and mainEnv.player.breakdown, nil, stats, true),
        mainMinionBreakdown = tagged(mainEnv and mainEnv.minion and mainEnv.minion.breakdown, nil, stats, true),
        calcsPlayerBreakdown = tagged(calcsEnv and calcsEnv.player and calcsEnv.player.breakdown, nil, stats, true),
        calcsPlayerBreakdownWithoutDisplayedRawModLists = tagged(breakdownWithoutDisplayedRawLists(calcsEnv and calcsEnv.player and calcsEnv.player.breakdown), nil, stats, true),
        calcsMinionBreakdown = tagged(calcsEnv and calcsEnv.minion and calcsEnv.minion.breakdown, nil, stats, true),
        displayedSkillBreakdown = {
            sourceComparator = "CalcBreakdownControl.lua AddModSection: mod.name descending, then numeric value descending",
            skillBuffs = displayedModList(calcsEnv and calcsEnv.player and calcsEnv.player.breakdown and calcsEnv.player.breakdown.SkillBuffs, stats),
            skillDebuffs = displayedModList(calcsEnv and calcsEnv.player and calcsEnv.player.breakdown and calcsEnv.player.breakdown.SkillDebuffs, stats),
        },
        material = {
            mainPlayer = fieldSnapshot(mainEnv and mainEnv.player and mainEnv.player.output, material, stats),
            mainMinion = fieldSnapshot(mainEnv and mainEnv.minion and mainEnv.minion.output, material, stats),
            calcsPlayer = fieldSnapshot(calcsEnv and calcsEnv.player and calcsEnv.player.output, material, stats),
            calcsMinion = fieldSnapshot(calcsEnv and calcsEnv.minion and calcsEnv.minion.output, material, stats),
        },
        fieldCounts = {
            mainPlayer = fieldCount(mainEnv and mainEnv.player and mainEnv.player.output),
            mainMinion = fieldCount(mainEnv and mainEnv.minion and mainEnv.minion.output),
            calcsPlayer = fieldCount(calcsEnv and calcsEnv.player and calcsEnv.player.output),
            calcsMinion = fieldCount(calcsEnv and calcsEnv.minion and calcsEnv.minion.output),
        },
        fullDPSEnrollment = { count = #fullDPSSkills, skills = fullDPSSkills },
        warnings = tagged(build.controls and build.controls.warnings and build.controls.warnings.lines, nil, stats),
        warningsSource = "build.controls.warnings.lines",
        snapshotScope = {
            schemaVersion = 1,
            roots = {
                "calcsTab.mainEnv.player.output", "calcsTab.mainEnv.minion.output",
                "calcsTab.calcsEnv.player.output", "calcsTab.calcsEnv.minion.output",
                "calcsTab.mainEnv.player.breakdown", "calcsTab.mainEnv.minion.breakdown",
                "calcsTab.calcsEnv.player.breakdown", "calcsTab.calcsEnv.minion.breakdown",
                "calcsTab.calcsEnv.player.breakdown excluding only SkillBuffs.modList and SkillDebuffs.modList",
                "source-backed displayed calcsTab.calcsEnv.player.breakdown.{SkillBuffs,SkillDebuffs}.modList projection",
                "build.controls.warnings.lines",
            },
            numbers = "tagged string.format %.17g plus nan/+inf/-inf",
            tables = "primitive keys sorted before recursive traversal; unsupported table keys reject capture; cycles use deterministic traversal IDs",
            breakdownExternalGraph = "complete breakdown strings/numbers are retained; each breakdown *.item graph is replaced by a stable primitive identity projection (id/name/baseName/title/raw/source/slot/type/rarity/league when present)",
            excludedPaths = { "calcsTab.*Env.{player,minion}.breakdown.*.item non-primitive object graph" },
            nils = "material fields carry explicit present=false plus tagged nil; arbitrary absent keys are absent",
            unsupportedValues = "function/userdata/thread values compare by type only; counts follow",
        },
        snapshotStats = stats,
        activeSkill = calcs.mainEnv and calcs.mainEnv.player and calcs.mainEnv.player.mainSkill and calcs.mainEnv.player.mainSkill.activeEffect and calcs.mainEnv.player.mainSkill.activeEffect.grantedEffect and calcs.mainEnv.player.mainSkill.activeEffect.grantedEffect.name,
    }
end

local function install(build)
    if not build.calcsTab or not build.calcsTab.calcs then
        __compiledCalcsInstallDeferredProbe = function(initializedBuild)
            install(initializedBuild)
        end
        return
    end
    reset()
    local calcs = build.calcsTab.calcs
    local original = assert(calcs.buildOutput, "Missing calculation entry point")
    local calculationDepth = 0
    calcs.buildOutput = function(target, mode, ...)
        calculationDepth = calculationDepth + 1
        local started = GetTime()
        local result = table.pack(original(target, mode, ...))
        local elapsed = GetTime() - started
        local region = state.regions.calculation
        region.calls = region.calls + 1
        region.maxDepth = math.max(region.maxDepth or 0, calculationDepth)
        if calculationDepth == 1 then
            region.outerCalls = (region.outerCalls or 0) + 1
            region.totalMs = region.totalMs + elapsed
        end
        region.maxMs = math.max(region.maxMs, elapsed)
        state.calculationModes[mode] = (state.calculationModes[mode] or 0) + 1
        calculationDepth = calculationDepth - 1
        return table.unpack(result, 1, result.n)
    end
    function getExpandedColdProfile(includeOutput)
        return {
            calculationModes = state.calculationModes,
            regions = state.regions,
            luaKiB = collectgarbage("count"),
            output = includeOutput and outputSnapshot(build) or nil,
        }
    end
end

return install
