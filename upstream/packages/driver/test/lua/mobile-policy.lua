return function(install)
    local mobile, x, y = false, 1, 2
    IsMobileRuntime = function() return mobile end
    GetCursorPos = function() return x,y end
    local frames, flushes, compared, scored = 0, 0, 0, 0
    RequestFrames = function() frames = frames + 1 end
    flushCalculations = function() flushes = flushes + 1 end
    local function fixture()
        local build = {outputRevision=1, spec={}, viewMode="ITEMS"}
        local db = {list={}, controls={search={buf=""}}, sortMode="NAME", sortControl={NAME={}}, sortOrder={}}
        db.ListBuilder = function(self)
            if self.sortDetail and self.sortDetail.stat then scored = scored + 1 end
            self.list = {1,2,3}
        end
        local items = {activeItemSet={}, controls={uniqueDB=db}, showStatDifferences=true}
        items.AddItemTooltip = function(self, tooltip)
            tooltip:AddLine(14, "base text")
            if self.showStatDifferences then compared = compared + 1; tooltip:AddLine(14,"exact comparison") end
        end
        build.itemsTab = items
        local tooltip = {lines={}}
        tooltip.AddLine = function(self, size, text) self.lines[#self.lines+1] = {size=size,text=text} end
        tooltip.Clear = function(self) self.lines={} end
        local item = {BuildRaw=function() return "same item" end}
        return build,items,db,tooltip,item
    end
    local b,items,db,t,item = fixture()
    local original = items.AddItemTooltip
    install(b); assert(items.AddItemTooltip == original, "Desktop interaction unchanged")
    mobile = true; install(b); updateMobilePolicyVisibility()
    items:AddItemTooltip(t,item)
    assert(compared == 0 and items.showStatDifferences, "Base text does not calculate or mutate preference")
    t:Clear();items:AddItemTooltip(t,item,nil,true)
    assert(compared == 0, "Database item inspection also waits for Compare")
    requestMobileAction("compare"); t:Clear(); items:AddItemTooltip(t,item)
    assert(compared == 1 and flushes == 1, "Explicit comparison calls exact native method")
    b.outputRevision = 2; updateMobilePolicyVisibility(); t:Clear(); items:AddItemTooltip(t,item)
    assert(compared == 1, "Changed calculation revision invalidates permission")
    requestMobileAction("compare"); x=3; updateMobilePolicyVisibility(); t:Clear(); items:AddItemTooltip(t,item)
    assert(compared == 1, "Pointer movement invalidates permission")
    db.sortDetail={stat="FullDPS"}; db.sortMode="FullDPS"; db:ListBuilder()
    db.controls.search.buf="Ring"; db:ListBuilder()
    assert(scored == 0 and #db.list == 3, "Mode/filter changes only filter until explicit Sort")
    requestMobileAction("sort"); db:ListBuilder(); assert(scored == 1)
    db.controls.search.buf="Belt"; db:ListBuilder(); assert(scored == 1, "Scope changes require new Sort")
    b.viewMode="TREE"; updateMobilePolicyVisibility()
    local before=frames; updateMobilePolicyVisibility(); assert(frames==before, "Other views stay demand-driven")
    b,items,db,t,item = fixture(); install(b); items:AddItemTooltip(t,item)
    assert(compared == 1, "Replacement import cannot reuse old permission")
end
