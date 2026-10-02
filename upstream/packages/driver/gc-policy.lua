-- Host memory policy only. PoB calculations and explicit collections are intact.
return function(role, pause)
    assert(role == 'ui' or role == 'helper', 'Invalid runtime GC role')
    assert(type(pause) == 'number' and pause == math.floor(pause) and pause >= 100 and pause <= 400,
        'Invalid runtime GC pause')
    runtimeGCPolicy = {role=role, pause=pause}
    -- The original-policy switch leaves the function and boot behavior intact.
    if pause == 400 then return end
    local original = collectgarbage
    original('setpause', pause)
    collectgarbage = function(option, ...)
        if option == 'setpause' then return original(option, pause) end
        return original(option, ...)
    end
end
