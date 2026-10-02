local time = 0
GetTime = function() return time end
local calcs = { buildOutput = function(_, mode)
    if mode == 'error' then error('expected') end
    time = time + 9
    return 42, nil, mode
end }
local build = { calcsTab = { calcs = calcs, BuildPower = function() time = time + 11 end } }
installRuntimeProfile(build)
installRuntimeProfile(build)
calcs.buildOutput(build, 'MAIN')
assert(getRuntimeProfile(true):find('"MAIN":%[%]')) -- disabled until requested
for i = 1, 140 do
    local a,b,c = calcs.buildOutput(build, 'MAIN')
    assert(a == 42 and b == nil and c == 'MAIN')
end
build.calcsTab:BuildPower()
local report = getRuntimeProfile(false)
assert(report:find('"count":140,"totalMs":1260,"maxMs":9'))
assert(report:find('"heatmap":%[11%]'))
assert(not pcall(calcs.buildOutput, build, 'error'))
getRuntimeProfile(true)
assert(getRuntimeProfile(false):find('"MAIN":%[%]'))
assert(not pcall(installRuntimeProfile, {}))
build.itemsTab = { controls = { uniqueDB = { controls = { search = {} },
    GetPos = function() error('tab not drawn') end, GetSize = function() return 100, 100 end } } }
installRuntimeProfile(build)
assert(not getRuntimeProfile(false):find('uniqueDbBounds'))
