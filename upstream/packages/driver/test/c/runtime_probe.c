/* Standalone experiment runner; not linked into the browser runtime. */
#include <stdio.h>
#include <unistd.h>
#include <emscripten.h>
#include <emscripten/heap.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "compression.h"
extern int luaopen_utf8(lua_State *L);
static int clock_ms(lua_State *L) { lua_pushnumber(L, emscripten_get_now()); return 1; }
static int heap_bytes(lua_State *L) { lua_pushnumber(L, emscripten_get_heap_size()); return 1; }
int main(int argc, char **argv) {
    if (argc != 3 || chdir(argv[1])) return 2;
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    luaL_getsubtable(L, LUA_REGISTRYINDEX, "_PRELOAD");
    lua_pushcfunction(L, luaopen_utf8); lua_setfield(L, -2, "lua-utf8"); lua_pop(L, 1);
    lua_register(L, "NativeInflate", driver_inflate);
    lua_register(L, "NativeDeflate", driver_deflate);
    lua_register(L, "ClockMs", clock_ms);
    lua_register(L, "HeapBytes", heap_bytes);
    if (luaL_dofile(L, argv[2]) != LUA_OK) {
        fprintf(stderr, "Runtime probe failed: %s\n", lua_tostring(L, -1)); lua_close(L); return 1;
    }
    lua_close(L); return 0;
}
