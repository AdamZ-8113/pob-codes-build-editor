local now, notices, frames = 0, {}, 0
GetTime = function() return now end
IsKeyDown = function() return false end
OnCalculationPending = function(value) notices[#notices + 1] = value end
RequestFrames = function() frames = frames + 1 end
local scheduler = calculationScheduler
local function makeBuild()
    local build = { value = 1, output = 1, outputRevision = 0, buildFlag = false,
        viewMode = 'TREE', undo = {}, controls = {} }
    function build:DesktopEnsureOutputs()
        if self.buildFlag then
            self.output = self.value
            self.outputRevision = self.outputRevision + 1
            self.buildFlag = false
        end
    end
    function build:SaveDB() assert(self.value == self.output); return self.output end
    function build:Shutdown() assert(self.value == self.output) end
    function build:AddStatComparesToTooltip() assert(self.value == self.output) end
    build.calcsTab = { GetMiscCalculator = function() assert(build.value == build.output) end,
        BuildPower = function() assert(build.value == build.output) end }
    build.itemsTab = { AddItemStatDifferences = function() assert(build.value == build.output) end }
    build.configTab = { varControls = {}, UpdateControls = function() assert(build.value == build.output) end }
    local control = { filter = '%D', hasFocus = true, inside = true, buf = '1' }
    function control:IsMouseInBounds() return self.inside end
    control.changeFunc = function(value)
        if build.fail then error('notification failed') end
        build.value = tonumber(value)
        build.undo[#build.undo + 1] = build.value
        build.buildFlag = true
    end
    function control:OnChar(key) self.buf = key; self.changeFunc(key); return self, nil, true end
    control.OnKeyDown = control.OnChar
    control.tooltipFunc = function() return build.output end
    build.controls.characterLevel = control
    scheduler.install(build)
    return build, control
end
local function edit(control, value)
    scheduler.beforeFrame({{ type = 'Char', key = value }})
    local self, missing, done = control:OnChar(value)
    assert(self == control and missing == nil and done == true)
    scheduler.afterFrame()
end
local build, control = makeBuild()
-- Ten edits across ten distinct synthetic frames inside a 150ms window.
for i = 0, 9 do now = i * 10; edit(control, tostring(i)) end
assert(build.value == 1 and build.output == 1 and build.outputRevision == 0)
assert(control.buf == '9' and control.tooltipFunc() == nil)
assert(#build.undo == 0 and frames >= 10)
now = 239; scheduler.beforeFrame({}); assert(build.outputRevision == 0)
now = 240; scheduler.beforeFrame({})
assert(build.outputRevision == 1 and build.value == 9 and build.output == 9)
assert(#build.undo == 10 and build.undo[1] == 0 and build.undo[10] == 9)
assert(notices[#notices] == false and control.tooltipFunc() == 9)
-- Every live-state consumer must flush before using a calculation snapshot.
for _, action in ipairs({
    function(b,c) b:SaveDB() end,
    function(b,c) b:Shutdown() end,
    function(b,c) b:AddStatComparesToTooltip() end,
    function(b,c) b.calcsTab:GetMiscCalculator() end,
    function(b,c) b.calcsTab.powerBuildFlag = true; b.calcsTab:BuildPower() end,
    function(b,c) b.itemsTab:AddItemStatDifferences() end,
    function(b,c) b.configTab:UpdateControls() end,
    function(b,c) c:OnFocusLost() end,
    function(b,c) c.inside = false; scheduler.beforeFrame({}) end,
    function(b,c) b.viewMode = 'ITEMS'; scheduler.beforeFrame({}) end,
    function(b,c) scheduler.beforeFrame({{type='KeyUp',key='LEFTBUTTON'}}) end,
    function(b,c) scheduler.beforeFrame({{type='KeyDown',key='RETURN'}}) end,
    function(b,c) scheduler.beforeFrame({{type='KeyDown',key='TAB'}}) end,
}) do
    build, control = makeBuild(); edit(control, '7'); action(build, control)
    assert(build.output == 7 and build.outputRevision == 1)
end
-- Continuous input cannot postpone updates indefinitely.
now = 0; build, control = makeBuild()
for i = 0, 5 do now = i * 40; edit(control, tostring(i)) end
now = 250; scheduler.beforeFrame({}); assert(build.outputRevision == 1)
-- Queue stays bounded, notifications and undo entries are not collapsed.
build, control = makeBuild()
for i = 1, 64 do edit(control, '2') end
assert(build.outputRevision == 1 and #build.undo == 64)
-- Programmatic mutation flushes prior edits and preserves synchronous behavior.
build, control = makeBuild(); edit(control, '7'); control.changeFunc('8')
assert(build.output == 7 and build.value == 8); build:DesktopEnsureOutputs()
assert(build.output == 8)
-- Error/cancellation/import cannot strand pending UI status or old callbacks.
build, control = makeBuild(); edit(control, '9'); scheduler.cancel()
assert(not scheduler.flush() and build.value == 1 and notices[#notices] == false)
build, control = makeBuild(); edit(control, '7'); build.fail = true
assert(not pcall(scheduler.flush))
assert(notices[#notices] == false and not scheduler.flush())
build, control = makeBuild(); scheduler.configure(false); edit(control, '7')
assert(build.value == 7 and not scheduler.profile():find('"pending":true'))
scheduler.configure(true)
build:DesktopEnsureOutputs()
assert(build.output == 7)
-- Installing on the same build does not stack persistent build wrappers.
scheduler.install(build); edit(control, '8'); assert(build:SaveDB() == 8)
