-- Stage known numeric edit notifications, not partially recalculated model state.
-- Text/selection/edit-control undo update immediately. Model notifications retain
-- their original order (including configuration undo), then rebuild exactly once.
local active, typing
local enabled = true
local wrappedBuilds = setmetatable({}, { __mode = 'k' })
local totals = { queued = 0, commits = 0, notifications = 0 }
local api = {}

local function signal(pending)
    if OnCalculationPending then OnCalculationPending(pending) end
end
function api.cancel()
    if active then active.pending = nil end
    typing = nil
    signal(false)
end
function api.flush()
    local state = active
    if not state or not state.pending or state.flushing then return false end
    local transaction = state.pending
    state.pending = nil
    state.flushing = true
    local ok, err = pcall(function()
        for _, event in ipairs(transaction.events) do
            event.callback(table.unpack(event.args, 1, event.args.n))
            totals.notifications = totals.notifications + 1
        end
        state.build:DesktopEnsureOutputs()
    end)
    state.flushing = false
    signal(false)
    if not ok then error(err, 0) end
    totals.commits = totals.commits + 1
    return true
end
function api.configure(value)
    api.flush()
    enabled = value ~= false
end
function api.profile()
    return '{"pending":' .. tostring(active ~= nil and active.pending ~= nil)
        .. ',"queued":' .. totals.queued .. ',"commits":' .. totals.commits
        .. ',"notifications":' .. totals.notifications .. '}'
end

local function continuous(event)
    local key = event.key or ''
    return (event.type == 'Char' and (key:match('^[%d%.%-]$') or key == '\b'))
        or ((event.type == 'KeyDown' or event.type == 'KeyUp')
            and (key:match('^[%d%.%-]$') or key == 'BACK' or key == 'DELETE'))
end
function api.beforeFrame(events)
    local state = active
    if not state or not state.pending then return end
    local p, build = state.pending, state.build
    local now = GetTime()
    local flush = now - p.last >= 150 or now - p.first >= 250
        or build.buildFlag or build.viewMode ~= p.view or not p.control.hasFocus
        or not p.control:IsMouseInBounds() or IsKeyDown('CTRL') or IsKeyDown('ALT')
    for _, event in pairs(events or {}) do if not continuous(event) then flush = true end end
    if flush then api.flush() end
end
function api.afterFrame()
    if active and active.pending then RequestFrames(1) end
end

local function wrapControl(control)
    if not control or type(control.changeFunc) ~= 'function' or type(control.OnChar) ~= 'function'
        or not (control.filter == '%D' or control.filter == '^%-%d' or control.filter == '^%d.') then return end
    local callback = control.changeFunc
    control.changeFunc = function(...)
        local state = active
        if enabled and state and not state.flushing and typing == control and control.hasFocus then
            if state.pending and state.pending.control ~= control then api.flush() end
            local now = GetTime()
            local p = state.pending or { control = control, events = {}, first = now, view = state.build.viewMode }
            p.last = now
            p.events[#p.events + 1] = { callback = callback, args = table.pack(...) }
            state.pending = p
            totals.queued = totals.queued + 1
            signal(true)
            RequestFrames(1)
            if #p.events >= 64 then api.flush() end
        else
            api.flush()
            return callback(...)
        end
    end
    for _, name in ipairs({'OnChar', 'OnKeyDown'}) do
        local original = control[name]
        control[name] = function(self, key, ...)
            local prior = typing
            local mayStage = not IsKeyDown('CTRL') and not IsKeyDown('ALT') and
                ((name == 'OnChar' and key:match('^[%d%.%-]$')) or key == 'BACK' or key == 'DELETE')
            typing = mayStage and self or nil
            local result = table.pack(pcall(original, self, key, ...))
            typing = prior
            if not result[1] then api.cancel(); error(result[2], 0) end
            return table.unpack(result, 2, result.n)
        end
    end
    local focusLost = control.OnFocusLost
    control.OnFocusLost = function(self, ...)
        api.flush()
        if focusLost then return focusLost(self, ...) end
    end
    -- No stale derived values in the edited field's tooltip while text is pending.
    local tooltip = control.tooltipFunc
    if type(tooltip) == 'function' then
        control.tooltipFunc = function(...)
            if active and active.pending and active.pending.control == control then return end
            return tooltip(...)
        end
    end
end

local function flushBefore(object, name, onlyIfWorking)
    local original = object[name]
    if type(original) ~= 'function' then error('Desktop scheduler: unsupported ' .. name) end
    object[name] = function(self, ...)
        if not onlyIfWorking or self.powerBuilder or self.powerBuildFlag then api.flush() end
        return original(self, ...)
    end
end
function api.install(build)
    if type(build.DesktopEnsureOutputs) ~= 'function' or not build.configTab or not build.calcsTab then
        error('Desktop scheduler: unsupported pinned build interface')
    end
    api.cancel()
    active = { build = build }
    if not wrappedBuilds[build] then
        wrappedBuilds[build] = true
        for _, name in ipairs({'SaveDB', 'Shutdown', 'AddStatComparesToTooltip'}) do flushBefore(build, name) end
    end
    wrapControl(build.controls.characterLevel)
    for _, control in pairs(build.configTab.varControls) do wrapControl(control) end
    -- Comparison/cache entry points must see a completed revision. GetMiscCalculator
    -- can also be called by the rebuild itself; state.flushing prevents recursion.
    flushBefore(build.calcsTab, 'GetMiscCalculator')
    flushBefore(build.calcsTab, 'BuildPower', true)
    flushBefore(build.itemsTab, 'AddItemStatDifferences')
    flushBefore(build.configTab, 'UpdateControls')
end
return api
