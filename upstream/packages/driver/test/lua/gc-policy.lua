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
    for _,pause in ipairs({0,99,401,200.5,math.huge,'200'}) do assert(not pcall(install,'ui',pause)) end
    assert(not pcall(install,'unknown',200))
    collectgarbage = native
    runtimeGCPolicy = nil
end
