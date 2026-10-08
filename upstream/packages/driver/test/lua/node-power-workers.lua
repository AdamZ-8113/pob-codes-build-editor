return function(install)
    data = {powerStatList={{label='Offence/Defence'}, {label='Hit DPS', stat='TotalDPS'},
        {label='Full DPS', stat='FullDPS', requiresFullDPS=true}, {label='Life', stat='Life'},
        {label='Effective Hit Pool', stat='TotalEHP', requiresEHP=true},
        {label='Item quantity', stat='Quantity', ignoreForNodes=true}}}
    local enabled, sent, reply, cancelled, clock = true, nil, nil, 0, 0
    NodePowerAvailable = function() return enabled and 3 or 0 end
    CancelUniqueSort = function() cancelled = cancelled + 1 end
    GetTime = function() clock = clock + 5; return clock end
    BeginUniqueSort = function() reply=nil; return 1 end
    PollUniqueSort = function() return reply and 'reply' end
    package.loaded.dkjson = {encode=function(value) sent=value; return 'job' end, decode=function() return reply end}
    -- The indicator lifecycle is independent of helper allocation/slice policy.
    do
        local originalToast = ToastNotification
        local toasts, dismissed, notifications, shutdowns = {}, {}, 0, 0
        ToastNotification = {
            Exists=function(_,id) return toasts[id] ~= nil end,
            WasDismissed=function(_,id) return dismissed[id] == true end,
            ClearDismissed=function(_,id) dismissed[id] = nil end,
            Remove=function(_,id,immediate) assert(immediate); toasts[id] = nil end,
        }
        local function tree() return {lastProgressToastUpdate=GetTime()} end
        local build = {treeTab=tree(), Shutdown=function() shutdowns=shutdowns+1; return 'closed' end}
        local function tab()
            return {EvaluateNodePowerItem=function() end, powerBuildFlag=true,
                BuildPower=function(self)
                    self.powerBuildFlag=false; self.powerBuilder={}
                    return 'result', nil, 3
                end}
        end
        build.calcsTab=tab()
        build.powerBuilderProgressCallback=function(percent)
            assert(percent == 0, 'New reports show zero before evaluations complete')
            local now = GetTime()
            if now-build.treeTab.lastProgressToastUpdate < 100 then return end
            build.treeTab.lastProgressToastUpdate=now
            notifications=notifications+1
            build.treeTab.powerBuilderToastId=notifications
            toasts[notifications]=true
        end
        install(build)
        local a,b,c=build.calcsTab:BuildPower()
        assert(a=='result' and b==nil and c==3 and notifications==1)
        for _=1,20 do build.calcsTab:BuildPower() end
        assert(notifications==1, 'Waiting frames do not republish the toast')
        toasts[1]=nil; dismissed[1]=true
        build.calcsTab:BuildPower(); assert(notifications==1, 'Respect manual dismissal')
        build.calcsTab.powerBuildFlag=true
        build.calcsTab:BuildPower()
        assert(notifications==2 and not dismissed[1], 'Rapid restart bypasses old throttle/dismissal')
        toasts[2]=nil -- Heatmap hidden, then reopened while the report is active.
        build.calcsTab:BuildPower(); assert(notifications==3)
        local shutdown=build.Shutdown
        build.treeTab=tree(); build.calcsTab=tab(); install(build)
        assert(not toasts[3] and build.Shutdown==shutdown, 'Import clears the old tree without stacking shutdown hooks')
        build.calcsTab:BuildPower(); assert(notifications==4)
        assert(build:Shutdown()=='closed' and shutdowns==1 and not toasts[4])
        assert(build.treeTab.powerBuilderToastId==nil)
        ToastNotification=originalToast
    end
    -- A completed report must not leave an unreferenced HIDING toast on an idle
    -- canvas. PoB's completion callback clears the ID before returning.
    do
        local originalToast = ToastNotification
        local toasts, ready = {}, false
        ToastNotification = {
            ClearDismissed=function() end,
            Remove=function(_,id,immediate)
                if immediate then assert(ready); toasts[id]=nil
                elseif toasts[id] then toasts[id].mode='HIDING' end
            end,
        }
        local build = {treeTab={}, calcsTab={EvaluateNodePowerItem=function() end, BuildPower=function() end}}
        build.powerBuilderCallback = function(value)
            ready=true
            ToastNotification:Remove(build.treeTab.powerBuilderToastId)
            build.treeTab.powerBuilderToastId=nil
            return value, nil, 'complete'
        end
        install(build)
        build.treeTab.powerBuilderToastId='report'; toasts.report={mode='SHOWN'}
        local a,b,c=build.powerBuilderCallback('published')
        assert(a=='published' and b==nil and c=='complete')
        assert(not toasts.report, 'Completion removes the actual toast, not just its ID')
        assert(build.treeTab.powerBuilderToastId==nil)
        build.powerBuilderCallback('no toast') -- Dismissed/absent indicators also complete.
        ToastNotification=originalToast
    end
    local function completeReply()
        if reply then return end
        reply={}
        for i,item in ipairs(sent.items) do
            reply[i]={singleStat=string.format('%.17g',item.addNodes[1].id+0.125)}
            if sent.metric=='Offence/Defence' then reply[i].offence,reply[i].defence='1.25','-0.5' end
        end
    end
    local function setup()
        sent, reply = nil, nil
        local percentages = {}
        local build = {outputRevision=1, itemsTab={items={}}, spec={nodes={}, tree={clusterNodeMap={}}},
            percentages=percentages,
            powerBuilderProgressCallback=function(percent) percentages[#percentages+1]=percent end,
            SaveDB=function() return 'public fixture XML' end}
        local tab = {powerStat=data.powerStatList[2], nodePowerMaxDepth=5, BuildPower=function() return 'serial control' end}
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
    repeat completeReply(); local ok; ok,value=coroutine.resume(co); assert(ok,value) until coroutine.status(co)=='dead'
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
    repeat completeReply(); local success; success,precise=coroutine.resume(precisePending); assert(success,precise) until coroutine.status(precisePending)=='dead'
    assert(precise[1].singleStat==1.0000000000000002 and precise[2].singleStat==-0.125)
    assert(precise[3].singleStat==0 and 1/precise[3].singleStat==-math.huge and preciseTab.nodePowerDelegation.completed)
    local before=cancelled; t.powerBuildFlag=true
    assert(t:BuildPower()=='serial control' and cancelled==before+1)
    local b, t=setup()
    for _, kind in ipairs({'vaal','karui','eternal','maraketh','templar','kalguur','abyss_murderous'}) do
        b.itemsTab.items[1]={jewelData={conqueredBy={conqueror={type=kind}}}}
        assert(t:nodePowerBatchAvailable())
    end
    for _, depth in ipairs({0,1,5,7,10,15,100}) do t.nodePowerMaxDepth=depth; assert(t:nodePowerBatchAvailable()) end
    t.nodePowerMaxDepth=nil; assert(t:nodePowerBatchAvailable())
    for _, depth in ipairs({-1,1.5,'All',math.huge}) do t.nodePowerMaxDepth=depth; assert(not t:nodePowerBatchAvailable()) end
    t.nodePowerMaxDepth=5
    for i=1,5 do t.powerStat=data.powerStatList[i]; assert(t:nodePowerBatchAvailable()) end
    t.powerStat=data.powerStatList[6]; assert(not t:nodePowerBatchAvailable())
    t.powerStat={label='unknown'}; assert(not t:nodePowerBatchAvailable())
    t.powerStat=nil; assert(t:nodePowerBatchAvailable())
    -- Composite offence/defence values survive the remote merge, including signs.
    local _, combined, begin=setup(); combined.powerStat=nil
    local pending=begin(); reply={}
    for i,item in ipairs(sent.items) do reply[i]={singleStat='1.25',offence='1.25',defence='-0.5'} end
    local values
    repeat completeReply(); local ok; ok,values=coroutine.resume(pending); assert(ok,values) until coroutine.status(pending)=='dead'
    assert(values[1].offence==1.25 and values[1].defence==-0.5)
    assert(combined.nodePowerStatus.handedOff > 0)
    assert(combined.nodePowerStatus.remoteCompleted + combined.nodePowerStatus.localCompleted == 200)
    assert(combined.nodePowerStatus.remoteCompleted == combined.nodePowerDelegation.remote)
    assert(combined.nodePowerStatus.localCompleted == combined.nodePowerDelegation.localCount)
    -- Waiting helpers still show measured local work; the merge cannot regress.
    local progressBuild, progressTab, beginProgress=setup()
    pending=beginProgress()
    assert(progressBuild.percentages[1] > 0 and progressBuild.percentages[1] < 25)
    for _=1,20 do local success,result=coroutine.resume(pending); assert(success and result==nil) end
    assert(progressBuild.percentages[#progressBuild.percentages]==25, 'Only the completed UI quarter is counted while helpers wait')
    reply={completed=50}
    local success,result=coroutine.resume(pending); assert(success and result==nil)
    assert(progressBuild.percentages[#progressBuild.percentages]==50, 'Validated helper chunks count before the full reply')
    success,result=coroutine.resume(pending); assert(success and result==nil)
    assert(progressBuild.percentages[#progressBuild.percentages]==50, 'Polling the same chunk count never double counts')
    reply=nil
    repeat completeReply(); local success; success,values=coroutine.resume(pending); assert(success,values) until coroutine.status(pending)=='dead'
    assert(progressBuild.percentages[#progressBuild.percentages]==99, 'Reserve completion for the report callback')
    progressBuild.powerBuilderProgressCallback(10)
    assert(progressBuild.percentages[#progressBuild.percentages]==99, 'Merge progress never regresses')
    for i=2,#progressBuild.percentages do assert(progressBuild.percentages[i]>=progressBuild.percentages[i-1]) end
    progressTab.powerBuildFlag=true; progressTab:BuildPower()
    assert(progressBuild.percentages[#progressBuild.percentages]==0, 'Replacement resets progress')
    -- A completed first request and an in-flight tail share the original total.
    local handoffBuild, handoffTab, beginHandoff=setup()
    pending=beginHandoff(); completeReply()
    success,result=coroutine.resume(pending); assert(success and result==nil)
    assert(handoffTab.nodePowerStatus.handedOff > 25)
    reply={completed=25}
    success,result=coroutine.resume(pending); assert(success and result==nil)
    assert(handoffBuild.percentages[#handoffBuild.percentages] == math.floor(
        (handoffTab.nodePowerStatus.localCompleted + 150 + 25) / 200 * 100), 'Handoff progress counts each request once')
    reply=nil
    repeat completeReply(); success,values=coroutine.resume(pending); assert(success,values) until coroutine.status(pending)=='dead'
    for i=1,200 do assert(values[i].singleStat==i+0.125) end
    for _, count in ipairs({-1, 151, 1.5, '25', math.huge}) do
        local _, invalidTab, beginInvalid=setup(); pending=beginInvalid(); reply={completed=count}
        success,result=coroutine.resume(pending)
        assert(success and result==nil and coroutine.status(pending)=='dead' and invalidTab.nodePowerStatus.reason=='invalid-progress')
    end
    -- Expensive valid work must not be discarded merely because total time exceeds 60s.
    local _, slow, beginSlow=setup(); pending=beginSlow(); clock=clock+61000
    reply={}; for i,item in ipairs(sent.items) do reply[i]={singleStat='1'} end
    repeat completeReply(); local ok; ok,values=coroutine.resume(pending); assert(ok,values) until coroutine.status(pending)=='dead'
    assert(slow.nodePowerDelegation.completed)
    local staleBuild, staleTab, beginStale=setup(); pending=beginStale(); completeReply()
    local ok, result=coroutine.resume(pending); assert(ok and not result and staleTab.nodePowerStatus.handedOff)
    staleBuild.outputRevision=staleBuild.outputRevision+1; completeReply()
    ok,result=coroutine.resume(pending)
    assert(ok and result==nil and staleTab.nodePowerStatus.reason=='superseded' and not staleTab.nodePowerDelegation.completed)

end
