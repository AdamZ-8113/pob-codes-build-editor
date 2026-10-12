-- Host bridge for build-list state and refresh. PoB remains authoritative for
-- mode transitions, paths, scaling, list construction, and selection.
return function(main, emit, requestFrames, getScale)
    assert(type(main) == "table")
    assert(type(emit) == "function")
    local previous
    local host = {}

    local function state()
        local mode = type(main.mode) == "string" and main.mode or ""
        local list = main.modes and main.modes.LIST
        local subPath = mode == "LIST" and list and list.subPath or ""
        return {
            mode = mode,
            subPath = type(subPath) == "string" and subPath or "",
            buildPath = type(main.buildPath) == "string" and main.buildPath or "",
            virtualWidth = tonumber(main.screenW) or 0,
            virtualHeight = tonumber(main.screenH) or 0,
            uiScale = tonumber(getScale()) or 1,
        }
    end

    function host:observe()
        local current = state()
        local key = table.concat({
            current.mode, current.subPath, current.buildPath,
            tostring(current.virtualWidth), tostring(current.virtualHeight), tostring(current.uiScale),
        }, "\0")
        if key == previous then return false end
        previous = key
        emit(current.mode, current.subPath, current.buildPath,
            current.virtualWidth, current.virtualHeight, current.uiScale)
        return true
    end

    function host:refresh()
        local list = main.modes and main.modes.LIST
        if main.mode ~= "LIST" or not list or type(list.BuildList) ~= "function" then return false end
        list:BuildList()
        requestFrames(2)
        self:observe()
        return true
    end

    return host
end
