// TEST ONLY: appended to the in-memory ItemsTab package by profile-item-hover.
// Coarse Lua timings are inclusive; nested phases must not be added together.
import assert from 'node:assert/strict';

const diagnostics = String.raw`
do
    local phases = {}
    local wrapped = setmetatable({}, { __mode = 'k' })
    local labels = setmetatable({}, { __mode = 'k' })
    local originals = setmetatable({}, { __mode = 'k' })
    local installedProfile = false
    local tooltipClass
    local function record(kind, elapsed, failed)
        local phase = phases[kind]
        if not phase then
            phase = { count = 0, totalMs = 0, maxMs = 0, errors = 0, samples = {} }
            phases[kind] = phase
        end
        phase.count = phase.count + 1
        phase.totalMs = phase.totalMs + elapsed
        phase.maxMs = math.max(phase.maxMs, elapsed)
        if failed then phase.errors = phase.errors + 1 end
        if #phase.samples >= 128 then table.remove(phase.samples, 1) end
        phase.samples[#phase.samples + 1] = elapsed
    end
    local function timed(kind, fn, ...)
        local start = GetTime()
        local result = table.pack(pcall(fn, ...))
        record(kind, GetTime() - start, not result[1])
        if not result[1] then error(result[2], 0) end
        return table.unpack(result, 2, result.n)
    end
    local function wrap(target, key, kind)
        if not target or type(target[key]) ~= 'function' then return end
        local methods = wrapped[target]
        if not methods then
            methods = {}
            wrapped[target] = methods
        end
        if methods[key] then return end
        methods[key] = true
        local fn = target[key]
        target[key] = function(...) return timed(kind, fn, ...) end
    end
    local function wrapClassMethod(target, key, kind)
        if not target or type(target[key]) ~= 'function' then return end
        local class = getmetatable(target)
        if type(class) ~= 'table' or not rawget(class, '_className') then return end
        local targetLabels = labels[target]
        if not targetLabels then targetLabels = {}; labels[target] = targetLabels end
        targetLabels[key] = kind
        local methods = wrapped[class]
        if not methods then methods = {}; wrapped[class] = methods end
        if methods[key] then return end
        methods[key] = true
        local fn = class[key]
        -- Inheritance lookup can cache a parent's existing wrapper in a child.
        -- Unwrap it so the selected object is timed once rather than twice.
        while originals[fn] do fn = originals[fn] end
        local replacement = function(receiver, ...)
            local receiverLabels = labels[receiver]
            local selectedKind = receiverLabels and receiverLabels[key]
            if selectedKind then return timed(selectedKind, fn, receiver, ...) end
            return fn(receiver, ...)
        end
        originals[replacement] = fn
        class[key] = replacement
    end
    local function install(self)
        -- Re-import can replace control instances while reusing the build object.
        -- Weak bookkeeping prevents duplicate wrappers and releases old controls.
        local build = self.build
        wrap(main, 'OnFrame', 'mainOnFrame')
        wrap(build, 'OnFrame', 'buildOnFrame')
        wrap(build, 'DrawSidebar', 'drawSidebar')
        -- Never assign Draw to a control instance: PoB parent proxies read own
        -- object fields before the base class, so self.ListControl.Draw would
        -- otherwise dispatch back into ItemListControl.Draw recursively.
        wrapClassMethod(build, 'DrawControls', 'buildDrawControls')
        wrapClassMethod(build.controls and build.controls.statBox, 'Draw', 'sidebarStatBoxDraw')
        wrapClassMethod(self, 'DrawControls', 'itemsDrawControls')
        wrapClassMethod(self.controls and self.controls.itemList, 'Draw', 'itemListDraw')
        if not tooltipClass then
            local tooltip = self.controls and self.controls.itemList and self.controls.itemList.tooltip
                or self.displayItemTooltip
            -- getClass is private to Common.lua. Resolve the class from a real
            -- constructed instance; constructor fallback runs at most once.
            tooltipClass = getmetatable(tooltip or new('Tooltip'):Tooltip())
        end
        wrap(tooltipClass, 'Draw', 'tooltipDraw')
        wrap(tooltipClass, 'CalculateColumns', 'tooltipColumns')
        if not installedProfile and getRuntimeProfile then
            installedProfile = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local result = profile(reset)
                local encoded = require('dkjson').encode({ inclusive = true, phases = phases })
                if reset then phases = {} end
                return result:sub(1, -2) .. ',"warmPhases":' .. encoded .. '}'
            end
        end
    end
    local draw = ItemsTabClass.Draw
    ItemsTabClass.Draw = function(self, ...)
        install(self)
        return timed('itemsTabDraw', draw, self, ...)
    end
end
`;

export function transform(source) {
  assert.equal(source.split('function ItemsTabClass:Draw(').length, 2,
    'Pinned ItemsTab Draw interface occurs once');
  assert.ok(!source.includes("return result:sub(1, -2) .. ',\"warmPhases\":'"),
    'Warm frame diagnostics must not be installed twice');
  return `${source}\n${diagnostics}`;
}
