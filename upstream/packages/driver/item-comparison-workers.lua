-- Background scheduling only. The helper invokes PoB's original comparison
-- method and returns its primitive tooltip operations without rounding values.
local epoch, active = 0
local profile = { requested = 0, completed = 0, hits = 0, failed = 0 }
function getItemComparisonProfile()
    return require('dkjson').encode(profile)
end
function updateItemComparisons()
    if active then active() end
end

return function(build)
    epoch = epoch + 1
    CancelItemComparison()
    active = nil
    if not ItemComparisonsEnabled() then return end
    local items = build.itemsTab
    if not items or type(items.AddItemStatDifferences) ~= 'function' then return end
    local original = items.AddItemStatDifferences
    local json = require('dkjson')
    local buildEpoch, revision, xml, pending = epoch
    local entries = {}
    profile = { requested = 0, completed = 0, hits = 0, failed = 0 }
    local function finish()
        if not pending then return end
        local reply = PollItemComparison(pending.id)
        if not reply then return end
        local job = pending
        pending = nil
        if build.outputRevision ~= job.revision or build.buildFlag then
            job.tooltip:Clear(true)
            return
        end
        local result = json.decode(reply)
        if type(result) == 'table' then
            profile.completed = profile.completed + 1
            entries[#entries + 1] = { key = job.key, operations = result }
        else
            profile.failed = profile.failed + 1
            -- An unavailable comparison is explicit; never run a potentially
            -- blocking fallback on the UI thread after a helper failure.
            entries[#entries + 1] = { key = job.key, failed = true, operations = {
                { name = 'AddSeparator', args = {10} },
                { name = 'AddLine', args = {14, '^8Comparison unavailable. Hover again to retry.'} },
            } }
        end
        if #entries > 64 then table.remove(entries, 1) end
        job.tooltip:Clear(true)
        RequestFrames(1)
    end
    active = finish
    items.AddItemStatDifferences = function(self, tooltip, item, base, slot, ...)
        -- List tooltips are rebuilt by CheckForUpdate after invalidation.
        -- Explicit editing panels use a different refresh contract; preserve
        -- their original behavior rather than clearing a persistent panel.
        local listTooltip = false
        for _, control in pairs(items.controls or {}) do
            if control.tooltip == tooltip and type(control.AddValueTooltip) == 'function' then
                listTooltip = true
                break
            end
        end
        if not listTooltip then return original(self, tooltip, item, base, slot, ...) end
        finish()
        if build.buildFlag then
            tooltip:AddLine(14, '^8Comparison pending...')
            return 'pending'
        end
        if revision ~= build.outputRevision then
            CancelItemComparison()
            pending, xml, entries = nil, nil, {}
            revision = build.outputRevision
        end
        local ownedId
        for id, owned in pairs(self.items) do if owned == item then ownedId = id; break end end
        local options = {}
        for _, name in ipairs({'slotOnlyTooltips', 'showThousandsSeparators', 'thousandsSeparator', 'decimalSeparator'}) do
            options[name] = main[name]
        end
        local candidate = { raw = item:BuildRaw(), id = ownedId }
        local slotName = type(slot) == 'table' and slot.slotName or slot
        local key = json.encode({candidate, slotName or false, options}, {keyorder = {
            'raw', 'id', 'slotOnlyTooltips', 'showThousandsSeparators', 'thousandsSeparator', 'decimalSeparator'}})
        for index, entry in ipairs(entries) do
            if entry.key == key then
                table.remove(entries, index)
                if not entry.failed then entries[#entries + 1] = entry end
                profile.hits = profile.hits + 1
                for _, op in ipairs(entry.operations) do tooltip[op.name](tooltip, table.unpack(op.args)) end
                return
            end
        end
        if not pending or pending.key ~= key then
            if pending then pending.tooltip:Clear(true) end
            xml = xml or build:SaveDB('code')
            local id = BeginItemComparison(json.encode({identity = tostring(buildEpoch)..':'..tostring(revision),
                xml = xml, item = candidate, slot = slotName, options = options}))
            pending = { id = id, key = key, tooltip = tooltip, revision = revision }
            profile.requested = profile.requested + 1
        else
            pending.tooltip = tooltip
        end
        tooltip:AddSeparator(10)
        tooltip:AddLine(14, '^8Calculating comparison...')
        return 'pending'
    end
end
