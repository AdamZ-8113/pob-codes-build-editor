return function(install)
    local enabled, sent, reply, requestId, saves, frames = true, nil, nil, 0, 0, 0
    local function encode(value)
        if type(value) ~= 'table' then return tostring(value) end
        local fields = {}
        for key, child in pairs(value) do fields[#fields + 1] = tostring(key)..'='..encode(child) end
        table.sort(fields)
        return '{'..table.concat(fields, ',')..'}'
    end
    package.loaded.dkjson = {encode = function(value)
        if value.identity then sent = value end
        return encode(value)
    end, decode = function() return reply end}
    ItemComparisonsEnabled = function() return enabled end
    CancelItemComparison = function() reply = nil end
    BeginItemComparison = function() requestId = requestId + 1; reply = nil; return requestId end
    PollItemComparison = function(id) assert(id == requestId); return reply ~= nil and 'reply' or nil end
    RequestFrames = function(n) frames = frames + n end
    main = {slotOnlyTooltips = false, showThousandsSeparators = true, thousandsSeparator = ',', decimalSeparator = '.'}
    local originalCalls = 0
    local original = function() originalCalls = originalCalls + 1; return 7, nil, true end
    local owned = {raw = 'owned flask'}
    function owned:BuildRaw() return self.raw end
    local candidate = {raw = 'future item using existing data', BuildRaw = owned.BuildRaw}
    local items = {AddItemStatDifferences = original, items = {[7] = owned}}
    local build = {itemsTab = items, outputRevision = 1,
        SaveDB = function() saves = saves + 1; return 'public XML '..saves end}
    local tooltip = {lines = {}}
    function tooltip:Clear() self.lines = {} end
    function tooltip:AddLine(_, text) self.lines[#self.lines + 1] = text end
    function tooltip:AddSeparator() end
    items.controls = {list = {tooltip = tooltip, AddValueTooltip = function() end}}
    install(build)
    local function compare(item, slot)
        tooltip:Clear()
        return items:AddItemStatDifferences(tooltip, item, {}, slot)
    end
    assert(compare(owned, {slotName = 'Flask 1'}) == 'pending')
    assert(sent.item.id == 7 and sent.slot == 'Flask 1' and sent.item.raw == owned.raw)
    assert(saves == 1 and requestId == 1)
    compare(owned, 'Flask 1'); assert(requestId == 1, 'Coalesce unchanged pending comparisons')
    reply = {{name = 'AddLine', args = {14, 'Exact original comparison'}}}
    updateItemComparisons()
    assert(frames == 1)
    compare(owned, 'Flask 1'); assert(tooltip.lines[1] == 'Exact original comparison' and requestId == 1)
    compare(candidate)
    assert(requestId == 2 and saves == 1 and sent.item.id == nil, 'New item names need no adapter change')
    local previousIdentity = sent.identity
    build.outputRevision = 2
    reply = {{name = 'AddLine', args = {14, 'Stale'}}}
    updateItemComparisons()
    compare(candidate)
    assert(requestId == 3 and saves == 2 and sent.identity ~= previousIdentity, 'Revision invalidates snapshot and results')
    reply = {}; updateItemComparisons()
    compare(candidate); assert(#tooltip.lines == 0 and requestId == 3, 'Empty comparisons are valid cache entries')
    main.slotOnlyTooltips = true
    compare(candidate); assert(requestId == 4 and sent.options.slotOnlyTooltips)
    reply = false; updateItemComparisons()
    compare(candidate); assert(tooltip.lines[1]:find('unavailable'), 'Failure never invokes the UI calculator')
    build.buildFlag = true
    compare(owned); assert(requestId == 4, 'Do not snapshot an unfinished recalculation')
    build.buildFlag = false
    candidate.raw = 'changed variant'
    compare(candidate); assert(requestId == 5 and sent.item.raw == 'changed variant')
    assert(originalCalls == 0, 'List comparisons never run on the UI thread')
    local a,b,c = items:AddItemStatDifferences({}, candidate, {})
    assert(a == 7 and b == nil and c == true and originalCalls == 1, 'Explicit editing panels retain their refresh contract')
    enabled = false
    items.AddItemStatDifferences = original
    install(build)
    assert(items.AddItemStatDifferences == original, 'Explicit diagnostic baseline preserves original behavior')
end
