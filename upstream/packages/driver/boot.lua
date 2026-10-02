-- pob-web: Path of Building Web

package.path = package.path .. ";/app/root/lua/?.lua;/app/root/lua/?/init.lua"

unpack = table.unpack
loadstring = load

bit = {
    lshift = bit32.lshift,
    rshift = bit32.rshift,
    band = bit32.band,
    bor = bit32.bor,
    bxor = bit32.bxor,
    bnot = bit32.bnot,
    tobit = function(value)
        local normalized = value % 0x100000000
        return normalized >= 0x80000000 and normalized - 0x100000000 or normalized
    end,
}

if not setfenv then -- Lua 5.2
    -- based on http://lua-users.org/lists/lua-l/2010-06/msg00314.html
    -- this assumes f is a function
    local function findenv(f)
        local level = 1
        repeat
            local name, value = debug.getupvalue(f, level)
            if name == '(luajit-env)' then return level, value end
            level = level + 1
        until name == nil
        return nil end
    getfenv = function (f) return(select(2, findenv(f)) or _G) end
    setfenv = function (f, t)
        local level = findenv(f)
        if level then debug.setupvalue(f, level, t) end
        return f end
end

arg = {}

jit = {
  opt = {
    start = function() end,
    stop = function() end,
  }
}

local coroutineYield = coroutine.yield
coroutine.yield = function(...)
    RequestFrames(2)
    return coroutineYield(...)
end

-- Rendering
function SetClearColor(r, g, b, a)
end
function StripEscapes(text)
    return text:gsub("%^%d", ""):gsub("%^x%x%x%x%x%x%x", "")
end
function GetAsyncCount()
    return 0
end

-- General Functions
function SetCursorPos(x, y)
end
function ShowCursor(doShow)
end
function GetScriptPath()
    return "."
end
function GetRuntimePath()
    return ""
end
function GetUserPath()
    return "/app/user"
end
function GetCloudProvider(_)
    return nil, nil, nil
end
function SetWorkDir(path)
    print("SetWorkDir: " .. path)
end
function GetWorkDir()
    return ""
end
function LoadModule(fileName, ...)
    if not fileName:match("%.lua") then
        fileName = fileName .. ".lua"
    end
    local func, err = loadfile(fileName)
    if func then
        return func(...)
    else
        error("LoadModule() error loading '" .. fileName .. "': " .. err)
    end
end
function PLoadModule(fileName, ...)
    if not fileName:match("%.lua") then
        fileName = fileName .. ".lua"
    end
    local func, err = loadfile(fileName)
    if func then
        return PCall(func, ...)
    else
        error("PLoadModule() error loading '" .. fileName .. "': " .. err)
    end
end

local debug = require "debug"
function PCall(func, ...)
    local ret = { xpcall(func, debug.traceback, ...) }
    if ret[1] then
        table.remove(ret, 1)
        return nil, unpack(ret)
    else
        return ret[2]
    end
end

function ConPrintf(fmt, ...)
    -- Optional
    print(string.format(fmt, ...))
end
function ConPrintTable(tbl, noRecurse)
end
function ConExecute(cmd)
end
function ConClear()
end
function SpawnProcess(cmdName, args)
end
function SetProfiling(isEnabled)
end
function Restart()
end
function Exit()
end
function SetForeground()
end

dofile("Launch.lua")

--
-- pob-web related custom code
--
local mainObject = GetMainObject()
flushCalculations = calculationScheduler.flush
configureCalculationScheduling = calculationScheduler.configure
getCalculationSchedulingProfile = calculationScheduler.profile

-- Disable the check for updates because we can't update the app
mainObject["CheckForUpdate"] = function(this)
end

-- Install the error handler
local showErrMsg = mainObject["ShowErrMsg"]
mainObject["ShowErrMsg"] = function(self, msg, ...)
    calculationScheduler.cancel()
    OnError(string.format(msg, ...))
    showErrMsg(self, msg, ...)
end

-- Hide the check for updates button
local function installOAuthLogoutHook(buildMode)
    local importTab = buildMode.importTab
    local logoutButton = importTab and importTab.controls and importTab.controls.logoutApiButton
    if logoutButton and type(logoutButton.onClick) == "function" then
        local logout = logoutButton.onClick
        logoutButton.onClick = function(...)
            logout(...)
            OnOAuthLogout()
        end
    end
end

local onInit = mainObject["OnInit"]
mainObject["OnInit"] = function(self)
    onInit(self)
    self.main.controls.checkUpdate.shown = function()
        return false
    end
    local buildMode = self.main.modes["BUILD"]
    local frame = self.main.OnFrame
    self.main.OnFrame = function(main, ...)
        if main.newMode then calculationScheduler.flush() end
        calculationScheduler.beforeFrame(main.inputEvents)
        local result = table.pack(pcall(frame, main, ...))
        if not result[1] then calculationScheduler.cancel(); error(result[2], 0) end
        calculationScheduler.afterFrame()
        updateUniqueComparisonVisibility()
        return table.unpack(result, 2, result.n)
    end
    local initBuild = buildMode.Init
    buildMode.Init = function(build, ...)
        -- The build object is reused on import. Release a previously focused
        -- top-level control before replacing its controls and callbacks.
        calculationScheduler.flush()
        build:SelectControl(nil)
        calculationScheduler.cancel()
        initBuild(build, ...)
        installOAuthLogoutHook(build)
        local tooltipCacheMode = GetRuntimeItemTooltipCacheMode()
        installItemTooltipCache(build, nil, tooltipCacheMode == 1 and 'operations' or tooltipCacheMode == -1 and 'off' or 'calculator')
        installRuntimeProfile(build)
        calculationScheduler.install(build)
        installUniqueComparisonDelay(build)
        installUniqueSortWorkers(build)
    end
