-- Generates and verifies the mastery-option ModCache supplement inside the
-- browser's vendored Lua interpreter (lua-runner.c), with the staged packed PoB
-- sources as the working directory. Entries are PoB's own parseMod results,
-- serialized by PoB's own main:SaveModCache; an entry that does not reload
-- exactly is excluded, so PoB parses it on demand as before.
--   generate <treeVersion> <userDir> <supplement output> <report output>
--   verify   <treeVersion> <userDir> <shipped ModCache>  <report output>
local mode, treeVersion, userDir, dataPath, reportPath = arg[1], arg[2], arg[3], arg[4], arg[5]
assert((mode == 'generate' or mode == 'verify') and treeVersion and userDir and dataPath and reportPath,
    'usage: supplement.lua generate|verify <treeVersion> <userDir> <file> <report>')

-- The browser boot.lua compatibility prelude for PoB's LuaJIT assumptions.
package.path = package.path .. ';./lua/?.lua;./lua/?/init.lua'
unpack = table.unpack
loadstring = load
bit = {
    lshift = bit32.lshift, rshift = bit32.rshift, band = bit32.band,
    bor = bit32.bor, bxor = bit32.bxor, bnot = bit32.bnot,
    tobit = function(value)
        local normalized = value % 0x100000000
        return normalized >= 0x80000000 and normalized - 0x100000000 or normalized
    end,
}
if not setfenv then
    local function findenv(f)
        local level = 1
        repeat
            local name, value = debug.getupvalue(f, level)
            if name == '(luajit-env)' then return level, value end
            level = level + 1
        until name == nil
        return nil
    end
    getfenv = function(f) return (select(2, findenv(f)) or _G) end
    setfenv = function(f, t)
        local level = findenv(f)
        if level then debug.setupvalue(f, level, t) end
        return f
    end
end
arg = {}
jit = { opt = { start = function() end, stop = function() end } }

local realDofile = dofile
function dofile(path)
    local result = realDofile(path)
    if path == '_SimpleGraphic.def.lua' then
        GetUserPath = function() return userDir end
    end
    return result
end
dofile('HeadlessWrapper.lua')
dofile = realDofile
assert(build and not __mainObject__.promptMsg, 'Headless PoB boot failed')
assert(treeVersion == latestTreeVersion,
    'Supplement tree version ' .. treeVersion .. ' is not PoB latestTreeVersion ' .. tostring(latestTreeVersion))
local main = __mainObject__.main
local parseMod = modLib.parseMod

