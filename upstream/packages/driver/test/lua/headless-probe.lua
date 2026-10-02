-- Exact vendored Wasm interpreter + desktop payload, with upstream headless API.
package.path = package.path .. ';./lua/?.lua;./lua/?/init.lua'
unpack, loadstring = table.unpack, load
bit = { lshift=bit32.lshift, rshift=bit32.rshift, band=bit32.band, bor=bit32.bor,
    bxor=bit32.bxor, bnot=bit32.bnot, tobit=function(n) n=n%0x100000000; return n>=0x80000000 and n-0x100000000 or n end }
jit = { opt = { start=function() end, stop=function() end } }
arg = {}
local realDofile = dofile
function dofile(path)
    local result = realDofile(path)
    if path == '_SimpleGraphic.def.lua' then
        Inflate, Deflate, GetTime = NativeInflate, NativeDeflate, ClockMs
        GetUserPath = function() return '/probe/user' end
    end
    return result
end
local function measure(phase, start)
    print(string.format('PROBE {"phase":"%s","ms":%.3f,"wasmBytes":%.0f,"luaKiB":%.3f}',
        phase, ClockMs()-start, HeapBytes(), collectgarbage('count')))
end
local start = ClockMs()
dofile('HeadlessWrapper.lua')
assert(build and not __mainObject__.promptMsg, 'headless boot must complete')
measure('boot', start)
local file = assert(io.open('/probe/build.xml', 'rb'))
local xml = file:read('*a'); file:close()
start = ClockMs(); loadBuildFromXML(xml, 'Public probe')
assert(not __mainObject__.promptMsg and build.calcsTab.mainOutput.Life, 'hydration must calculate')
measure('hydrate', start)
local life = build.calcsTab.mainOutput.Life
start = ClockMs(); loadBuildFromXML(xml, 'Public probe reset')
assert(build.calcsTab.mainOutput.Life == life, 'revision reset must preserve output')
measure('reset', start)
print(string.format('PROBE {"phase":"ceiling","rejected":%s,"limitBytes":134217728}', tostring(HeapBytes()>134217728)))
