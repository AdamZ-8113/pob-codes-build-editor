-- Default-off scheduling adapter. PoB owns evaluation, cache keys and merging.
local epoch = 0
return function(build)
    epoch = epoch + 1
    local currentEpoch = epoch
    local tab = build.calcsTab
    if not tab or type(tab.EvaluateNodePowerItem) ~= 'function' then return end
    local json = require('dkjson')
    local buildPower = tab.BuildPower
    tab.BuildPower = function(self, ...)
        if self.powerBuildFlag and self.nodePowerDelegation and not self.nodePowerDelegation.completed then
            CancelUniqueSort()
        end
        return buildPower(self, ...)
    end
    tab.nodePowerBatchAvailable = function(self)
        if NodePowerAvailable() < 1 or not self.powerStat or self.powerStat.label ~= 'Hit DPS'
            or self.nodePowerMaxDepth ~= 5 then return false end
        for _, item in pairs(build.itemsTab.items) do
            if item.jewelData and item.jewelData.conqueredBy then return false end
        end
        return true
    end
    tab.evaluateNodePowerBatch = function(self, items, calc, base)
        if #items < 200 or not self:nodePowerBatchAvailable() then return end
        CancelUniqueSort()
        local helpers, revision, metric, depth = NodePowerAvailable(), build.outputRevision, self.powerStat.label, self.nodePowerMaxDepth
        local clusters, remote, localItems, remoteIndices = {}, {}, {}, {}
        for name, node in pairs(build.spec.tree.clusterNodeMap) do clusters[node] = name end
        local function describe(node)
            if clusters[node] then return {cluster=clusters[node]} end
            if build.spec.nodes[node.id] == node then return {id=node.id} end
            if node.nodePowerEffectId then return {id=node.id, effect=node.nodePowerEffectId} end
        end
        for index, item in ipairs(items) do
            local encoded, valid = {}, true
            for _, key in ipairs({'addNodes', 'removeNodes'}) do
                if item[key] then
                    encoded[key] = {}
                    for node in pairs(item[key]) do
                        local ref = describe(node)
                        if not ref then valid = false; break end
                        encoded[key][#encoded[key]+1] = ref
                    end
                end
            end
            if not valid or index % (helpers + 1) == 0 then
                localItems[#localItems+1] = index
            else
                remote[#remote+1], remoteIndices[#remoteIndices+1] = encoded, index
            end
        end
        if #remote == 0 then return end
        local xml = build:SaveDB('code')
        if not xml then return end
        local id = BeginUniqueSort(json.encode({kind='nodePower', identity=currentEpoch..':'..revision,
            xml=xml, metric=metric, items=remote}))
        local values, localIndex, remoteDone, started = {}, 1, false, GetTime()
        self.nodePowerDelegation = {remote=#remote, localCount=#localItems, helpers=helpers, completed=false}
        while true do
            if epoch ~= currentEpoch or self.powerBuildFlag or build.outputRevision ~= revision
                or self.powerStat.label ~= metric or self.nodePowerMaxDepth ~= depth then
                CancelUniqueSort(); return
            end
            if GetTime() - started > 60000 then CancelUniqueSort(); return end
            local reply = not remoteDone and PollUniqueSort(id)
            if reply then
                local results = json.decode(reply)
                if type(results) ~= 'table' or #results ~= #remote then return end
                for i, result in ipairs(results) do
                    if type(result) ~= 'table' or type(result.singleStat) ~= 'string' then return end
                    local value = tonumber(result.singleStat)
                    if not value or value ~= value or math.abs(value) == math.huge then return end
                    values[remoteIndices[i]] = {singleStat=value}
                end
                remoteDone = true
            end
            local deadline = GetTime() + 35
            while localIndex <= #localItems do
                local index = localItems[localIndex]
                values[index] = self:EvaluateNodePowerItem(items[index], calc, base)
                localIndex = localIndex + 1
                if GetTime() >= deadline then break end
            end
            if remoteDone and localIndex > #localItems then
                self.nodePowerDelegation.completed = true
                return values
            end
            coroutine.yield()
        end
    end
end
