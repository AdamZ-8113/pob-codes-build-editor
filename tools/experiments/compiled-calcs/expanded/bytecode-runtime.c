/* Experiment-only exact-VM bytecode generator host. */
#include <stdio.h>
#include <unistd.h>
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

int main(int argc, char **argv) {
    if (argc != 3 || chdir(argv[1])) return 2;
    lua_State *L = luaL_newstate();
    if (L == NULL) return 3;
    luaL_openlibs(L);
    if (luaL_dofile(L, argv[2]) != LUA_OK) {
        fprintf(stderr, "Bytecode generation failed: %s\n", lua_tostring(L, -1));
        lua_close(L);
        return 1;
    }
    lua_close(L);
    return 0;
}
