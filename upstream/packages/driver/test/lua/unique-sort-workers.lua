return function(install)
    local enabled, reply, sent, cancellations = true, nil, nil, 0
    package.loaded.dkjson = {
        encode = function(value) sent = value; return 'encoded job' end,
        decode = function() return reply end,
    }
    UniqueSortAvailable = function() return enabled and 3 or 0 end
    local clock = 0
    GetTime = function() clock=clock+1; return clock end
    CancelUniqueSort = function() cancellations = cancellations + 1 end
    BeginUniqueSort = function() return 1 end
    PollUniqueSort = function() return reply and 'encoded reply' end
    local function setup()
        reply = nil
        local list, db = {}, {db={list={}}, sortMode='Life', sortDetail={stat='Life'}}
        for i = 1, 25 do
            local item = {index=i, BuildRaw=function() return 'raw-' .. i end}
            list[i], db.db.list['key-'..i] = item, item
        end
        local build = {outputRevision=1, calcsTab={GetMiscCalculator=function() return 'original calculator' end}, itemsTab={activeItemSet={useSecondWeaponSet=false}, controls={uniqueDB=db}},
            SaveDB=function() return 'complete build XML' end}
        build.itemsTab.build = build
        db.itemsTab = build.itemsTab
        db.EvaluateItemPower = function(_, item, calc, full)
            assert(calc=='original calculator' and full==false)
            return item.index
        end
        db.ListBuilder = function(self) return self:evaluateItemBatch(list) end
        install(build)
        local function start()
            local co = coroutine.create(function() return db:ListBuilder() end)
            local ok, result = coroutine.resume(co); assert(ok, result)
            return co, result
        end
        return build, db, list, start
    end
    local build, db, list, start = setup()
    enabled = false
    local co, result = start(); assert(coroutine.status(co)=='dead' and result==nil)
    enabled = true
    co = start(); assert(coroutine.status(co)=='suspended')
    assert(db.defaultText=='^7Sorting... (24%)', 'Show the completed UI share while helpers wait')
    local waitingOk = coroutine.resume(co); assert(waitingOk)
    assert(db.defaultText=='^7Sorting... (24%)', 'Waiting does not invent helper progress')
    assert(sent.xml=='complete build XML' and sent.sortMode=='Life' and #sent.items==19)
    assert(sent.items[1].key=='key-1' and sent.items[1].raw=='raw-1')
    reply = {}; for i,item in ipairs(sent.items) do reply[i]=item.key:match('%d+') end; reply[1],reply[2]='0','-inf'
    local ok, values = coroutine.resume(co); assert(ok, values)
    assert(values[list[1]]==0 and values[list[2]]==-math.huge and values[list[25]]==25)
    local _,_,exactList,exactStart=setup(); local exactPending=exactStart()
    local precise=2059492758.8581235
    reply={}; for i=1,19 do reply[i]=string.format('%.17g', precise) end
    local exactOk,exactValues=coroutine.resume(exactPending)
    assert(exactOk and exactValues[exactList[1]]==precise)
    for _, mutate in ipairs({
        function(b) b.outputRevision=b.outputRevision+1 end,
        function(_,d) d.sortMode='Armour' end,
        function(b) b.itemsTab.activeItemSet={useSecondWeaponSet=true} end,
        function(_,_,s) s() end, -- replacement list (filter/slot/set selection)
        function() setup() end, -- different build with the same revision number
    }) do
        local b,d,_,s=setup(); local pending=s(); local previous=cancellations
        mutate(b,d,s)
        reply={}; for i=1,25 do reply[i]=999 end
        local success, stale=coroutine.resume(pending); assert(success and stale==nil)
        assert(cancellations>previous)
    end
    local _,_,_,s=setup(); local pending=s(); reply={1,2}
    local success, malformed=coroutine.resume(pending); assert(success and malformed==nil)
end
