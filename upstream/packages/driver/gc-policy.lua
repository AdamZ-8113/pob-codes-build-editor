-- Host memory policy only. PoB calculations and explicit collections are intact.
return function(role, pause)
    assert(role == 'ui' or role == 'helper', 'Invalid runtime GC role')
    assert(type(pause) == 'number' and pause == math.floor(pause) and pause >= 100 and pause <= 400,
        'Invalid runtime GC pause')
    local original = collectgarbage
    local policy = {role=role, pause=pause, configuredPause=pause}
    runtimeGCPolicy = policy
    local function controlled(option, ...)
        if option == 'setpause' then return original(option, policy.pause) end
        return original(option, ...)
    end
    local function apply(activePause)
        policy.pause = activePause
        original('setpause', activePause)
        collectgarbage = activePause == 400 and original or controlled
    end
    policy.applyWorkload = function(kind)
        assert(role == 'helper' and (kind == 'nodePower' or kind == 'unique'), 'Invalid GC workload')
        local activePause = kind == 'nodePower' and 100 or pause
        if policy.pause ~= activePause then apply(activePause) end
    end
    -- Preserve original-policy boot and restore its unwrapped function when a
    -- helper returns from node-power work to its configured unique-sort policy.
    if pause ~= 400 then apply(pause) end
end
