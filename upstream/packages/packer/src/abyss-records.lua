-- 8 MiB LRU of native records and parsed search blocks per Lua worker. Never
-- swaps PoB's global family LUT for a single equipped seed.
local recordCache, cacheBytes, tick = {}, 0, 0
local searchBlock
local pathKeys = setmetatable({}, {__mode="k"})
local recordLimit = 8 * 1024 * 1024
local loadedFamilies = {}
local function loadAbyssJewel(jewelType, seed, socketId, bulk, path, ascendancyName)
    if bulk and searchBlock and searchBlock.type == jewelType and searchBlock.socket == socketId
        and searchBlock.path == path and searchBlock.ascendancy == ascendancyName
        and seed >= searchBlock.lut.seedMinimum and seed <= searchBlock.lut.seedMaximum then return searchBlock.lut end
    if path and (not pathKeys[path] or pathKeys[path].ascendancy ~= ascendancyName) then
        local ids = {}; for id in pairs(path) do ids[#ids+1] = id end
        table.sort(ids); pathKeys[path] = {ascendancy=ascendancyName, key=table.concat(ids, ',') .. ':' .. tostring(ascendancyName)}
    end
    local context = path and pathKeys[path].key or ''
    if bulk and searchBlock and searchBlock.type == jewelType and searchBlock.socket == socketId and searchBlock.context == context
        and seed >= searchBlock.lut.seedMinimum and seed <= searchBlock.lut.seedMaximum then return searchBlock.lut end
    local blockSize = jewelType == 11 and 32 or 512
    local key = (bulk and 'block:' or 'record:') .. jewelType .. ':' .. (bulk and math.floor((seed-100)/blockSize) or seed) .. ':' .. socketId .. (bulk and context or '')
    tick = tick + 1
    if recordCache[key] then
        local entry = recordCache[key]; entry.tick = tick
        if bulk then searchBlock = {type=jewelType, socket=socketId, context=context, path=path, ascendancy=ascendancyName, lut=entry.lut} end
        return entry.lut
    end
    local allocatedBefore = collectgarbage("count")
    local selector = ''
    if bulk and jewelType == 11 then
        local nodes = {}; for id in pairs(path or {}) do nodes[#nodes+1] = id end
        selector = require('dkjson').encode({nodes=nodes, ascendancy=ascendancyName})
    end
    local bytes = GetAbyssRecord(jewelType, seed, socketId, bulk, selector)
    if #bytes == 0 then return end -- Out-of-range seed or a native unsupported socket.
    local lut = parseAbyssJewel(jewelType, bytes)
    loadedFamilies[jewelType] = true
    local blocks=0; for _ in pairs(lut.blockOffsets) do blocks=blocks+1 end
    for _ in pairs(lut.ascendancyOffsets or {}) do blocks=blocks+1 end
    local estimated = #bytes + blocks * (128 + lut.seedCount * 16)
    local weight = #key + math.max(estimated, math.ceil((collectgarbage("count") - allocatedBefore) * 1024))
    if bulk then searchBlock = {type = jewelType, socket = socketId, context = context, path=path, ascendancy=ascendancyName, lut = lut} end
    do
        if weight > recordLimit then error('Abyss record exceeds worker budget') end
        while cacheBytes + weight > recordLimit do
            local oldest, age
            for id, entry in pairs(recordCache) do if not age or entry.tick < age then oldest, age = id, entry.tick end end
            if searchBlock and searchBlock.lut == recordCache[oldest].lut then searchBlock = nil end
            cacheBytes = cacheBytes - recordCache[oldest].bytes
            recordCache[oldest] = nil
        end
        recordCache[key] = {lut = lut, bytes = weight, tick = tick}
        cacheBytes = cacheBytes + weight
    end
    return lut
end

function getAbyssRecordCacheProfile()
    local entries=0;for _ in pairs(recordCache) do entries=entries+1 end
    return require('dkjson').encode({bytes=cacheBytes, limit=recordLimit, entries=entries})
end

function getAbyssLoadedMask()
    local mask=0;for family in pairs(loadedFamilies) do mask=mask+2^(family-1) end
    return mask
end
