return function(install)
    local enabled, sent, reply, cancelled, clock = true, nil, nil, 0, 0
    NodePowerAvailable = function() return enabled and 3 or 0 end
    CancelUniqueSort = function() cancelled = cancelled + 1 end
    GetTime = function() clock = clock + 5; return clock end
    BeginUniqueSort = function() return 1 end
    PollUniqueSort = function() return reply and 'reply' end
    package.loaded.dkjson = {encode=function(value) sent=value; return 'job' end, decode=function() return reply end}
    local function setup()
        sent, reply = nil, nil
        local build = {outputRevision=1, itemsTab={items={}}, spec={nodes={}, tree={clusterNodeMap={}}},
            SaveDB=function() return 'public fixture XML' end}
        local tab = {powerStat={label='Hit DPS'}, nodePowerMaxDepth=5, BuildPower=function() return 'serial control' end}
        build.calcsTab = tab
        tab.EvaluateNodePowerItem = function(_, item)
            for node in pairs(item.addNodes) do return {singleStat=node.id+0.125} end
        end
        local items = {}
        for i=1,200 do
            local node = {id=i}; build.spec.nodes[i]=node
            items[i] = {addNodes={[node]=true}}
        end
        install(build)
        local function start()
            local co = coroutine.create(function() return tab:evaluateNodePowerBatch(items) end)
            local ok, value = coroutine.resume(co); assert(ok, value)
            return co, value
        end
        return build, tab, start
    end
    local build, tab, start = setup()
    enabled=false
    local co, value=start(); assert(coroutine.status(co)=='dead' and value==nil and sent==nil)
    enabled=true
    co=start(); assert(coroutine.status(co)=='suspended' and #sent.items==150 and sent.kind=='nodePower')
    reply={}; for i,item in ipairs(sent.items) do reply[i]={singleStat=string.format('%.17g',item.addNodes[1].id+0.125)} end
    repeat local ok; ok,value=coroutine.resume(co); assert(ok,value) until coroutine.status(co)=='dead'
    for i=1,200 do assert(value[i].singleStat==i+0.125) end
    assert(tab.nodePowerDelegation.completed)
    for _, mutate in ipairs({
        function(b) b.outputRevision=b.outputRevision+1 end,
        function(_,t) t.powerBuildFlag=true end,
        function(_,t) t.powerStat={label='Life'} end,
        function(_,t) t.nodePowerMaxDepth=10 end,
        function() setup() end,
    }) do
        local b,t,s=setup(); local pending=s(); local before=cancelled; mutate(b,t)
        local ok,stale=coroutine.resume(pending); assert(ok and stale==nil and cancelled>before)
    end
    local _, t, s=setup(); local pending=s(); reply={{singleStat='NaN'}}
    local ok,bad=coroutine.resume(pending); assert(ok and bad==nil)
    -- Full-length invalid replies exercise value validation, independently of
    -- the count guard checked above. No partial results may be published.
    for _, invalid in ipairs({'NaN','inf','-inf','1e999','numeric','missing'}) do
        local _, invalidTab, startInvalid=setup(); local invalidPending=startInvalid()
        reply={}
        for i,item in ipairs(sent.items) do reply[i]={singleStat=string.format('%.17g',item.addNodes[1].id+0.125)} end
        if invalid=='numeric' then reply[1].singleStat=1
        elseif invalid=='missing' then reply[1].singleStat=nil
        else reply[1].singleStat=invalid end
        local success,result=coroutine.resume(invalidPending)
        assert(success and result==nil and coroutine.status(invalidPending)=='dead' and not invalidTab.nodePowerDelegation.completed)
    end
    local _, preciseTab, startPrecise=setup(); local precisePending=startPrecise()
    reply={}
    for i,item in ipairs(sent.items) do reply[i]={singleStat=string.format('%.17g',item.addNodes[1].id+0.125)} end
    reply[1].singleStat,reply[2].singleStat,reply[3].singleStat='1.0000000000000002','-0.125','-0'
    local precise
    repeat local success; success,precise=coroutine.resume(precisePending); assert(success,precise) until coroutine.status(precisePending)=='dead'
    assert(precise[1].singleStat==1.0000000000000002 and precise[2].singleStat==-0.125)
    assert(precise[3].singleStat==0 and 1/precise[3].singleStat==-math.huge and preciseTab.nodePowerDelegation.completed)
    local before=cancelled; t.powerBuildFlag=true
    assert(t:BuildPower()=='serial control' and cancelled==before+1)
    local b, t=setup()
    b.itemsTab.items[1]={jewelData={conqueredBy={conqueror={type='vaal'}}}}
    assert(t:nodePowerBatchAvailable())
    for _, conquered in ipairs({true, {}, {conqueror=true}, {conqueror={}}, {conqueror={type='karui'}}, {conqueror={type='eternal'}},
        {conqueror={type='maraketh'}}, {conqueror={type='templar'}}, {conqueror={type='kalguur'}},
        {conqueror={type='abyss_murderous'}}}) do
        b.itemsTab.items[2]={jewelData={conqueredBy=conquered}}
        assert(not t:nodePowerBatchAvailable())
    end
    b.itemsTab.items[2]=nil
    for _, depth in ipairs({5,10,15}) do t.nodePowerMaxDepth=depth; assert(t:nodePowerBatchAvailable()) end
    t.nodePowerMaxDepth=nil; assert(t:nodePowerBatchAvailable())
    for _, depth in ipairs({0,1,7,'All'}) do t.nodePowerMaxDepth=depth; assert(not t:nodePowerBatchAvailable()) end
    t.nodePowerMaxDepth=5; t.powerStat={label='Life'}; assert(not t:nodePowerBatchAvailable())
    t.powerStat={label='Offence/Defence'}; assert(not t:nodePowerBatchAvailable())
    t.powerStat=nil; assert(not t:nodePowerBatchAvailable())
end
