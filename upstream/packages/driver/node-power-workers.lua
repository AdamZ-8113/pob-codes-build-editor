-- Browser scheduling adapter. PoB owns evaluation, cache keys and merging.
local epoch = 0
local progressTree
local shutdownWrapped = setmetatable({}, {__mode='k'})
local function clearProgress(tree)
    if tree and tree.powerBuilderToastId and ToastNotification then
        ToastNotification:ClearDismissed(tree.powerBuilderToastId)
        ToastNotification:Remove(tree.powerBuilderToastId, true)
        tree.powerBuilderToastId = nil
    end
end
return function(build)
    -- Imports reuse the build object but replace its tree and callbacks.
    clearProgress(progressTree)
    progressTree = build.treeTab
    if type(build.Shutdown) == 'function' and not shutdownWrapped[build] then
        shutdownWrapped[build] = true
        local shutdown = build.Shutdown
        build.Shutdown = function(self, ...)
            clearProgress(self.treeTab)
            return shutdown(self, ...)
        end
    end
    epoch = epoch + 1
    local currentEpoch = epoch
    local tab = build.calcsTab
    if not tab or type(tab.EvaluateNodePowerItem) ~= 'function' then return end
    local progress = build.powerBuilderProgressCallback
    local reportPercent = 0
    if progress then
        build.powerBuilderProgressCallback = function(percent)
            -- The final merge replays PoB's node walk. Keep its percentages
            -- from moving backwards after delegated evaluations complete.
            reportPercent = math.max(reportPercent, math.min(99, percent or 0))
            progress(reportPercent)
        end
    end
    local json = require('dkjson')
    local evaluate = tab.EvaluateNodePowerItem
    tab.EvaluateNodePowerItem = function(self, ...)
        local result = evaluate(self, ...)
        if self.nodePowerStatus then
            self.nodePowerStatus.localCompleted = (self.nodePowerStatus.localCompleted or 0) + 1
        end
        return result
    end
    local buildPower = tab.BuildPower
    tab.BuildPower = function(self, ...)
        local tree = build.treeTab
        -- Announce 0% before planning, then retain measured progress on reopen.
        -- Reopening a hidden heatmap resumes its indicator; manual dismissal
        -- remains respected until a new report starts.
        local resumeProgress = self.powerBuilder and tree and ToastNotification
            and not ToastNotification:Exists(tree.powerBuilderToastId)
            and not ToastNotification:WasDismissed(tree.powerBuilderToastId)
        if build.powerBuilderProgressCallback and (self.powerBuildFlag or resumeProgress) then
            if self.powerBuildFlag then
                reportPercent = 0
                clearProgress(tree)
            end
            if tree then tree.lastProgressToastUpdate = -math.huge end
            build.powerBuilderProgressCallback()
        end
        if self.powerBuildFlag and self.nodePowerDelegation and not self.nodePowerDelegation.completed then
            CancelUniqueSort()
        end
        if self.powerBuildFlag then
            local eligible, reason = self:nodePowerBatchAvailable()
            self.nodePowerStatus = {mode='serial', reason=reason or 'small-workload',
                metric=(self.powerStat or data.powerStatList[1]).label,
                depth=self.nodePowerMaxDepth or 'All', eligible=eligible,
                localCompleted=0, remoteCompleted=0, completed=false}
        end
        local result = table.pack(buildPower(self, ...))
        if self.nodePowerStatus and not self.powerBuildFlag and not self.powerBuilder then
            self.nodePowerStatus.completed = true
        end
        return table.unpack(result, 1, result.n)
    end
    tab.nodePowerBatchAvailable = function(self)
        local depth = self.nodePowerMaxDepth
        if NodePowerAvailable() < 1 then return false, 'helpers-unavailable' end
        if depth ~= nil and (type(depth) ~= 'number' or depth < 0 or depth == math.huge or depth ~= math.floor(depth)) then
            return false, 'invalid-depth'
        end
        local selected = self.powerStat or data.powerStatList[1]
        for _, stat in ipairs(data.powerStatList) do
            if stat == selected then
                if stat.ignoreForNodes then return false, 'metric-ignores-nodes' end
                return true
            end
        end
        return false, 'unknown-metric'
    end
    tab.evaluateNodePowerBatch = function(self, items, calc, base)
        if #items < 200 or not self:nodePowerBatchAvailable() then return end
        CancelUniqueSort()
        local helpers, revision, metric, depth = NodePowerAvailable(), build.outputRevision,
            (self.powerStat or data.powerStatList[1]).label, self.nodePowerMaxDepth
        local clusters, remote, localItems, remoteIndices, descriptions = {}, {}, {}, {}, {}
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
            if valid then descriptions[index] = encoded end
            if not valid or index % (helpers + 1) == 0 then
                localItems[#localItems+1] = index
            else
                remote[#remote+1], remoteIndices[#remoteIndices+1] = encoded, index
            end
        end
        if #remote == 0 then
            if self.nodePowerStatus then self.nodePowerStatus.reason = 'unresolvable-nodes' end
            return
        end
        local xml = build:SaveDB('code')
        if not xml then
            if self.nodePowerStatus then self.nodePowerStatus.reason = 'snapshot-unavailable' end
            return
        end
        local id = BeginUniqueSort(json.encode({kind='nodePower', identity=currentEpoch..':'..revision,
            xml=xml, metric=metric, items=remote}))
        local values, localIndex, remoteDone, handedOff = {}, 1, false, false
        local remoteProgress = 0
        self.nodePowerDelegation = {remote=#remote, localCount=#localItems, helpers=helpers, completed=false}
        local status = self.nodePowerStatus or {}
        self.nodePowerStatus = status
        status.mode, status.reason = 'parallel', nil
        status.remote, status.localCount, status.helpers = #remote, #localItems, helpers
        status.localCompleted, status.remoteCompleted = 0, 0
        local function fallback(reason)
            status.mode, status.reason = 'serial', reason
            CancelUniqueSort()
        end
        while true do
            if epoch ~= currentEpoch or self.powerBuildFlag or build.outputRevision ~= revision
                or (self.powerStat or data.powerStatList[1]).label ~= metric or self.nodePowerMaxDepth ~= depth then
                fallback('superseded'); return
            end
            -- The pool bounds every import/chunk request. A total report deadline
            -- would discard healthy progress on expensive metrics and repeat it serially.
            local reply = not remoteDone and PollUniqueSort(id)
            if reply then
                local results = json.decode(reply)
                if type(results) == 'table' and results.completed ~= nil then
                    local count = results.completed
                    if type(count) ~= 'number' or count ~= math.floor(count) or count < remoteProgress or count > #remote then
                        fallback('invalid-progress'); return
                    end
                    remoteProgress = count
                else
                    if type(results) ~= 'table' or #results ~= #remote then fallback('helper-failed'); return end
                    for i, result in ipairs(results) do
                        local keys = (not self.powerStat or not self.powerStat.stat)
                            and {'singleStat', 'offence', 'defence'} or {'singleStat'}
                        local decoded = {}
                        for _, key in ipairs(keys) do
                            local value = type(result) == 'table' and type(result[key]) == 'string' and tonumber(result[key])
                            if not value or value ~= value or math.abs(value) == math.huge then fallback('invalid-result'); return end
                            decoded[key] = value
                        end
                        values[remoteIndices[i]] = decoded
                    end
                    remoteDone = true
                    status.remoteCompleted = status.remoteCompleted + #remote
                    remoteProgress = 0
                end
            end
            -- A frame-bound UI share can lag behind the helpers. Hand its
            -- serializable tail to the now-idle pool once, without duplicating
            -- completed work or changing result indices/calculation semantics.
            if remoteDone and not handedOff and #localItems - localIndex + 1 >= 25 then
                local tail, indices, retained = {}, {}, {}
                for i = localIndex, #localItems do
                    local index = localItems[i]
                    if descriptions[index] then
                        tail[#tail+1], indices[#indices+1] = descriptions[index], index
                    else retained[#retained+1] = index end
                end
                handedOff = true
                if #tail >= 25 then
                    remote, remoteIndices, localItems, localIndex = tail, indices, retained, 1
                    status.remote, status.localCount, status.handedOff = status.remote + #tail, status.localCount - #tail, #tail
                    self.nodePowerDelegation.remote, self.nodePowerDelegation.localCount = status.remote, status.localCount
                    self.nodePowerDelegation.handedOff = #tail
                    remoteDone = false
                    id = BeginUniqueSort(json.encode({kind='nodePower', identity=currentEpoch..':'..revision,
                        xml=xml, metric=metric, items=remote}))
                end
            end
            local deadline = GetTime() + 20
            while localIndex <= #localItems do
                local index = localItems[localIndex]
                values[index] = self:EvaluateNodePowerItem(items[index], calc, base)
                localIndex = localIndex + 1
                if GetTime() >= deadline then break end
            end
            if build.powerBuilderProgressCallback then
                -- Pool progress counts validated chunks in the current request.
                -- Final replies move that count into remoteCompleted exactly once;
                -- a tail handoff starts a new request against the same report total.
                build.powerBuilderProgressCallback(math.floor(
                    (status.localCompleted + status.remoteCompleted + remoteProgress) / #items * 100))
            end
            if remoteDone and localIndex > #localItems then
                self.nodePowerDelegation.completed = true
                return values
            end
            coroutine.yield()
        end
    end
end
