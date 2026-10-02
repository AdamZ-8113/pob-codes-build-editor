return function(inflateTimeless)
    local writes = 0
    local function originalLoaderCachePath()
        local data = inflateTimeless("compressed")
        writes = writes + 1
        return data
    end
    Inflate = function(input) assert(input == "compressed"); return nil, "out of memory" end
    local ok, why = pcall(originalLoaderCachePath)
    assert(not ok and why == "Cannot decompress Timeless Jewel data: out of memory")
    assert(writes == 0, "A failed inflate must not reach the optional cache write")
    Inflate = function() return nil, "invalid data" end
    ok, why = pcall(originalLoaderCachePath)
    assert(not ok and why:find("invalid data", 1, true) and writes == 0)
    Inflate = function() return "binary\0\255data" end
    assert(originalLoaderCachePath() == "binary\0\255data" and writes == 1)
end
