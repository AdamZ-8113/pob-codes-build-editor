-- Resolve catalogue membership without eagerly parsing every unique in a helper.
-- Headers only narrow the search: PoB's Item parser always verifies the full key.
return function(uniqueData, database, createItem, finishLoading, normalizeLine)
    local titles
    local function indexTitles()
        titles = {}
        for _, list in pairs(uniqueData) do
            for _, raw in pairs(list) do
                local title
                for line in raw:gmatch('%s*([^\n]*%S)') do
                    if normalizeLine then line = normalizeLine(line) end
                    if not line:match('^Item Class:') and not line:match('^Rarity: %a+') and line ~= '--------' then
                        title = line
                        break
                    end
                end
                if title then
                    title = title:gsub('%s+$', ''):gsub(' %(.+%)', ''):lower()
                    local plain = title:gsub('^foulborn ', '')
                    local aliases = {[title]=true, [plain]=true, ['foulborn '..plain]=true}
                    for alias in pairs(aliases) do
                        local group = titles[alias]
                        if not group then group = {}; titles[alias] = group end
                        group[#group+1] = raw
                    end
                end
            end
        end
    end
    return function(key)
        if type(key) ~= 'string' then return end
        local existing = database.list[key]
        if existing then return existing end
        if not titles then indexTitles() end
        local title = key:match('^(.*), ')
        local group = title and titles[title:lower()]
        local found
        for _, raw in ipairs(group or {}) do
            local item = createItem(raw)
            if item.base then
                database.list[item.name] = item
                if item.name == key then found = item end
            end
        end
        if found then return found end
        -- Unusual headers and unknown keys retain the original authoritative
        -- loader/validation path. Never infer membership from a header alone.
        finishLoading()
        return database.list[key]
    end
end
