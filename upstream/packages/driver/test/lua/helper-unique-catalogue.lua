return function(create, source)
    local parsed, finishes = {}, 0
    local rawA,rawB,rawF,rawV='Alpha\nBase A','Alpha\nBase B','Foulborn Beta\nBase C','Gamma (Legacy)\nBase D'
    local definitions={
        [rawA]={base=true,name='Alpha, Base A'},
        [rawB]={base=true,name='Alpha, Base B'},
        [rawF]={base=true,name='Beta, Base C'},
        [rawV]={base=true,name='Gamma, Base D'},
    }
    local rawHeader='Item Class: Jewels\nRarity: UNIQUE\n--------\nHeader Title\nBase E'
    definitions[rawHeader]={base=true,name='Header Title, Base E'}
    local existing={base=true,name='Existing, Base'}
    local db={list={['Existing, Base']=existing}}
    local resolve=create({one={rawA,rawB,rawF,rawV,rawHeader,'Unknown shape\nBase'}},db,function(raw)
        parsed[raw]=(parsed[raw] or 0)+1
        return definitions[raw] or {base=true,name='Fallback, Base'}
    end,function() finishes=finishes+1;db.list['Fallback, Base']={base=true,name='Fallback, Base'} end)
    assert(resolve('Existing, Base')==existing and next(parsed)==nil)
    assert(resolve('Alpha, Base A').name=='Alpha, Base A')
    assert(resolve('Alpha, Base B').name=='Alpha, Base B')
    assert(parsed[rawA]==1 and parsed[rawB]==1 and finishes==0)
    assert(resolve('Beta, Base C').name=='Beta, Base C' and finishes==0)
    assert(resolve('Gamma, Base D').name=='Gamma, Base D' and finishes==0)
    assert(resolve('Header Title, Base E').name=='Header Title, Base E' and finishes==0)
    assert(resolve('Fallback, Base').name=='Fallback, Base' and finishes==1)
    assert(resolve('Missing, Base')==nil and finishes==2)
    assert(resolve('Alpha, Wrong Base')==nil and finishes==3)
    assert(resolve(nil)==nil and resolve({})==nil and finishes==3)
    assert(resolve('Alpha, Base A')==db.list['Alpha, Base A'])

    -- Exercise the real helper entry point: imports must remain lazy, while
    -- candidate raw edits, operation identity and the original fallback remain
    -- authoritative. Calculator doubles expose stale build/operation reuse.
    local imports, frames, collections, calls = 0, 0, 0, 0
    local tick, timeout, seen = 0, false, {}
    local rawNew='New Title\nBase N'
    local definitions={
        [rawA]={name='Alpha, Base A',power=1.2345678901234567},
        [rawNew]={name='New Title, Base N',power=2.3456789012345678},
        edited={name='Alpha, Base A',power=3.4567890123456789},
    }
    local catalogue={list={},loading=true}
    local data={uniques={one={rawA}}}
    local db={db=catalogue}
    local build={itemsTab={controls={uniqueDB=db},activeItemSet={}},calcsTab={}}
    function db:SetSortMode(mode) self.sortDetail={stat=mode} end
    function db:EvaluateItemPower(item, calc, full)
        seen={item=item,full=full,weapon=build.itemsTab.activeItemSet.useSecondWeaponSet}
        return calc(item)
    end
    function build.calcsTab:GetMiscCalculator()
        local revision=imports
        return function(item) return item.power+revision end
    end
    local env=setmetatable({
        package={path=''},table=table,bit32={},data=data,build=build,
        __mainObject__={main={uniqueDB=catalogue}},
        createHelperUniqueCatalogue=create,
        sanitiseText=function(value) return value end,
        escapeGGGString=function(value) return value end,
        Inflate=function() end,Deflate=function() end,
        GetTime=function() return tick end,dofile=function() end,
        require=function(name)
            assert(name=='dkjson')
            return {decode=function(job) return job end,encode=function(result) return result end}
        end,
        runCallback=function(name)
            assert(name=='OnFrame');frames=frames+1
            if timeout then tick=tick+16000 else catalogue.loading=false end
        end,
        loadBuildFromXML=function()
            imports=imports+1
            if imports==2 then data.uniques={one={rawA,rawNew}} end
        end,
        runtimeGCPolicy={applyWorkload=function() end,collectUniqueBatch=function() collections=collections+1 end},
        collectgarbage=function() end,
        new=function(name)
            assert(name=='Item')
            return {Item=function(_,raw,rarity,quality)
                assert(rarity=='UNIQUE' and quality==true);calls=calls+1
                local definition=definitions[raw]
                return {raw=raw,base=definition and {} or nil,name=definition and definition.name,power=definition and definition.power}
            end}
        end,
    },{__index=_G})
    assert(load(source,'helper-boot','t',env))()
    local function import(identity) assert(env.helperCall({xml='build',identity=identity}).ready) end
    local function score(raw,options)
        options=options or {}
        return env.helperCall({identity=options.identity or 'one',operation=options.operation or 1,
            sortMode=options.metric or 'HitDPS',weaponSet=options.weapon,
            items={{key=options.key or 'Alpha, Base A',raw=raw}}})[1]
    end
    local function rejects(fn,message)
        local ok,err=pcall(fn);assert(not ok and tostring(err):find(message,1,true),tostring(err))
    end
    import('one');assert(frames==0 and calls==0 and catalogue.loading)
    assert(score(rawA)==string.format('%.17g',definitions[rawA].power+1))
    assert(frames==0 and calls==2 and seen.item~=catalogue.list['Alpha, Base A'])
    local first=seen.item;score(rawA);assert(calls==2 and seen.item==first)
    score('edited');assert(calls==3 and seen.item.raw=='edited')
    score(rawA);assert(calls==4 and seen.item.raw==rawA) -- undo
    score('edited');assert(calls==5 and seen.item.raw=='edited') -- redo
    rejects(function() score('invalid') end,'Helper candidate could not be parsed')
    rejects(function() score(rawA,{key='Missing, Base'}) end,'Helper candidate not found')
    assert(frames==1)
    rejects(function() score(rawA,{identity='stale'}) end,'Stale helper build')
    import('two')
    local second=score(rawNew,{key='New Title, Base N',identity='two',operation=2,metric='FullDPS',weapon=true})
    assert(second==string.format('%.17g',definitions[rawNew].power+2))
    assert(frames==1 and seen.full==true and seen.weapon==true)
    score(rawA,{identity='two',operation=3,metric='Life',weapon=false})
    assert(seen.full==false and seen.weapon==false and collections==7)
    catalogue.loading=true;timeout=true
    rejects(function() score(rawA,{identity='two',key='Missing, Base'}) end,'Helper unique database timeout')
    print('Helper catalogue lazy import, raw edits, undo/redo, reimport, stale jobs, metrics, weapons and timeout tests passed')
end
