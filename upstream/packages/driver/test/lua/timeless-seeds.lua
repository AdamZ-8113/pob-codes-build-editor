return function(makeSeeds)
    local seedCount = 7901
    local lengths, payloads, expected = {}, {}, {}
    for node = 0, 2 do
        local parts, values = {}, {}
        for seed = 1, seedCount do
            local length = (seed * 17 + node) % 9
            lengths[#lengths + 1] = string.char(length)
            local value = string.rep(string.char((seed + node) % 256), length)
            parts[#parts + 1], values[seed] = value, value
        end
        payloads[node], expected[node] = table.concat(parts), values
    end
    local sizes = table.concat(lengths)
    for node = 0, 2 do
        local seeds = makeSeeds(payloads[node], sizes, node, seedCount)
        assert(seeds.raw == nil and seeds[0] == nil and seeds[seedCount + 1] == nil)
        for _, seed in ipairs({1, 256, 257, 512, 7899, 7900, 7901, 2, 1, 257}) do
            assert(seeds[seed] == expected[node][seed], "Boundary or alternate seed mismatch")
        end
        -- Exhaustive byte parity against the original sequential split, then
        -- reverse lookups after eviction. Empty and binary seeds are included.
        for seed = 1, seedCount do assert(seeds[seed] == expected[node][seed]) end
        for seed = seedCount, 1, -1 do assert(seeds[seed] == expected[node][seed]) end
        local retained = 0
        for _ in pairs(seeds) do retained = retained + 1 end
        assert(retained <= 32, "Sparse seed cache must remain bounded")
    end
    local broken = makeSeeds("", string.char(1), 0, 1)
    assert(not pcall(function() return broken[1] end), "Truncated data must fail")
end
