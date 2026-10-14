-- Experiment-only source-to-bytecode generator. This must run with the exact
-- wasm32 Lua VM used by the browser driver; its output is not portable.
local list = assert(io.open('/probe/lua-files.txt', 'rb'))
local results = assert(io.open('/probe/bytecode-results.tsv', 'wb'))
local sentinel = assert(io.open('/probe/bytecode-header.bin', 'wb'))
sentinel:write(string.dump(function() end):sub(1, 18))
sentinel:close()

for path in list:lines() do
	assert(path ~= '' and path:sub(1, 1) ~= '/' and not path:find('\\', 1, true))
	local input = assert(io.open(path, 'rb'))
	local source = input:read('*a')
	input:close()

	-- Match loadfile/dofile's relative source name without exposing scratch paths.
	-- load() intentionally leaves BOM and conditional-version sources as fallbacks.
	local fn = load(source, '@' .. path)
	local output = source
	local kind = 'fallback'
	if fn then
		output = string.dump(fn) -- Keep line/debug metadata and the @path source name.
		assert(load(output, '@' .. path, 'b'))
		kind = 'bytecode'
	end

	local target = assert(io.open('/probe/bytecode/' .. path, 'wb'))
	target:write(output)
	target:close()
	results:write(kind, '\t', path, '\t', #source, '\t', #output, '\n')
end

list:close()
results:close()
