#include <stdio.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

extern const char *cache_lua;
extern const char *cache_test_lua;
extern const char *runtime_profile_lua;
extern const char *runtime_profile_test_lua;
extern const char *calculation_scheduler_lua;
extern const char *calculation_scheduler_test_lua;
extern const char *timeless_seeds_lua;
extern const char *timeless_seeds_test_lua;
extern const char *timeless_inflate_lua;
extern const char *timeless_inflate_test_lua;
extern const char *unique_delay_lua;
extern const char *unique_delay_test_lua;
extern const char *unique_workers_lua;
extern const char *unique_workers_test_lua;
extern const char *gc_policy_lua;
extern const char *gc_policy_test_lua;

int main(void) {
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    if (luaL_dostring(L, gc_policy_test_lua) != LUA_OK) goto failure;
    if (luaL_dostring(L, gc_policy_lua) != LUA_OK) goto failure;
    if (lua_pcall(L, 1, 0, 0) != LUA_OK) goto failure;
    if (luaL_dostring(L, cache_lua) == LUA_OK) {
        lua_setglobal(L, "installItemTooltipCache");
        if (luaL_dostring(L, cache_test_lua) == LUA_OK) {
            if (luaL_dostring(L, runtime_profile_lua) != LUA_OK) goto failure;
            lua_setglobal(L, "installRuntimeProfile");
            if (luaL_dostring(L, runtime_profile_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, calculation_scheduler_lua) != LUA_OK) goto failure;
            lua_setglobal(L, "calculationScheduler");
            if (luaL_dostring(L, calculation_scheduler_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, timeless_seeds_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, timeless_seeds_lua) != LUA_OK) goto failure;
            if (lua_pcall(L, 1, 0, 0) != LUA_OK) goto failure;
            if (luaL_dostring(L, timeless_inflate_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, timeless_inflate_lua) != LUA_OK) goto failure;
            if (lua_pcall(L, 1, 0, 0) != LUA_OK) goto failure;
            if (luaL_dostring(L, unique_delay_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, unique_delay_lua) != LUA_OK) goto failure;
            if (lua_pcall(L, 1, 0, 0) != LUA_OK) goto failure;
            if (luaL_dostring(L, unique_workers_test_lua) != LUA_OK) goto failure;
            if (luaL_dostring(L, unique_workers_lua) != LUA_OK) goto failure;
            if (lua_pcall(L, 1, 0, 0) != LUA_OK) goto failure;
            lua_close(L);
            puts("Item tooltip cache regression tests passed");
            return 0;
        }
    }
failure:
    fprintf(stderr, "Desktop adapter regression: %s\n", lua_tostring(L, -1));
    lua_close(L);
    return 1;
}
