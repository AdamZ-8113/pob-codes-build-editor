// TEST ONLY: feasibility probe, never packed or installed in the native driver.
// A native implementation would cache raw physical coordinates and still apply
// the current DPI conversion per call. This Lua probe invalidates on known DPI
// setters and retains direct cursor reads outside the main frame callback.
import assert from 'node:assert/strict';

export const experiment = Object.freeze({
  scope: 'Frame-local cursor getter reuse in Lua; native feasibility only',
  instrumentation: 'Two scalar upvalues and a protected main frame wrapper',
});

const probe = String.raw`
do
    local readCursor, draw = GetCursorPos, ItemsTabClass.Draw
    local active, installed, x, y = false, false, nil, nil
    GetCursorPos = function()
        if not active then return readCursor() end
        if x == nil then x, y = readCursor() end
        return x, y
    end
    for _, name in ipairs({'RenderInit', 'SetDPIScaleOverridePercent', 'SetCursorPos'}) do
        local original = _G[name]
        if type(original) == 'function' then
            _G[name] = function(...)
                x, y = nil, nil
                return original(...)
            end
        end
    end
    ItemsTabClass.Draw = function(self, ...)
        if not installed then
            installed = true
            local original = main.OnFrame
            main.OnFrame = function(...)
                active, x, y = true, nil, nil
                local result = table.pack(pcall(original, ...))
                active, x, y = false, nil, nil
                if not result[1] then error(result[2], 0) end
                return table.unpack(result, 2, result.n)
            end
        end
        return draw(self, ...)
    end
end
`;

export function transform(source) {
  assert.equal(source.split('function ItemsTabClass:Draw(').length, 2);
  return `${source}\n${probe}`;
}
