#include <stdio.h>
#undef NDEBUG
#include <assert.h>
#include <math.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "lobject.h"

#ifdef LUA_NANTRICK
_Static_assert(sizeof(void *) == 4 && sizeof(int) == 4 && sizeof(double) == 8, "Compact values require wasm32 and doubles");
_Static_assert(sizeof(TValue) == 8, "Compact Lua values must use 8 bytes");
#else
_Static_assert(sizeof(TValue) == 16, "Original Lua values must use 16 bytes");
#endif

static void check_values(lua_State *L) {
    const double numbers[] = {0.0, -0.0, 1.0, -1.0, 0x1.fffffffffffffp+1023,
        0x1p-1074, 0x1.fffffffffffffp+52, INFINITY, -INFINITY, NAN};
    lua_newtable(L);
    for (unsigned i = 0; i < sizeof(numbers)/sizeof(numbers[0]); i++) {
        lua_pushnumber(L, numbers[i]); lua_rawseti(L, -2, i+1);
    }
    lua_gc(L, LUA_GCCOLLECT, 0);
    for (unsigned i = 0; i < sizeof(numbers)/sizeof(numbers[0]); i++) {
        lua_rawgeti(L, -1, i+1);
        assert(lua_type(L, -1) == LUA_TNUMBER);
        const double result = lua_tonumber(L, -1);
        if (isnan(numbers[i])) assert(isnan(result));
        else { assert(result == numbers[i]); assert(!!signbit(result) == !!signbit(numbers[i])); }
        lua_pop(L, 1);
    }
    lua_pop(L, 1);
}

int main(void) {
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    check_values(L);
    const char *source =
        "local nan, inf = 0/0, 1/0; assert(nan ~= nan and inf == math.huge and -inf == -math.huge)\n"
        "local t = {}; local key = {}; local function f() return 42 end\n"
        "t[key]=f; t[false]='boolean'; t[0]='zero'; t[1.5]='fraction'; t[9007199254740991]='precise'\n"
        "collectgarbage(); assert(t[key]()==42 and t[false]=='boolean' and t[-0.0]=='zero')\n"
        "assert(t[1.5]=='fraction' and t[9007199254740991]=='precise')\n"
        "assert(not pcall(function() t[nan]=1 end))\n"
        "local z=-0.0; assert(1/z==-math.huge)\n"
        "local x = 1; x += 2 * 3; assert(x == 7)\n"
        "local function up() x += 4 end; up(); assert(x == 11)\n"
        "global = 10; global += 2; assert(global == 12)\n"
        "local t, key = { value = 3 }, 'value'\n"
        "local original = t\n"
        "local function rhs() t = {}; key = 'other'; return 4 end\n"
        "t[key] += rhs(); assert(original.value == 7 and t.other == nil)\n"
        "local tc, kc = 0, 0\n"
        "local function tablefn() tc = tc + 1; return original end\n"
        "local function keyfn() kc = kc + 1; return 'value' end\n"
        "tablefn()[keyfn()] += 2; assert(tc == 1 and kc == 1 and original.value == 9)\n"
        "local gets, sets, adds = 0, 0, 0\n"
        "local operand = setmetatable({}, {__add = function(_, n) adds = adds + 1; return n + 5 end})\n"
        "local proxy = setmetatable({}, {__index = function() gets = gets + 1; return operand end,\n"
        "__newindex = function(_, k, v) sets = sets + 1; assert(k == 'a' and v == 8) end})\n"
        "proxy.a += 3; assert(gets == 1 and sets == 1 and adds == 1)\n"
        "local a = 5; local function mutate() a = 100; return 1 end; a += mutate(); assert(a == 6)\n"
        "local b = 1; b += (false or 2); assert(b == 3)\n"
        "local text = '+= not syntax'; assert(text == '+= not syntax') -- += comment\n"
        "assert(not load('local a,b=1,2; a,b += 3'))\n"
        "assert(not load('local function f() end; f() += 1'))\n";
    if (luaL_dostring(L, source) != LUA_OK) {
        fprintf(stderr, "Lua syntax regression: %s\n", lua_tostring(L, -1));
        lua_close(L);
        return 1;
    }
    lua_close(L);
    puts("Lua += native parser regression tests passed");
    return 0;
}
