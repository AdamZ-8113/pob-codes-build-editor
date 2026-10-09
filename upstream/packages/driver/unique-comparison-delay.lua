-- Only postpone unique-database comparisons while a row is still transient.
-- Base item text is immediate; the exact original comparison runs after 150 ms.
local installed = setmetatable({}, { __mode = "k" })
local active
local activeDb
local activeBuild, activeCancel
function updateUniqueComparisonVisibility()
    if activeBuild and activeBuild.viewMode ~= "ITEMS" and activeCancel then activeCancel(true) end
end
function getUniqueComparisonProfile()
    local s = active or { pending = false, deferred = 0, completed = 0, cancelled = 0 }
    local visible = activeBuild ~= nil and activeBuild.viewMode == "ITEMS"
    local hash, headers, numeric, comparing = 5381, 0, 0, false
    -- Opt-in test diagnostics retain neither item text nor comparison numbers.
    for _, line in ipairs(visible and activeDb and activeDb.tooltip and activeDb.tooltip.lines or {}) do
        local text = type(line) == "table" and line.text or ""
        if text:find("Equipping this item", 1, true) or text:find("Removing this item", 1, true) then
            headers, comparing = headers + 1, true
        elseif comparing and text:find("%d") then numeric = numeric + 1 end
        for i = 1, #text do hash = (hash * 33 + text:byte(i)) % 4294967296 end
        hash = (hash * 33 + 10) % 4294967296
    end
    return '{"pending":' .. tostring(visible and s.pending) .. ',"deferred":' .. s.deferred
        .. ',"completed":' .. s.completed .. ',"cancelled":' .. s.cancelled
        .. ',"hovered":' .. tostring(visible and activeDb ~= nil and activeDb.hoverValue ~= nil)
        .. ',"tooltipHash":' .. hash .. ',"comparisonHeaders":' .. headers .. ',"numericLines":' .. numeric .. '}'
end

return function(build)
    local items = build.itemsTab
    local db = items and items.controls and items.controls.uniqueDB
    if not db or not db.controls or not db.controls.scrollBarV
        or type(db.AddValueTooltip) ~= "function" or type(db.Draw) ~= "function"
        or type(db.OnKeyUp) ~= "function" or type(items.AddItemStatDifferences) ~= "function" then return end
    activeDb, activeBuild = db, build
    if installed[db] then
        active = installed[db]
        activeCancel = active.cancel
        return active
    end
    local stats = { pending = false, deferred = 0, completed = 0, cancelled = 0 }
    installed[db], active = stats, stats
    local originalTooltip, originalDraw, originalKeyUp = db.AddValueTooltip, db.Draw, db.OnKeyUp
    local ownDraw = rawget(db, "Draw")
    local state, seen, lastDrawAt
    local function cancel(clear)
        if state and state.pending then
            stats.cancelled = stats.cancelled + 1
            if clear and state.tooltip then state.tooltip:Clear(true) end
        end
        state, stats.pending = nil, false
    end
    activeCancel, stats.cancel = cancel, cancel
    db.AddValueTooltip = function(self, tooltip, index, item, ...)
        seen = true
        if not items.showStatDifferences or (main and main.popups and main.popups[1]) then
            cancel(true)
            return originalTooltip(self, tooltip, index, item, ...)
        end
        local now = GetTime()
        local scroll = self.controls.scrollBarV.offset
        local shift, debugMode = IsKeyDown("SHIFT"), launch and launch.devModeAlt
        if not state or state.item ~= item or state.index ~= index or state.scroll ~= scroll
            or state.revision ~= build.outputRevision or state.shift ~= shift or state.debugMode ~= debugMode then
            cancel(false)
            state = { item = item, index = index, scroll = scroll, revision = build.outputRevision,
                shift = shift, debugMode = debugMode, deadline = now + 150, tooltip = tooltip, pending = false }
            tooltip:Clear(true)
        end
        local current = state
        local ready = now >= current.deadline
        if ready and current.pending then
            current.pending, stats.pending = false, false
            -- PoB caches tooltip contents by item/revision. Explicitly invalidate
            -- only when pending becomes ready, so the placeholder cannot stick.
            tooltip:Clear(true)
        end
        local previous = items.AddItemStatDifferences
        local ownPrevious = rawget(items, "AddItemStatDifferences")
        items.AddItemStatDifferences = function(tab, targetTooltip, targetItem, ...)
            if tab == items and targetTooltip == tooltip and targetItem == item then
                if not ready then
                    if not current.pending then stats.deferred = stats.deferred + 1 end
                    current.pending, stats.pending = true, true
                    targetTooltip:AddSeparator(10)
                    targetTooltip:AddLine(14, "^8Comparison pending...")
                    return
                end
            end
            local result = table.pack(previous(tab, targetTooltip, targetItem, ...))
            if tab == items and targetTooltip == tooltip and targetItem == item then
                stats.pending = result[1] == 'pending'
                if not stats.pending then stats.completed = stats.completed + 1 end
            end
            return table.unpack(result, 1, result.n)
        end
        local result = table.pack(pcall(originalTooltip, self, tooltip, index, item, ...))
        items.AddItemStatDifferences = ownPrevious
        if not result[1] then cancel(false); error(result[2], 0) end
        if current.pending then RequestFrames(2) end
        return table.unpack(result, 2, result.n)
    end
    db.Draw = function(self, ...)
        seen = false
        local now = GetTime()
        -- A backgrounded tab or a different PoB screen may stop drawing this
        -- control. Returning must start a fresh pending hover, not expire it.
        if state and state.pending and lastDrawAt and now - lastDrawAt > 250 then cancel(true) end
        lastDrawAt = now
        -- PoB's superclass proxy resolves instance fields before parent methods.
        -- Hide our instance override while originalDraw delegates to ListControl.
        local wrapper = rawget(self, "Draw")
        self.Draw = ownDraw
        local result = table.pack(pcall(originalDraw, self, ...))
        self.Draw = wrapper
        if not seen then cancel(true) end
        if not result[1] then cancel(false); error(result[2], 0) end
        return table.unpack(result, 2, result.n)
    end
    local function noteScroll(self, key)
        local scroll = self.controls.scrollBarV
        if state and state.pending and (scroll:IsScrollDownKey(key) or scroll:IsScrollUpKey(key)) then
            state.deadline = GetTime() + 150
        end
    end
    db.OnKeyUp = function(self, key, ...)
        noteScroll(self, key)
        return originalKeyUp(self, key, ...)
    end
    -- ControlHost sends hover keys separately when another control (for example
    -- the search field) owns keyboard focus. Preserve that path, including wiki.
    local originalHoverKeyUp = db.OnHoverKeyUp
    if type(originalHoverKeyUp) == "function" then
        db.OnHoverKeyUp = function(self, key, ...)
            noteScroll(self, key)
            return originalHoverKeyUp(self, key, ...)
        end
    end
    return stats
end
