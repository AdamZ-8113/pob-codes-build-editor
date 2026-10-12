local emitted, frames = {}, 0
local scale = 1
local list = { subPath = "", builds = 0 }
function list:BuildList() self.builds = self.builds + 1 end
local main = {
    mode = "BUILD", buildPath = "/app/user/Path of Building/Builds/",
    screenW = 1550, screenH = 800, modes = { LIST = list },
}
local host = createBuildListHost(main, function(...)
    emitted[#emitted + 1] = table.pack(...)
end, function(count) frames = frames + count end, function() return scale end)

assert(host:observe() and #emitted == 1)
assert(emitted[1][1] == "BUILD" and emitted[1][2] == "")
assert(emitted[1][3] == main.buildPath and emitted[1][4] == 1550 and emitted[1][5] == 800 and emitted[1][6] == 1)
assert(not host:observe() and #emitted == 1)
assert(not host:refresh() and list.builds == 0 and frames == 0)

main.mode = "LIST"
list.subPath = "Ruthless/"
assert(host:observe() and emitted[2][1] == "LIST" and emitted[2][2] == "Ruthless/")
assert(host:refresh() and list.builds == 1 and frames == 2)
assert(#emitted == 2) -- Refresh without a state change does not emit.

main.buildPath = "/app/user/Custom/"
main.screenW, main.screenH, scale = 1200, 700, 1.5
assert(host:observe() and #emitted == 3)
assert(emitted[3][3] == "/app/user/Custom/" and emitted[3][4] == 1200 and emitted[3][5] == 700 and emitted[3][6] == 1.5)

local second = createBuildListHost(main, function(...) emitted[#emitted + 1] = table.pack(...) end,
    function() end, function() return scale end)
assert(second:observe() and #emitted == 4) -- Instance state is not shared.

main.mode = "BUILD"
assert(second:observe() and emitted[5][2] == "")
