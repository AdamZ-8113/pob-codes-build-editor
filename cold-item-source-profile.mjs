// TEST ONLY: applied to the in-memory ItemsTab package by profile-item-hover.mjs.
// Timings are inclusive and nested; they must not be added together.
import assert from 'node:assert/strict';

const prelude = String.raw`
local _coldItemPhases = {}
local _coldItemPhaseCounts = { statChanges = 0, lines = 0 }
local _coldItemFullDepth = 0
local function _coldItemRecord(kind, elapsed, failed)
    local phase = _coldItemPhases[kind]
    if not phase then
        phase = { count = 0, totalMs = 0, maxMs = 0, errors = 0, samples = {} }
        _coldItemPhases[kind] = phase
    end
    phase.count = phase.count + 1
    phase.totalMs = phase.totalMs + elapsed
    phase.maxMs = math.max(phase.maxMs, elapsed)
    if failed then phase.errors = phase.errors + 1 end
    if #phase.samples >= 128 then table.remove(phase.samples, 1) end
    phase.samples[#phase.samples + 1] = elapsed
end
local function _coldItemTimed(kind, fn, ...)
    local start = GetTime()
    local result = table.pack(pcall(fn, ...))
    _coldItemRecord(kind, GetTime() - start, not result[1])
    if not result[1] then error(result[2], 0) end
    return table.unpack(result, 2, result.n)
end
`;

const wrappers = String.raw`
-- Temporary wrappers preserve own/inherited methods and restore on errors.
do
    local original = ItemsTabClass.AddItemStatDifferences
    ItemsTabClass.AddItemStatDifferences = function(self, tooltip, ...)
        local restores = {}
        local function wrap(target, key, factory)
            if not target or type(target[key]) ~= 'function' then return end
            local own, fn = rawget(target, key), target[key]
            target[key] = factory(fn)
            restores[#restores + 1] = function() target[key] = own end
        end
        local tab = self.build.calcsTab
        local calcs = tab.calcs
        wrap(tab, 'GetMiscCalculator', function(fn)
            return function(...)
                local result = table.pack(_coldItemTimed('getCalculator', fn, ...))
                if type(result[1]) == 'function' then
                    local calculate = result[1]
                    result[1] = function(override, ...)
                        return _coldItemTimed(override and override.spec and 'comparisonCalcSpec' or 'comparisonCalc', calculate, override, ...)
                    end
                end
                return table.unpack(result, 1, result.n)
            end
        end)
        wrap(calcs, 'getMiscCalculator', function(fn)
            return function(...) return _coldItemTimed('createCalculator', fn, ...) end
        end)
        wrap(calcs, 'initEnv', function(fn)
            return function(build, mode, override, specEnv, ...)
                local kind = specEnv and specEnv.env and 'initEnvReuse'
                    or specEnv and specEnv.cachedPlayerDB and 'initEnvCachedBase' or 'initEnvFreshBase'
                return _coldItemTimed(kind, fn, build, mode, override, specEnv, ...)
            end
        end)
        wrap(calcs, 'initModDB', function(fn)
            return function(...) return _coldItemTimed('initModDB', fn, ...) end
        end)
        wrap(calcs, 'perform', function(fn)
            return function(env, skipEHP, ...)
                local kind = _coldItemFullDepth > 0 and 'performFullDPS' or 'performComparison'
                return _coldItemTimed(kind, fn, env, skipEHP, ...)
            end
        end)
        wrap(calcs, 'calcFullDPS', function(fn)
            return function(...)
                _coldItemFullDepth = _coldItemFullDepth + 1
                local result = table.pack(pcall(_coldItemTimed, 'fullDPS', fn, ...))
                _coldItemFullDepth = _coldItemFullDepth - 1
                if not result[1] then error(result[2], 0) end
                return table.unpack(result, 2, result.n)
            end
        end)
        wrap(_G, 'specCopy', function(fn)
            return function(...) return _coldItemTimed('baseDbSnapshot', fn, ...) end
        end)
        wrap(self.build, 'AddStatComparesToTooltip', function(fn)
            return function(...)
                local result = table.pack(_coldItemTimed('formatting', fn, ...))
                if type(result[1]) == 'number' then
                    _coldItemPhaseCounts.statChanges = _coldItemPhaseCounts.statChanges + result[1]
                end
                return table.unpack(result, 1, result.n)
            end
        end)
        local before = #(tooltip.lines or {})
        local result = table.pack(pcall(_coldItemTimed, 'statDifference', original, self, tooltip, ...))
        for i = #restores, 1, -1 do restores[i]() end
        _coldItemPhaseCounts.lines = _coldItemPhaseCounts.lines + math.max(0, #(tooltip.lines or {}) - before)
        if not result[1] then error(result[2], 0) end
        return table.unpack(result, 2, result.n)
    end
    local draw, installed = ItemsTabClass.Draw, false
    ItemsTabClass.Draw = function(self, ...)
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local result = profile(reset)
                local state = { inclusive = true, phases = _coldItemPhases, counts = _coldItemPhaseCounts }
                local encoded = require('dkjson').encode(state)
                if reset then
                    _coldItemPhases = {}
                    _coldItemPhaseCounts = { statChanges = 0, lines = 0 }
                end
                return result:sub(1, -2) .. ',"itemPhases":' .. encoded .. '}'
            end
        end
        return draw(self, ...)
    end
end
`;

function replaceOnce(source, needle, replacement) {
  assert.equal(source.split(needle).length, 2, `Pinned ItemsTab hook occurs once: ${needle}`);
  return source.replace(needle, replacement);
}

export function transform(source) {
  assert.ok(source.includes('function ItemsTabClass:AddItemStatDifferences('), 'Pinned ItemsTab comparison interface');
  source = replaceOnce(source,
    'local spec = cloneSpecForJewelComparison(itemsTab.build.spec)',
    'local spec = _coldItemTimed("specClone", cloneSpecForJewelComparison, itemsTab.build.spec)');
  source = replaceOnce(source,
    '\t\tspec:BuildAllDependsAndPaths()',
    '\t\t_coldItemTimed("specRebuild", spec.BuildAllDependsAndPaths, spec)');
  return `${prelude}\n${source}\n${wrappers}`;
}
