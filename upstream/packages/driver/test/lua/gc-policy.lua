return function(install)
    local native = collectgarbage
    local calls, current = {}, 400
    local original = function(option, ...)
        calls[#calls+1] = {option, ...}
        if option == 'setpause' then local old=current; current=(...); return old end
        if option == 'invalid' then error('original GC error') end
        return 123, 'second return'
    end
    collectgarbage = original
    install('ui', 400)
    assert(collectgarbage == original and #calls == 0)
    install('ui', 200)
    assert(current == 200 and runtimeGCPolicy.role == 'ui')
    assert(collectgarbage('setpause',400) == 200 and current == 200)
    for _,option in ipairs({'count','collect','step','stop','restart','setstepmul'}) do
        local a,b = collectgarbage(option,17)
        assert(a==123 and b=='second return' and calls[#calls][2]==17)
    end
    assert(not pcall(collectgarbage, 'invalid'))
    collectgarbage = original
    install('helper',100)
    assert(current==100 and runtimeGCPolicy.role=='helper')
    -- Helpers lower the pause before node-power import and restore the caller's
    -- configured unique-sort pause, including the original unwrapped policy.
    for _, configured in ipairs({100,200,400}) do
        collectgarbage, current, calls = original, 400, {}
        install('helper', configured)
        local policy = runtimeGCPolicy
        assert(policy.pause==configured and policy.configuredPause==configured)
        if configured==400 then assert(collectgarbage==original and #calls==0) end
        policy.applyWorkload('nodePower')
        assert(current==100 and policy.pause==100 and policy.configuredPause==configured)
        assert(collectgarbage('setpause',400)==100 and current==100)
        for _,option in ipairs({'count','collect','step','stop','restart','setstepmul'}) do
            local a,b=collectgarbage(option,23)
            assert(a==123 and b=='second return' and calls[#calls][1]==option and calls[#calls][2]==23)
        end
        assert(not pcall(collectgarbage,'invalid'))
        local before=#calls
        policy.applyWorkload('nodePower')
        assert(#calls==before)
        policy.applyWorkload('unique')
        assert(current==configured and policy.pause==configured and policy.configuredPause==configured)
        if configured==400 then assert(collectgarbage==original) end
        policy.applyWorkload('nodePower')
        assert(current==100 and policy.pause==100)
        policy.applyWorkload('unique')
        assert(current==configured)
        assert(not pcall(policy.applyWorkload,'unknown'))
    end
    collectgarbage=original
    install('ui',200)
    assert(not pcall(runtimeGCPolicy.applyWorkload,'nodePower') and current==200)
    for _,pause in ipairs({0,99,401,200.5,math.huge,'200'}) do assert(not pcall(install,'ui',pause)) end
    assert(not pcall(install,'unknown',200))
    collectgarbage = native
    runtimeGCPolicy = nil
end
