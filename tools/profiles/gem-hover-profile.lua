-- Appended only to in-memory benchmark packages by profile-gem-hover.mjs.
-- Never included in the app's packaged Lua or WASM.
do
    local encode = require('dkjson').encode
    local installed, active, tab
    local function bounds(control)
        local x, y = control:GetPos()
        local w, h = control:GetSize()
        return { x, y, w, h }
    end
    local calls, calcMs, draws = 0, 0, 0
    local calculate, draw = GemSelectClass.CalcOutputWithThisGem, GemSelectClass.Draw
    GemSelectClass.CalcOutputWithThisGem = function(self, ...)
        local start = GetTime()
        local result = table.pack(calculate(self, ...))
        calls, calcMs = calls + 1, calcMs + GetTime() - start
        return table.unpack(result, 1, result.n)
    end
    GemSelectClass.Draw = function(self, ...)
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local result = profile(reset)
                local state = { calls = calls, calcMs = calcMs, draws = draws }
                if tab and tab.displayGroup then
                    state.controls = {
                        slot = bounds(tab.gemSlots[#tab.displayGroup.gemList + 1].nameSpec),
                        imbued = bounds(tab.controls.imbuedSupport),
                        sort = bounds(tab.controls.sortGemsByDPS),
                        quality = bounds(tab.controls.defaultQuality),
                    }
                    state.sortEnabled = tab.sortGemsByDPS
                    state.defaultQuality = tab.defaultGemQuality
                end
                if active then
                    local x, y = active:GetPos()
                    local w, h = active:GetSize()
                    local tooltip = active.hoverTooltip or active.tooltip
                    state.bounds = { x, y, w, h }
                    state.imbued = active.imbuedSelect or false
                    state.sorting = active.dpsBuilder ~= nil or active.dpsBuildFlag or false
                    state.hover = active.hoverSel
                    state.gem = active.hoverSel and active.list[active.hoverSel]
                    state.dropped = active.dropped
                    state.frameCount = active.hoverFrameCount or 0
                    state.lines = {}
                    for _, line in ipairs(tooltip.lines) do state.lines[#state.lines + 1] = line.text or '' end
                    state.list = {}
                    for i = 1, math.min(15, #active.list) do state.list[i] = active.list[i] end
                end
                if reset then calls, calcMs, draws = 0, 0, 0 end
                return result:sub(1, -2) .. ',"gemHover":' .. encode(state) .. '}'
            end
        end
        local result = table.pack(draw(self, ...))
        tab = self.skillsTab
        if self.dropped then active = self; draws = draws + 1 end
        return table.unpack(result, 1, result.n)
    end
end
