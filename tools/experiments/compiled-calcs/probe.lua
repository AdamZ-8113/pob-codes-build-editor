-- Experiment-only coarse profiler for a single target import.
-- The browser runner embeds this file into its isolated helper overlay.
local state
local calibration
local calculationDepth = 0
local candidatesEnabled = false
local candidatesInstalled = false

local function emptyRegion()
    return { calls = 0, outerCalls = 0, inclusiveMs = 0, exclusiveMs = 0, maxDepth = 0 }
end

local function resetState()
    state = {
        stack = {},
        regions = {
            calculation = emptyRegion(),
            ["defence-hit-pool-simulation"] = emptyRegion(),
            ["mod-store-query-evaluation"] = emptyRegion(),
        },
        calculationModes = {},
    }
end

local function hasRegion(name)
    for index = #state.stack, 1, -1 do
        if state.stack[index].name == name then return true end
    end
    return false
end

local function profileCall(name, fn, ...)
    local region = state.regions[name]
    if not region then
        region = emptyRegion()
        state.regions[name] = region
    end
    local nested = hasRegion(name)
    local frame = { name = name, childMs = 0 }
    state.stack[#state.stack + 1] = frame
    local depth = #state.stack
    region.maxDepth = math.max(region.maxDepth, depth)
    local started = GetTime()
    local result = table.pack(fn(...))
    local elapsed = GetTime() - started
    state.stack[#state.stack] = nil
    local parent = state.stack[#state.stack]
    if parent then parent.childMs = parent.childMs + elapsed end
    region.calls = region.calls + 1
    if not nested then
        region.outerCalls = region.outerCalls + 1
        region.inclusiveMs = region.inclusiveMs + elapsed
    end
    region.exclusiveMs = region.exclusiveMs + math.max(elapsed - frame.childMs, 0)
    return table.unpack(result, 1, result.n)
end

function compiledCalcsProfileCall(name, fn, ...)
    if calculationDepth == 0 or (name ~= "calculation" and not candidatesEnabled) then return fn(...) end
    return profileCall(name, fn, ...)
end

local function calibrate()
    local measuredState = state
    resetState()
    local function noop(a, b, c) return a, b, c end
    local iterations = 20000
    local started = GetTime()
    for _ = 1, iterations do noop(1, 2, 3) end
    local directMs = GetTime() - started
    calculationDepth = 1
    started = GetTime()
    for _ = 1, iterations do profileCall("calibration", noop, 1, 2, 3) end
    local wrappedMs = GetTime() - started
    calculationDepth = 0
    local measuredCalibration = {
        iterations = iterations,
        directMs = directMs,
        wrappedMs = wrappedMs,
        estimatedPerCallMs = math.max(wrappedMs - directMs, 0) / iterations,
    }
    state = measuredState
    calibration = measuredCalibration
end

local function wrapMethod(class, name)
    local original = rawget(class, name)
    if type(original) ~= "function" then error("Missing profiling method: " .. name) end
    class[name] = function(...)
        return compiledCalcsProfileCall("mod-store-query-evaluation", original, ...)
    end
end

local function skillSummary(build)
    local env = build.calcsTab and build.calcsTab.mainEnv
    local player = env and env.player
    local mainSkill = player and player.mainSkill
    local included = {}
    for _, skill in ipairs(player and player.activeSkillList or {}) do
        if skill.socketGroup and skill.socketGroup.includeInFullDPS then
            included[#included + 1] = skill.activeEffect and skill.activeEffect.grantedEffect and skill.activeEffect.grantedEffect.name or "unknown"
        end
    end
    return {
        activeSkill = mainSkill and mainSkill.activeEffect and mainSkill.activeEffect.grantedEffect and mainSkill.activeEffect.grantedEffect.name or "unknown",
        fullDPSIncluded = included,
        fullDPSValuePresent = build.calcsTab and build.calcsTab.mainOutput and build.calcsTab.mainOutput.FullDPS ~= nil or false,
    }
end

function getCompiledCalcsProfile(build)
    if not calibration then calibrate() end
    return {
        regions = state.regions,
        calculationModes = state.calculationModes,
        stackDepthAtReport = #state.stack,
        calibration = calibration,
        skill = skillSummary(build),
    }
end

return function(build)
    resetState()
    calibration = nil

    local calcs = assert(build.calcsTab and build.calcsTab.calcs, "Missing calculation module")
    local originalBuildOutput = assert(calcs.buildOutput, "Missing calculation entry point")
    calcs.buildOutput = function(target, mode, ...)
        state.calculationModes[mode] = (state.calculationModes[mode] or 0) + 1
        calculationDepth = calculationDepth + 1
        local result = table.pack(profileCall("calculation", originalBuildOutput, target, mode, ...))
        calculationDepth = calculationDepth - 1
        return table.unpack(result, 1, result.n)
    end

    function setCompiledCalcsProfileCandidates(enabled)
        candidatesEnabled = enabled and true or false
        if not candidatesEnabled or candidatesInstalled then return end
        candidatesInstalled = true
        local classes = assert(common and common.classes, "Missing PoB classes")
        local modStore = assert(classes.ModStore, "Missing ModStore class")
        local modDB = assert(classes.ModDB, "Missing ModDB class")
        for _, name in ipairs({
            "Sum", "More", "Flag", "Override", "List", "Tabulate", "Max", "Min",
            "HasMod", "GetCondition", "GetMultiplier", "GetStat", "EvalMod",
        }) do wrapMethod(modStore, name) end
        for _, name in ipairs({
            "SumInternal", "MoreInternal", "FlagInternal", "OverrideInternal",
            "ListInternal", "TabulateInternal", "HasModInternal",
        }) do wrapMethod(modDB, name) end
    end
end
