-- Scheduling adapter only. PoB owns filtering, evaluation and final sorting.
local epoch = 0
return function(build)
    epoch = epoch + 1
    CancelUniqueSort()
    local buildEpoch = epoch
    local db = build.itemsTab and build.itemsTab.controls.uniqueDB
    if not db or type(db.EvaluateItemPower) ~= 'function' then return end
    local json = require('dkjson')
    local generation = 0
    local listBuilder = db.ListBuilder
    db.ListBuilder = function(self, ...)
        generation = generation + 1
        CancelUniqueSort()
        return listBuilder(self, ...)
    end
    db.evaluateItemBatch = function(self, list)
        local helpers = UniqueSortAvailable()
        if #list < 25 or helpers < 1 then return end
        local current = generation
        local revision, mode = build.outputRevision, self.sortMode
        local weaponSet = self.itemsTab.activeItemSet.useSecondWeaponSet or false
        local items, keys, remoteItems, localItems = {}, {}, {}, {}
        for key, item in pairs(self.db.list) do keys[item] = key end
        for index, item in ipairs(list) do
            if not keys[item] then return end
            if index % (helpers + 1) == 0 then
                localItems[#localItems + 1] = item
            else
                remoteItems[#remoteItems + 1] = item
                items[#items + 1] = {key=keys[item], raw=item:BuildRaw()}
            end
        end
        local xml = build:SaveDB('code')
        if not xml then return end
        local id = BeginUniqueSort(json.encode({identity=tostring(buildEpoch)..':'..tostring(revision), xml=xml,
            sortMode=mode, weaponSet=weaponSet, items=items}))
        local result, localIndex, remoteDone = {}, 1, false
        local calc = self.itemsTab.build.calcsTab:GetMiscCalculator(self.build)
        while true do
            if epoch ~= buildEpoch or current ~= generation or build.outputRevision ~= revision or
                self.sortMode ~= mode or (self.itemsTab.activeItemSet.useSecondWeaponSet or false) ~= weaponSet then
                CancelUniqueSort()
                return
            end
            local reply = not remoteDone and PollUniqueSort(id)
            if reply then
                local values = json.decode(reply)
                if type(values) ~= 'table' or #values ~= #remoteItems then return end
                for index, item in ipairs(remoteItems) do
                    local value = values[index]
                    value = value == '-inf' and -math.huge or tonumber(value)
                    if type(value) ~= 'number' then return end
                    result[item] = value
                end
                remoteDone = true
            end
            -- Use the already-loaded UI instance for one equal share. Only
            -- scheduling lives here; PoB's shared evaluator owns every score.
            local deadline = GetTime() + 35
            while localIndex <= #localItems do
                local item = localItems[localIndex]
                result[item] = self:EvaluateItemPower(item, calc, self.sortDetail.stat == 'FullDPS')
                localIndex = localIndex + 1
                if GetTime() >= deadline then break end
            end
            if remoteDone and localIndex > #localItems then return result end
            local completed = localIndex - 1 + (remoteDone and #remoteItems or 0)
            self.defaultText = string.format('^7Sorting... (%d%%)', math.floor(completed / #list * 100))
            coroutine.yield()
        end
    end
end
