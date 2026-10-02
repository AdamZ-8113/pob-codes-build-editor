-- Browser compatibility adapter: preserve Glorious Vanity's exact seed bytes
-- without allocating every possible seed string for each touched passive node.
local function desktopSparseTimelessSeeds(raw, sizes, nodeIndex, seedCount)
    local checkpoints = { [0] = 0 }
    local lastCheckpoint = 0
    local order, cursor = {}, 0
    return setmetatable({}, {
        __index = function(self, key)
            if type(key) ~= "number" or key % 1 ~= 0 or key < 1 or key > seedCount then return end
            local block = math.floor((key - 1) / 256)
            for nextBlock = lastCheckpoint + 1, block do
                local offset = checkpoints[nextBlock - 1]
                for seed = (nextBlock - 1) * 256 + 1, nextBlock * 256 do
                    offset = offset + assert(sizes:byte(nodeIndex * seedCount + seed), "Missing timeless seed size")
                end
                checkpoints[nextBlock] = offset
            end
            lastCheckpoint = math.max(lastCheckpoint, block)
            local offset = checkpoints[block]
            for seed = block * 256 + 1, key - 1 do
                offset = offset + assert(sizes:byte(nodeIndex * seedCount + seed), "Missing timeless seed size")
            end
            local length = assert(sizes:byte(nodeIndex * seedCount + key), "Missing timeless seed size")
            local value = raw:sub(offset + 1, offset + length)
            assert(#value == length, "Truncated timeless seed data")
            cursor = cursor % 32 + 1
            if order[cursor] then rawset(self, order[cursor], nil) end
            order[cursor] = key
            rawset(self, key, value)
            return value
        end,
    })
end

return desktopSparseTimelessSeeds
