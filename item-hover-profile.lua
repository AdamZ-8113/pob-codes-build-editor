-- Appended only to in-memory acceptance packages; never shipped in the payload.
do
    local encode = require('dkjson').encode
    local active, lastTooltip, lastItem, installed
    local calls, elapsed = 0, 0
    local addTooltip, draw = ItemsTabClass.AddItemTooltip, ItemsTabClass.Draw
    local function bounds(control)
        local x, y = control:GetPos()
        local w, h = control:GetSize()
        return {x, y, w, h}
    end
    ItemsTabClass.AddItemTooltip = function(self, tooltip, ...)
        local start = GetTime()
        local result = table.pack(addTooltip(self, tooltip, ...))
        calls, elapsed = calls + 1, elapsed + GetTime() - start
        lastTooltip = tooltip
        lastItem = select(1, ...)
        return table.unpack(result, 1, result.n)
    end
    ItemsTabClass.Draw = function(self, ...)
        active = self
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local result = profile(reset)
                local state = {calls = calls, tooltipMs = elapsed, lines = {}, equipped = {}, tooltips = {}, lastItemId = lastItem and lastItem.id}
                local function lines(tooltip)
                    local result = {}
                    for _, line in ipairs(tooltip and tooltip.lines or {}) do
                        result[#result + 1] = {text = line.text, height = line.height}
                    end
                    return result
                end
                if active then
                    local list = active.controls.itemList
                    state.listBounds, state.rowHeight = bounds(list), list.rowHeight or 16
                    state.listCount = #list.list
                    state.jewelIndices = {}
                    state.listItemIds = {}
                    state.scrollOffset = list.controls.scrollBarV.offset
                    state.hoverIndex, state.hoverItemId = list.hoverIndex, list.hoverValue
                    state.rowLabelOffset = list.colLabels and 18 or 0
                    for index, itemId in ipairs(list.list) do
                        state.listItemIds[index] = itemId
                        local item = active.items[itemId]
                        if item and item.type == 'Jewel' then state.jewelIndices[#state.jewelIndices + 1] = index end
                    end
                    state.tooltips.list = lines(list.tooltip)
                    state.levelBounds = bounds(active.build.controls.characterLevel)
                    state.weaponSwapBounds = bounds(active.controls.weaponSwap2)
                    state.weaponRestoreBounds = bounds(active.controls.weaponSwap1)
                    state.itemSetBounds = bounds(active.controls.setSelect)
                    state.specBounds = bounds(active.controls.specSelect)
                    state.itemSetIndex = active.controls.setSelect.selIndex
                    state.itemSetCount = #active.controls.setSelect.list
                    state.specIndex = active.controls.specSelect.selIndex
                    state.specCount = #active.controls.specSelect.list
                    local flask = active.slots['Flask 1']
                    if flask and flask.controls.activate then state.flaskToggleBounds = bounds(flask.controls.activate) end
                    state.showStatDifferences = active.showStatDifferences
                    for name, slot in pairs(active.slots) do
                        if slot.shown() and active.items[slot.selItemId] then
                            state.equipped[name] = bounds(slot)
                            state.tooltips[name] = lines(slot.tooltip)
                        end
                    end
                end
                state.lines = lines(lastTooltip)
                if getItemTooltipCacheProfile then state.cache = require('dkjson').decode(getItemTooltipCacheProfile()) end
                if reset then calls, elapsed = 0, 0 end
                return result:sub(1, -2) .. ',"itemHover":' .. encode(state) .. '}'
            end
        end
        return draw(self, ...)
    end
end
