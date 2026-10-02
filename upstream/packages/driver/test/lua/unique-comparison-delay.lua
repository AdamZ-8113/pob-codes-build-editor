return function(install)
    local now, requests, shift, calculations, baseCalls = 0, 0, false, 0, 0
    GetTime = function() return now end
    RequestFrames = function(n) assert(n == 2); requests = requests + 1 end
    IsKeyDown = function(key) return key == "SHIFT" and shift end
    main, launch = { popups = {} }, { devModeAlt = false }
    local a, b = {}, {}
    local tooltip = { lines = {} }
    function tooltip:Clear(update) self.lines = {}; if update then self.params = nil end end
    function tooltip:CheckForUpdate(item, modifier, debugMode, revision)
        local key = { item, modifier, debugMode, revision }
        local old = self.params
        self.params = key
        for i = 1, 4 do if not old or key[i] ~= old[i] then self:Clear(); return true end end
    end
    function tooltip:AddLine(_, text) self.lines[#self.lines + 1] = text end
    function tooltip:AddSeparator() end
    local build = { outputRevision = 1, viewMode = "ITEMS" }
    local items = { showStatDifferences = true, controls = {} }
    build.itemsTab = items
    local fail = false
    local exact = function(self, target, item, argument)
        assert(argument == "original argument")
        if fail then error("original comparison failed") end
        calculations = calculations + 1
        target:AddLine(14, "exact " .. tostring(build.outputRevision))
        return 42, nil, true
    end
    items.AddItemStatDifferences = exact
    local scroll = { offset = 0 }
    function scroll:IsScrollDownKey(key) return key == "WHEELDOWN" or key == "PAGEDOWN" end
    function scroll:IsScrollUpKey(key) return key == "WHEELUP" or key == "PAGEUP" end
    local db = { controls = { scrollBarV = scroll }, hover = a, index = 1 }
    items.controls.uniqueDB = db
    function db:AddValueTooltip(target, index, item)
        if main.popups[1] then target:Clear(); return end
        if target:CheckForUpdate(item, shift, launch.devModeAlt, build.outputRevision) then
            baseCalls = baseCalls + 1
            target:AddLine(14, "base")
            if items.showStatDifferences then items:AddItemStatDifferences(target, item, "original argument") end
        end
        return 7, nil, 9
    end
    local list = {}
    function list:Draw() if self.hover then return self:AddValueTooltip(tooltip, self.index, self.hover) end end
    -- Match Common.lua's parent proxy: an instance Draw override takes priority
    -- even when the original ItemDB Draw explicitly calls ListControl.Draw.
    db.ListControl = setmetatable({}, { __index = function(_, key) return rawget(db, key) or list[key] end })
    setmetatable(db, { __index = { Draw = function(self) return self.ListControl.Draw(self) end } })
    function db:OnKeyUp() return self, nil, 3 end
    function db:OnHoverKeyUp() return "wiki handler", nil, 4 end
    local stats = install(build)
    assert(install(build) == stats, "Double installation must not wrap twice")
    local function frame(time, item)
        now, db.hover = time, item
        return db:Draw()
    end
    local x,y,z = frame(0, a)
    assert(x == 7 and y == nil and z == 9)
    assert(baseCalls == 1 and calculations == 0 and stats.pending)
    assert(tooltip.lines[1] == "base" and tooltip.lines[2]:find("pending"))
    frame(50, b); frame(100, a); frame(249, a)
    assert(calculations == 0 and requests >= 4, "Transient rows must not calculate")
    frame(250, a)
    assert(calculations == 1 and not stats.pending and tooltip.lines[2] == "exact 1")
    local completeRequests = requests
    frame(266, a); frame(300, a)
    assert(calculations == 1 and requests == completeRequests, "Completed tooltip stays cached and stops frames")
    -- Calls outside uniqueDB remain immediate, with their complete return tuple.
    x,y,z = items:AddItemStatDifferences(tooltip, b, "original argument")
    assert(x == 42 and y == nil and z == true and calculations == 2)
    frame(310, b); frame(330, nil); frame(500, b); frame(649, b)
    assert(calculations == 2 and stats.pending, "Leaving and returning resets the delay")
    frame(650, b); assert(calculations == 3 and not stats.pending)
    frame(660, a); now = 750; db:OnKeyUp("WHEELDOWN")
    frame(850, a); assert(calculations == 3 and stats.pending)
    frame(900, a); assert(calculations == 4 and not stats.pending)
    -- Scroll position, modifiers and output revisions restart a pending row.
    frame(920, b); scroll.offset = 16; frame(1000, b)
    shift = true; frame(1100, b); build.outputRevision = 2; frame(1200, b)
    frame(1349, b); assert(calculations == 4)
    frame(1350, b); assert(calculations == 5 and tooltip.lines[2] == "exact 2")
    frame(1360, a); main.popups[1] = {}; frame(1370, a)
    assert(not stats.pending and #tooltip.lines == 0)
    main.popups = {}; frame(1380, a); items.showStatDifferences = false; frame(1390, a)
    assert(not stats.pending and tooltip.lines[1] == "base" and #tooltip.lines == 1)
    items.showStatDifferences = true; frame(1400, a); frame(2000, a)
    assert(calculations == 5 and stats.pending, "Background/other-screen gaps restart pending hover")
    frame(2150, a); assert(calculations == 6 and not stats.pending)
    frame(2160, b); fail = true; now = 2310
    local ok, why = pcall(db.Draw, db)
    assert(not ok and why:find("original comparison failed", 1, true))
    assert(items.AddItemStatDifferences == exact and not stats.pending, "Exceptions restore wrappers and cancel pending")
    fail = false; frame(2400, a); now = 2500
    x,y,z = db:OnHoverKeyUp("WHEELUP")
    assert(x == "wiki handler" and y == nil and z == 4)
    frame(2649, a); assert(calculations == 6 and stats.pending)
    frame(2650, a); assert(calculations == 7 and not stats.pending)
    frame(2660, b)
    assert(getUniqueComparisonProfile():find('"pending":true', 1, true))
    build.viewMode = "TREE"
    assert(getUniqueComparisonProfile():find('"pending":false', 1, true))
    updateUniqueComparisonVisibility()
    assert(not stats.pending, "Leaving Items cancels even a short pending hover")
    build.viewMode = "ITEMS"; frame(2700, b); frame(2849, b)
    assert(calculations == 7 and stats.pending)
    frame(2850, b); assert(calculations == 8 and not stats.pending)
end
