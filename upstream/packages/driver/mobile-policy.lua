-- Startup-only scheduling policy. Native UI, comparison cache and evaluator own results.
local active
local function identity(build, item, slot)
    return table.concat({ tostring(item), item:BuildRaw(), tostring(build.outputRevision),
        tostring(build.spec), tostring(slot), tostring(slot and slot.nodeId),
        tostring(slot and slot.selItemId), tostring(build.itemsTab.activeItemSet) }, "\0")
end
local function scope(db, build)
    local parts = { db.sortMode, tostring(build.outputRevision), tostring(build.spec),
        tostring(build.itemsTab.activeItemSet), tostring(build.itemsTab.activeItemSet.useSecondWeaponSet) }
    for _, name in ipairs({"slot", "type", "league", "requirement", "obtainable", "searchMode"}) do
        parts[#parts + 1] = tostring(db.controls[name] and db.controls[name].selIndex)
    end
    parts[#parts + 1] = db.controls.search.buf
    return table.concat(parts, "\0")
end
function getMobilePolicyProfile()
    local s = active
    return require("dkjson").encode(s and { comparisons = s.comparisons, inspections = s.inspections,
        sortJobs = s.sortJobs, scoredCandidates = s.scoredCandidates, sortPending = s.sortPending,
        statSort = s.build.viewMode == "ITEMS" and s.db.sortDetail ~= nil and s.db.sortDetail.stat ~= nil,
        candidates = #(s.db.list or {}), compareAvailable = s.target ~= nil and s.build.viewMode == "ITEMS" }
        or { enabled = false })
end
function updateMobilePolicyVisibility()
    local s = active
    if not s then return end
    local x, y = GetCursorPos()
    if s.x ~= x or s.y ~= y or s.revision ~= s.build.outputRevision or (s.build.viewMode ~= "ITEMS" and s.target) then
        s.allowed = nil
        if s.target then s.target.tooltip:Clear(true) end
        s.target = nil
        s.x, s.y, s.revision = x, y, s.build.outputRevision
        RequestFrames(2)
    end
end
function requestMobileAction(action)
    local s = active
    if not s or (s.build.viewMode ~= "ITEMS" and s.target) then return end
    if action == "compare" and s.target then
        flushCalculations()
        s.allowed = identity(s.build, s.target.item, s.target.slot)
        s.target.tooltip:Clear(true)
        RequestFrames(2)
    elseif action == "sort" and s.db.sortDetail and s.db.sortDetail.stat then
        flushCalculations()
        s.approved = scope(s.db, s.build)
        s.db.listBuildFlag = true
        RequestFrames(2)
    end
end
return function(build)
    active = nil
    if not IsMobileRuntime() then return end
    local items = build.itemsTab
    local db = items and items.controls.uniqueDB
    if not db then return end
    local s = { build = build, db = db, comparisons = 0, inspections = 0,
        sortJobs = 0, scoredCandidates = 0, sortPending = false }
    active = s
    local tooltip = items.AddItemTooltip
    items.AddItemTooltip = function(self, target, item, slot, dbMode, ...)
        local key = identity(build, item, slot)
        local show = self.showStatDifferences
        local compare = s.allowed == key
        -- This temporary call scope does not toggle the native control or dirty the build.
        self.showStatDifferences = compare
        local result = table.pack(pcall(tooltip, self, target, item, slot, dbMode, ...))
        self.showStatDifferences = show
        if not result[1] then error(result[2], 0) end
        s.target = { tooltip = target, item = item, slot = slot }
        s.inspections = s.inspections + 1
        if compare then s.comparisons = s.comparisons + 1 end
        if not compare then
            local last = target.lines[#target.lines]
            if last and last.text and last.text:find("Tip: Press Ctrl+D", 1, true) then table.remove(target.lines) end
            target:AddLine(14, "^8Tap Compare above for exact stat differences.")
        end
        return table.unpack(result, 2, result.n)
    end
    local listBuilder = db.ListBuilder
    db.ListBuilder = function(self, ...)
        local stat = self.sortDetail and self.sortDetail.stat
        local approved = stat and s.approved == scope(self, build)
        s.sortPending = stat ~= nil and not approved
        if not stat or approved then
            if stat then s.sortJobs = s.sortJobs + 1 end
            local result = table.pack(listBuilder(self, ...))
            if stat then s.scoredCandidates = s.scoredCandidates + #(self.list or {}) end
            return table.unpack(result, 1, result.n)
        end
        -- Filtering/name order stays immediate. Preserve selected mode and native stat cache.
        local detail, order = self.sortDetail, self.sortOrder
        self.sortDetail, self.sortOrder = nil, { self.sortControl.NAME }
        local result = table.pack(pcall(listBuilder, self, ...))
        self.sortDetail, self.sortOrder = detail, order
        if not result[1] then error(result[2], 0) end
        self.defaultText = "^7Choose filters, then tap Sort above."
        return table.unpack(result, 2, result.n)
    end
end