local function deepEqual(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= 'table' then return a == b end
    for k, v in pairs(a) do
        if not deepEqual(v, b[k]) then return false end
    end
    for k in pairs(b) do
        if a[k] == nil then return false end
    end
    return true
end

-- Every line PassiveSpec:AddMasteryEffectOptionsToNode asks the parser for
-- when the first spec of this tree version builds its mastery option cache.
local function masteryOptionLines()
    local specClass = common.classes.PassiveSpec
    local addOptions = specClass.AddMasteryEffectOptionsToNode
    local depth, lines = 0, { }
    modLib.parseMod = function(line, isComb)
        if depth > 0 then lines[line] = true end
        return parseMod(line, isComb)
    end
    specClass.AddMasteryEffectOptionsToNode = function(...)
        depth = depth + 1
        addOptions(...)
        depth = depth - 1
    end
    for _, node in pairs(main:LoadTree(treeVersion).nodes) do
        node.masteryCache = nil
    end
    new('PassiveSpec'):PassiveSpec(build, treeVersion)
    modLib.parseMod, specClass.AddMasteryEffectOptionsToNode = parseMod, addOptions
    local sorted = { }
    for line in pairs(lines) do sorted[#sorted + 1] = line end
    table.sort(sorted)
    return sorted
end

-- parseMod returns an unpacked copy of its cache entry. Compare the outputs of
-- a cache hit on `entry` with a fresh on-demand parse of the same line.
local function sameParse(line, entry)
    modLib.parseModCache[line] = entry
    local cached = table.pack(parseMod(line))
    modLib.parseModCache[line] = nil
    local fresh = table.pack(parseMod(line))
    return deepEqual(cached, fresh) and deepEqual(entry, modLib.parseModCache[line])
end

local function jsonString(value)
    return '"' .. value:gsub('[%c"\\]', function(c)
        return c == '"' and '\\"' or c == '\\' and '\\\\' or string.format('\\u%04x', c:byte())
    end) .. '"'
end

local function writeReport(fields)
    local parts = { }
    for _, field in ipairs(fields) do
        local name, value = field[1], field[2]
        if type(value) == 'table' then
            local items = { }
            for _, item in ipairs(value) do
                items[#items + 1] = '{"key":' .. jsonString(item.key) .. ',"reason":' .. jsonString(item.reason) .. '}'
            end
            value = '[' .. table.concat(items, ',') .. ']'
        elseif type(value) == 'string' then
            value = jsonString(value)
        end
        parts[#parts + 1] = jsonString(name) .. ':' .. tostring(value)
    end
    local out = assert(io.open(reportPath, 'w'))
    out:write('{', table.concat(parts, ','), '}\n')
    out:close()
end

if mode == 'generate' then
    local shipped = LoadModule('Data/ModCache')
    local lines = masteryOptionLines()
    local supplement, excluded, missing = { }, { }, 0
    for _, line in ipairs(lines) do
        if shipped[line] == nil then
            missing = missing + 1
            modLib.parseModCache[line] = nil
            parseMod(line)
            if line:find('["\\\r\n]') then
                -- SaveModCache escapes only newlines inside keys.
                excluded[#excluded + 1] = { key = line, reason = 'unescaped-key' }
            else
                supplement[line] = modLib.parseModCache[line]
            end
        end
    end
    local function save()
        local cache, open = modLib.parseModCache, io.open
        modLib.parseModCache = supplement
        io.open = function(path, fileMode)
            assert(path == 'Data/ModCache.lua' and fileMode == 'w', 'Unexpected SaveModCache output')
            return open(dataPath, fileMode)
        end
        local ok, err = pcall(main.SaveModCache, main)
        modLib.parseModCache, io.open = cache, open
        assert(ok, err)
        return assert(loadfile(dataPath))()
    end
    local loaded = save()
    local inexact = false
    for line, entry in pairs(supplement) do
        if loaded[line] == nil then
            -- SaveModCache omits JewelFunc results.
            excluded[#excluded + 1] = { key = line, reason = 'not-serialized' }
            supplement[line] = nil
        elseif not deepEqual(loaded[line], entry) then
            excluded[#excluded + 1] = { key = line, reason = 'inexact-serialization' }
            supplement[line] = nil
            inexact = true
        end
    end
    if inexact then loaded = save() end
    local entries = 0
    for line, entry in pairs(supplement) do
        assert(sameParse(line, loaded[line]) and deepEqual(loaded[line], entry), 'Supplement entry differs from on-demand parsing: ' .. line)
        entries = entries + 1
    end
    for line in pairs(loaded) do assert(supplement[line], 'Unexpected serialized entry: ' .. line) end
    table.sort(excluded, function(a, b) return a.key < b.key end)
    writeReport({ { 'mode', mode }, { 'treeVersion', treeVersion }, { 'requested', #lines },
        { 'missing', missing }, { 'entries', entries }, { 'excluded', excluded } })
else
    -- The working directory holds the packed Data/ModCache.lua; dataPath is the
    -- shipped upstream file it was generated from.
    local packed, shipped = LoadModule('Data/ModCache'), assert(loadfile(dataPath))()
    local shippedEntries, added = 0, { }
    for line, entry in pairs(shipped) do
        assert(deepEqual(packed[line], entry), 'Packed ModCache changed a shipped entry: ' .. line)
        shippedEntries = shippedEntries + 1
    end
    for line in pairs(packed) do
        if shipped[line] == nil then added[#added + 1] = line end
    end
    table.sort(added)
    for _, line in ipairs(added) do
        assert(sameParse(line, packed[line]), 'Packed supplement differs from on-demand parsing: ' .. line)
    end
    -- The first spec of this tree version must now miss only excluded lines.
    local misses = { }
    for _, line in ipairs(masteryOptionLines()) do
        if packed[line] == nil then misses[#misses + 1] = { key = line, reason = 'miss' } end
    end
    writeReport({ { 'mode', mode }, { 'treeVersion', treeVersion }, { 'shippedEntries', shippedEntries },
        { 'entries', #added }, { 'misses', misses } })
end
