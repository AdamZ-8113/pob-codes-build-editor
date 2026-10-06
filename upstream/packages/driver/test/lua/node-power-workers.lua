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
    local before=cancelled; t.powerBuildFlag=true
    assert(t:BuildPower()=='serial control' and cancelled==before+1)
    local b, t=setup(); b.itemsTab.items[1]={jewelData={conqueredBy={}}}
    assert(not t:nodePowerBatchAvailable())
end
