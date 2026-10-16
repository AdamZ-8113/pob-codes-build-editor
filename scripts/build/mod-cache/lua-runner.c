/* Pack-time runner for the browser's vendored Lua interpreter. It executes the
 * owned ModCache generator against staged PoB sources and is never shipped.
 * Usage: lua-runner <PoB root> <script> [script arguments...] */
#include <stdio.h>
#include <unistd.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

extern int luaopen_utf8(lua_State *L);

int main(int argc, char **argv) {
    if (argc < 3 || chdir(argv[1])) return 2;
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    luaL_getsubtable(L, LUA_REGISTRYINDEX, "_PRELOAD");
    lua_pushcfunction(L, luaopen_utf8);
    lua_setfield(L, -2, "lua-utf8");
    lua_pop(L, 1);
    lua_createtable(L, argc - 3, 0);
    for (int i = 3; i < argc; i++) {
        lua_pushstring(L, argv[i]);
        lua_rawseti(L, -2, i - 2);
    }
    lua_setglobal(L, "arg");
    int status = luaL_dofile(L, argv[2]);
    if (status != LUA_OK) fprintf(stderr, "Lua runner failed: %s\n", lua_tostring(L, -1));
    lua_close(L);
    return status == LUA_OK ? 0 : 1;
}