end

local function runCallback(name, ...)
    local callback = GetCallback(name)
    if callback then
        return callback(...)
    end
    if mainObject and type(mainObject[name]) == "function" then
        return mainObject[name](mainObject, ...)
    end
    error("runCallback: no handler for '" .. tostring(name) .. "'")
end

function loadBuildFromCode(code)
    calculationScheduler.flush()
    if not mainObject.main then
        error("loadBuildFromCode: mainObject.main is nil")
    end

    -- Flush any pending state before import
    runCallback("OnFrame")

    if mainObject.main.mode ~= "BUILD" then
        mainObject.main:SetMode("BUILD", false, "")
        runCallback("OnFrame")
    end

    local importTab = mainObject.main.modes["BUILD"]
        and mainObject.main.modes["BUILD"].importTab
    if not importTab or not importTab.controls then
        error("loadBuildFromCode: import tab controls not available")
    end

    importTab.controls.importCodeIn:SetText(code, true)
    importTab.controls.importCodeMode.selIndex = 2
    importTab.controls.importCodeGo.onClick()

    -- Flush to process the import
    runCallback("OnFrame")
end

function getBuildCode()
    calculationScheduler.flush()
    if not mainObject.main then
        error("getBuildCode: mainObject.main is nil")
    end

    local build = mainObject.main.modes["BUILD"]
    if not build then
        error("getBuildCode: not in BUILD mode")
    end

    local xmlText = build:SaveDB("code")
    if not xmlText then
        error("getBuildCode: SaveDB returned nil")
    end

    return common.base64.encode(Deflate(xmlText)):gsub("+","-"):gsub("/","_")
end

-- Apply a bounded configuration transaction to the same BUILD instance that
-- is drawn and exported. The browser owns automatic/manual precedence; this
-- native boundary owns option validation, an exact snapshot, rollback and the
-- normal ConfigTab undo/rebuild hooks.
function applyBuildConfiguration(requestJson)
    local json = require "dkjson"
    local request, _, decodeError = json.decode(requestJson)
    if decodeError or type(request) ~= "table" or request.version ~= 1 or type(request.writes) ~= "table" or #request.writes < 1 or #request.writes > 64 then
        return json.encode({ ok = false, error = "invalid configuration transaction" })
    end
    local build = mainObject.main and mainObject.main.modes["BUILD"]
    local configTab = build and build.configTab
    local configSet = configTab and configTab.configSets and configTab.configSets[configTab.activeConfigSetId]
    if not configSet or type(configSet.input) ~= "table" then
        return json.encode({ ok = false, error = "native configuration is unavailable" })
    end
    local before = copyTable(configSet.input)
    local function rollback(message)
        wipeTable(configSet.input)
        for key, value in pairs(before) do configSet.input[key] = value end
        pcall(function() configTab:UpdateControls(); configTab:BuildModList(); build.buildFlag = true end)
        return json.encode({ ok = false, error = tostring(message) })
    end
    local ok, failure = pcall(function()
        for _, write in ipairs(request.writes) do
            local key = write.key
            local control = type(key) == "string" and configTab.varControls[key]
            if type(key) ~= "string" or not key:match("^[A-Za-z][A-Za-z0-9_]*$") or #key > 64 or not control then error("unsupported configuration key") end
            if write.operation == "clear" then
                configSet.input[key] = nil
            elseif write.operation == "set" then
                local valueType = type(write.value)
                if valueType ~= "boolean" and valueType ~= "number" and valueType ~= "string" then error("unsupported configuration value") end
                if valueType == "number" and (write.value ~= write.value or write.value == math.huge or write.value == -math.huge) then error("invalid configuration number") end
                if valueType == "string" and #write.value > 4096 then error("configuration string is too large") end
                if control._className == "CheckBoxControl" and valueType ~= "boolean" then error("configuration type mismatch") end
                if control._className == "DropDownControl" and type(control.list) == "table" then
                    local found = false
                    for _, entry in ipairs(control.list) do if entry.val == write.value then found = true; break end end
                    if not found then error("configuration list value is unsupported") end
                end
                local expected = configSet.input[key]
                if expected == nil then expected = configTab:GetDefaultState(key) end
                if expected ~= nil and type(expected) ~= valueType then error("configuration type mismatch") end
                configSet.input[key] = write.value
            else
                error("unsupported configuration operation")
            end
        end
        configTab:AddUndoState()
        configTab:UpdateControls()
        configTab:BuildModList()
        build.buildFlag = true
        calculationScheduler.flush()
    end)
    if not ok then return rollback(failure) end
    return json.encode({ ok = true })
end
