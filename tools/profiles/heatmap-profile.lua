-- Appended to TreeTab only in routed, in-memory profiling packages.
do
    local encode = require('dkjson').encode
    local active, installed, current, treeViewport
    local runs = {}
    local wrapped = setmetatable({}, {__mode = 'k'})
    local draw = TreeTabClass.Draw
    local categories = {'singleAdd', 'masteryEffect', 'pathAdd', 'allocatedRemove', 'removePath', 'clusterNotable', 'unreachable'}

    local function snapshot(tab, full)
        local rows = {}
        local function number(value)
            return value == nil and 'nil' or string.format('%.17g', value)
        end
        local function power(key, value)
            value = value or {}
            rows[#rows + 1] = key .. ':' .. number(value.singleStat) .. ':' .. number(value.offence) .. ':' .. number(value.defence) .. (full and ':' .. number(value.pathPower) or '')
        end
        for id, node in pairs(tab.build.spec.nodes) do
            if full or not node.alloc then
                power('node:' .. id, node.power)
                for effect, value in pairs(node.power and node.power.masteryEffects or {}) do
                    power('mastery:' .. id .. ':' .. effect, value)
                end
            end
        end
        for key, value in pairs(tab.powerMax or {}) do rows[#rows + 1] = 'max:' .. key .. ':' .. number(value) end
        if full then
            for name, node in pairs(tab.build.spec.tree.clusterNodeMap) do power('cluster:' .. name, node.power) end
        end
        table.sort(rows)
        return table.concat(rows, '\n')
    end

    local function heatmapReady(run)
        if not run or run.heatmapReadyAt then return end
        run.heatmapReadyAt = GetTime()
        run.heatmapCalculators = {}
        for name, value in pairs(run.calculators) do
            run.heatmapCalculators[name] = {count = value.count, ms = value.ms}
        end
    end

    local function installBuilder(tab)
        if wrapped[tab] then return end
        wrapped[tab] = true
        local buildPower, getCalculator = tab.BuildPower, tab.GetMiscCalculator
        tab.GetMiscCalculator = function(self, ...)
            local calc, base = getCalculator(self, ...)
            -- Only count calls made by this builder, not sidebar or tooltip calculations.
            if not current or not self.powerBuilder or coroutine.running() ~= self.powerBuilder then return calc, base end
            local run = current
            local clusters = {}
            for _, node in pairs(self.build.spec.tree.clusterNodeMap) do clusters[node] = true end
            return function(args, ...)
                local nodes, count, node = args.addNodes or args.removeNodes or {}, 0
                for n in pairs(nodes) do count, node = count + 1, n end
                local category
                if args.removeNodes then category = count > 1 and 'removePath' or 'allocatedRemove'
                elseif count > 1 then category = 'pathAdd'
                elseif clusters[node] then category = 'clusterNotable'
                elseif node and node.type == 'Mastery' and self.build.spec.nodes[node.id] ~= node then category = 'masteryEffect'
                elseif node and (node.pathDist or 1000) >= 1000 then category = 'unreachable'
                else category = 'singleAdd' end
                local start = GetTime()
                local result = table.pack(calc(args, ...))
                local counter = run.calculators[category]
                counter.count, counter.ms = counter.count + 1, counter.ms + GetTime() - start
                return table.unpack(result, 1, result.n)
            end, base
        end

        tab.BuildPower = function(self, ...)
            if self.powerBuildFlag then
                if current and not current.reportReadyAt then current.abandonedAt = GetTime() end
                current = {id = #runs + 1, token = self.powerBuildToken and self.powerBuildToken + 1 or nil, metric = (self.powerStat or data.powerStatList[1]).label, depth = self.nodePowerMaxDepth or 'All', startedAt = GetTime(), resumes = 0, maxResumeMs = 0, calculators = {}, progress = {}, reportCallbacks = 0, heatmapCallbacks = 0}
                for _, category in ipairs(categories) do current.calculators[category] = {count = 0, ms = 0} end
                runs[#runs + 1] = current
            end
            local run = current
            local pending = self.powerBuildFlag or self.powerBuilder ~= nil or self.powerReportPending ~= nil
            local callback = self.build.powerBuilderCallback
            local heatmapCallback = self.build.powerBuilderHeatmapCallback
            local progressCallback = self.build.powerBuilderProgressCallback
            if callback and pending then
                self.build.powerBuilderCallback = function(...)
                    local result = table.pack(callback(...))
                    if run then
                        run.reportReadyAt = GetTime()
                        run.reportCallbacks = run.reportCallbacks + 1
                        run.publishedToken = self.powerBuildToken
                    end
                    return table.unpack(result, 1, result.n)
                end
            end
            if pending then
                self.build.powerBuilderHeatmapCallback = function(...)
                    if heatmapCallback then heatmapCallback(...) end
                    if run then run.heatmapCallbacks = run.heatmapCallbacks + 1 end
                    heatmapReady(run)
                end
                self.build.powerBuilderProgressCallback = function(percent)
                    if run then
                        local phase = self.powerPhase or 'combined'
                        local p = run.progress[phase] or {count = 0, last = 0, valid = true}
                        p.valid = p.valid and type(percent) == 'number' and percent == percent and percent >= p.last and percent <= 100
                        p.last, p.count = percent, p.count + 1
                        run.progress[phase] = p
                    end
                    if progressCallback then progressCallback(percent) end
                end
            end
            -- Propagate coroutine failures even when PoB's development mode is off.
            local resume = coroutine.resume
            coroutine.resume = function(thread, ...)
                local start = GetTime()
                local result = table.pack(resume(thread, ...))
                if thread == self.powerBuilder then
                    if not result[1] then error('Heatmap profiling: builder coroutine failed') end
                    if run then
                        run.resumes = run.resumes + 1
                        run.maxResumeMs = math.max(run.maxResumeMs, GetTime() - start)
                    end
                end
                return table.unpack(result, 1, result.n)
            end
            local result = table.pack(pcall(buildPower, self, ...))
            coroutine.resume = resume
            self.build.powerBuilderCallback = callback
            self.build.powerBuilderHeatmapCallback = heatmapCallback
            self.build.powerBuilderProgressCallback = progressCallback
            if not result[1] then error('Heatmap profiling: BuildPower failed') end
            if run then
                run.token = self.powerBuildToken
                run.phase = self.powerPhase or (self.powerBuilder and 'combined' or 'complete')
                run.pending = self.powerReportPending ~= nil
                run.clusterRecomputes = self.powerReportCollisions or 0
            end
            if run and pending and not run.heatmapReadyAt and (self.powerHeatmapReady == true or self.powerBuilder == nil) then
                heatmapReady(run)
            end
            return table.unpack(result, 2, result.n)
        end

    end

    local function controlState(control)
        local x, y = control:GetPos()
        local w, h = control:GetSize()
        local state = {bounds = {x, y, w, h}, selected = control.selIndex}
        if control.list then
            state.options = {}
            for i, value in ipairs(control.list) do state.options[i] = type(value) == 'table' and value.label or tostring(value) end
            state.dropUp, state.dropHeight = control.dropUp, control.dropHeight
            state.scrollOffset = control.controls.scrollBar.offset
        end
        return state
    end

    TreeTabClass.Draw = function(self, ...)
        active = self
        installBuilder(self.build.calcsTab)
        if not wrapped[self.viewer] then
            wrapped[self.viewer] = true
            local viewerDraw = self.viewer.Draw
            self.viewer.Draw = function(viewer, build, viewport, events)
                treeViewport = viewport
                return viewerDraw(viewer, build, viewport, events)
            end
        end
        if not installed and getRuntimeProfile then
            installed = true
            local profile = getRuntimeProfile
            getRuntimeProfile = function(reset)
                local result = profile(reset)
                local state = {runs = runs, controls = {}}
                if active then
                    for key, name in pairs({heatmap = 'treeHeatMap', depth = 'nodePowerMaxDepthSelect', metric = 'treeHeatMapStatSelect', report = 'powerReport'}) do
                        state.controls[key] = controlState(active.controls[name])
                    end
                    state.enabled = active.viewer.showHeatMap or false
                    state.reportShown = active.controls.powerReportList.shown or false
                    state.reportRows = #(active.controls.powerReportList.originalList or {})
                    state.toastShown = active.powerBuilderToastId ~= nil and ToastNotification:Exists(active.powerBuilderToastId) or false
                    state.allocatedNodes = active.build.spec:CountAllocNodes()
                    if reset and treeViewport then
                        local v, viewer = treeViewport, active.viewer
                        local scale = math.min(v.width, v.height) / active.build.spec.tree.size * viewer.zoom
                        for id, node in pairs(active.build.spec.nodes) do
                            if node.type == 'Normal' and not node.alloc and not node.ascendancyName and node.path and node.pathDist == 1 then
                                local x = node.x * scale + viewer.zoomX + v.x + v.width / 2
                                local y = node.y * scale + viewer.zoomY + v.y + v.height / 2
                                if x > v.x + 20 and x < v.x + v.width - 20 and y > v.y + 220 and y < v.y + v.height - 40 and (not state.allocationTarget or id < state.allocationTarget.id) then
                                    state.allocationTarget = {id = id, x = x, y = y}
                                end
                            end
                        end
                    end
                    -- A reset read requests snapshots after timing has been observed.
                    -- Ordinary polling never serializes node values.
                    if reset and current and current.heatmapReadyAt then
                        state.snapshots = {heatmap = snapshot(active.build.calcsTab, false)}
                        if current.reportReadyAt then state.snapshots.full = snapshot(active.build.calcsTab, true) end
                    end
                end
                return result:sub(1, -2) .. ',"nodePower":' .. encode(state) .. '}'
            end
        end
        return draw(self, ...)
    end
end
