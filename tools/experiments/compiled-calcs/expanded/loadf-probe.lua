-- Exact-VM semantic probe for experiment-only luaL_loadfilex buffer variants.
local case = assert(os.getenv("LOADF_CASE"), "LOADF_CASE is required")

local function quote(value)
	return string.format("%q", tostring(value))
end

local function record(name, ...)
	local values = table.pack(...)
	local fields = { "RESULT", name, tostring(values.n) }
	for index = 1, values.n do
		fields[#fields + 1] = type(values[index]) .. ":" .. quote(values[index])
	end
	print(table.concat(fields, "\t"))
end

local function loadResult(name, path, mode, expected)
	local chunk, message = loadfile(path, mode)
	if not chunk then
		record(name, "load-error", message)
		return false, message
	end
	local values = table.pack(pcall(chunk))
	if not values[1] then
		record(name, "run-error", values[2])
		return false, values[2]
	end
	table.remove(values, 1)
	values.n = values.n - 1
	record(name, "ok", table.unpack(values, 1, values.n))
	if expected ~= nil then assert(values.n == 1 and values[1] == expected, name .. " result mismatch") end
	return true, values
end

if case == "suite" then
	for _, bytes in ipairs({ 1023, 1024, 1025, 16383, 16384, 16385, 65535, 65536, 65537, 262143, 262144, 262145, 524289 }) do
		local filler = bytes - #"local pad = [[" - #"]]\nreturn #pad\n"
		assert(filler >= 0)
		assert(loadResult("source-" .. bytes, "source-" .. bytes .. ".lua", "t", filler))
	end
	for _, bytes in ipairs({ 262143, 262144, 262145 }) do
		local filler = bytes - #"\239\187\191#!/usr/bin/env lua\n" - #"local pad = [[" - #"]]\nreturn #pad\n"
		assert(loadResult("prefixed-" .. bytes, "prefixed-" .. bytes .. ".lua", "t", filler))
	end
	assert(loadResult("bom", "bom.lua", "t", "bom"))
	assert(loadResult("shebang", "shebang.lua", "t", "shebang"))
	assert(loadResult("bom-shebang", "bom-shebang.lua", "t", "bom-shebang"))
	assert(loadResult("shebang-eof", "shebang-eof.lua", "t", nil))
	assert(loadResult("empty", "empty.lua", "t", nil))

	local missing, missingMessage = loadfile("missing.lua", "t")
	assert(not missing and missingMessage:find("cannot open", 1, true))
	record("missing", "load-error", missingMessage)
	local syntax, syntaxMessage = loadfile("syntax.lua", "t")
	assert(not syntax and syntaxMessage:find("syntax.lua", 1, true))
	record("syntax", "load-error", syntaxMessage)

	local binarySource = assert(load("return function() return 'binary' end", "@binary-source.lua", "t"))()
	local binary = string.dump(binarySource)
	local file = assert(io.open("binary.luac", "wb")); assert(file:write(binary)); assert(file:close())
	assert(loadResult("binary", "binary.luac", "b", "binary"))
	file = assert(io.open("binary-bom.luac", "wb")); assert(file:write("\239\187\191", binary)); assert(file:close())
	assert(loadResult("binary-bom", "binary-bom.luac", "b", "binary"))
	file = assert(io.open("binary-shebang.luac", "wb")); assert(file:write("#!/usr/bin/env lua\n", binary)); assert(file:close())
	assert(loadResult("binary-shebang", "binary-shebang.luac", "b", "binary"))
	local binaryText, binaryTextMessage = loadfile("binary.luac", "t")
	assert(not binaryText)
	record("binary-as-text", "load-error", binaryTextMessage)
	local textBinary, textBinaryMessage = loadfile("source-1024.lua", "b")
	assert(not textBinary)
	record("text-as-binary", "load-error", textBinaryMessage)

	file = assert(io.open("binary-truncated.luac", "wb")); assert(file:write(binary:sub(1, -3))); assert(file:close())
	local truncated, truncatedMessage = loadfile("binary-truncated.luac", "b")
	assert(not truncated)
	record("binary-truncated", "load-error", truncatedMessage)

	local total = 0
	for _ = 1, 200 do
		local chunk = assert(loadfile("source-65536.lua", "t"))
		total = total + assert(chunk())
	end
	record("repeated-200", "ok", total)
	local binaryCount = 0
	for _ = 1, 200 do
		local chunk = assert(loadfile("binary.luac", "b"))
		assert(chunk() == "binary")
		binaryCount = binaryCount + 1
	end
	record("binary-repeated-200", "ok", binaryCount)
elseif case == "nested" then
	assert(loadResult("nested-48", "nested-01.lua", "t", 48))
elseif case == "deep" then
	assert(loadResult("deep-lua-160", "deep.lua", "t", 262116))
elseif case == "parser" then
	assert(loadResult("parser-accepted-100", "parser-accepted.lua", "t", 1))
	local chunk, message = loadfile("parser-too-deep.lua", "t")
	assert(not chunk and message)
	record("parser-too-deep-400", "load-error", message)
elseif case == "stdin" then
	local chunk, message = loadfile(nil, "t")
	assert(chunk, message)
	local ok, value = pcall(chunk)
	assert(ok and value == "stdin-ok")
	record("stdin", "ok", value)
else
	error("Unknown LOADF_CASE")
end
