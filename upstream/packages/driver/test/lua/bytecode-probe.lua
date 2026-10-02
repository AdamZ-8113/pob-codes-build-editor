-- Parse-only experiment: source text and exact-interpreter bytecode, no execution.
local file = assert(io.open('/probe/lua-files.txt', 'r'))
local paths = {}; for path in file:lines() do paths[#paths+1] = path end; file:close()
local sourceBytes, bytecodeBytes, parseMs, loadMs = 0, 0, 0, 0
local fallbacks = 0
for _, path in ipairs(paths) do
    local input = assert(io.open(path, 'rb')); local source = input:read('*a'); input:close()
    local start = ClockMs(); local fn = load(source, '@' .. path); parseMs = parseMs + ClockMs()-start
    local compiled = source
    if fn then
        compiled = string.dump(fn)
        start = ClockMs(); assert(load(compiled)); loadMs = loadMs + ClockMs()-start
    else
        -- Preserve chunks requiring loadfile-specific handling (for example a
        -- BOM), and conditional Lua 5.3/JIT modules this interpreter cannot load.
        fallbacks = fallbacks + 1
    end
    local out = assert(io.open('/probe/bytecode/' .. path, 'wb')); out:write(compiled); out:close()
    sourceBytes, bytecodeBytes = sourceBytes + #source, bytecodeBytes + #compiled
end
print(string.format('PROBE {"files":%d,"fallbacks":%d,"sourceBytes":%d,"bytecodeBytes":%d,"parseMs":%.3f,"loadMs":%.3f}',
    #paths, fallbacks, sourceBytes, bytecodeBytes, parseMs, loadMs))
