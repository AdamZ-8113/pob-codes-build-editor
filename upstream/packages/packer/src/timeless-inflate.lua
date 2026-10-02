-- Do not create a .bin cache (or pass nil to file:write) after a failed decode.
return function(compressedData)
    local jewelData, inflateError = Inflate(compressedData)
    if not jewelData then
        error("Cannot decompress Timeless Jewel data: " .. tostring(inflateError), 0)
    end
    return jewelData
end
