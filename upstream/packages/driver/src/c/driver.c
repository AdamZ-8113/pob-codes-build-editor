#include <stdio.h>
#include <unistd.h>
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <assert.h>
#include <string.h>
#include "compression.h"
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"
#include "draw.h"
#include "dpi.h"
#include "image.h"
#include "fs.h"
#include "sub.h"
#include "lcurl.h"

extern backend_t wasmfs_create_nodefs_backend(const char* root);
extern int luaopen_utf8(lua_State *L);

extern const char *boot_lua;
extern const char *helper_boot_lua;
static lua_State *GL;
static double st_start_time;
static char *helper_result;

static int GetRuntimeGCPause(lua_State *L) {
    lua_pushinteger(L, EM_ASM_INT({ return Module.runtimeGCPause ?? 400; }));
    return 1;
}

static int GetRuntimeItemTooltipCacheMode(lua_State *L) {
    lua_pushinteger(L, EM_ASM_INT({ return Module.runtimeItemTooltipCacheMode ?? 1; }));
    return 1;
}

static int CopyAbyssRecord(lua_State *L) {
    lua_pushlstring(L, lua_touserdata(L, 1), (size_t)lua_tointeger(L, 2));
    return 1;
}

static int GetAbyssRecord(lua_State *L) {
    luaL_checkstack(L, 4, "Abyss record result");
    int type = luaL_checkinteger(L, 1), seed = luaL_checkinteger(L, 2), socket = luaL_checkinteger(L, 3);
    int bulk = lua_toboolean(L, 4);
    const char *selector = luaL_optstring(L, 5, "");
    size_t size = 0;
    char *bytes = (char *)EM_ASM_PTR({
        // The RPC protocol omits zero-length data. Native out-of-range seeds
        // and unsupported sockets intentionally resolve to an empty lookup.
        var result = Module.rpcCall("abyss-record", [$0, $1, $2, !!$3, UTF8ToString($5)], undefined, 1024 * 1024).data ?? new Uint8Array();
        HEAPU32[$4 >> 2] = result.length;
        var ptr = _malloc(Math.max(1, result.length));
        if (!ptr) throw new Error("Abyss record allocation failed");
        HEAPU8.set(result, ptr); return ptr;
    }, type, seed, socket, bulk, &size, selector);
    lua_pushcfunction(L, CopyAbyssRecord);
    lua_pushlightuserdata(L, bytes);
    lua_pushinteger(L, size);
    int status = lua_pcall(L, 2, 1, 0);
    free(bytes);
    if (status != LUA_OK) return lua_error(L);
    return 1;
}

static int IsMobileRuntime(lua_State *L) {
    lua_pushboolean(L, EM_ASM_INT({ return Module.runtimeMobile ? 1 : 0; }));
    return 1;
}

static int UniqueSortAvailable(lua_State *L) {
    lua_pushinteger(L, EM_ASM_INT({ return Module.uniqueSortAvailable ? Module.uniqueSortAvailable() : 0; }));
    return 1;
}
static int CancelUniqueSort(lua_State *L) {
    EM_ASM({ if (Module.cancelUniqueSort) Module.cancelUniqueSort(); });
    return 0;
}
static int BeginUniqueSort(lua_State *L) {
    int id = EM_ASM_INT({ return Module.beginUniqueSort(UTF8ToString($0)); }, luaL_checkstring(L, 1));
    lua_pushinteger(L, id); return 1;
}
static int PollUniqueSort(lua_State *L) {
    char *result = (char *)EM_ASM_PTR({
        var value = Module.pollUniqueSort($0);
        if (value === undefined) return 0;
        var size = lengthBytesUTF8(value) + 1;
        var ptr = _malloc(size); stringToUTF8(value, ptr, size); return ptr;
    }, luaL_checkinteger(L, 1));
    if (result) { lua_pushstring(L, result); free(result); } else lua_pushnil(L);
    return 1;
}

static void *my_alloc(void *ud, void *ptr, size_t osize, size_t nsize) {
    (void)ud;  (void)osize;  /* 未使用の引数 */
    if (nsize == 0) {
        free(ptr);
        return NULL;
    }
    else
        return realloc(ptr, nsize);
}

static int at_panic(lua_State *L) {
    fprintf(stderr, "Panic: %s\n", lua_tostring(L, -1));
    return 0;
}

static int OnError(lua_State *L) {
    EM_ASM({
               Module.onError(UTF8ToString($0));
           }, lua_tostring(L, -1));
    return 0;
}

static int OnOAuthLogout(lua_State *L) {
    EM_ASM({ Module.onOAuthLogout(); });
    return 0;
}

static int push_callback(lua_State *L, const char *name) {
    lua_getfield(L, LUA_REGISTRYINDEX, "uicallbacks");
    lua_getfield(L, -1, name);
    if (lua_isfunction(L, -1)) {
        lua_remove(L, -2);
        return 0;
    } else {
        lua_pop(L, 1);
        lua_getfield(L, -1, "MainObject");
        lua_remove(L, -2);
        if (lua_istable(L, -1)) {
            lua_getfield(L, -1, name);
            if (lua_isfunction(L, -1)) {
                lua_insert(L, -2);
                return 1;
            } else {
                lua_pop(L, 1);
            }
        } else {
            lua_pop(L, 1);
        }
    }
    return -1;
}

static int SetCallback(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));
    lua_pushvalue(L, 1);
    if (n >= 2) {
        assert(lua_isfunction(L, 2));
        lua_pushvalue(L, 2);
    } else {
        lua_pushnil(L);
    }
    lua_settable(L, lua_upvalueindex(1));
    return 0;
}

static int GetCallback(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));
    lua_pushvalue(L, 1);
    lua_gettable(L, lua_upvalueindex(1));
    return 1;
}

static int SetMainObject(lua_State *L) {
    int n = lua_gettop(L);
    lua_pushstring(L, "MainObject");
    if (n >= 1) {
        assert(lua_istable(L, 1) || lua_isnil(L, 1));
        lua_pushvalue(L, 1);
    } else {
        lua_pushnil(L);
    }
    lua_settable(L, lua_upvalueindex(1));
    return 0;
}

static int GetMainObject(lua_State *L) {
    lua_pushstring(L, "MainObject");
    lua_gettable(L, lua_upvalueindex(1));
    return 1;
}

static int GetTime(lua_State *L) {
    double t = emscripten_get_now() - st_start_time;
    lua_pushinteger(L, (int)t);
    return 1;
}

static int RequestFrames(lua_State *L) {
    EM_ASM({ Module.requestFrames($0); }, luaL_checkinteger(L, 1));
    return 0;
}

static int OnCalculationPending(lua_State *L) {
    EM_ASM({ Module.onCalculationPending(!!$0); }, lua_toboolean(L, 1));
    return 0;
}

static int GetCursorPos(lua_State *L) {
    double x = EM_ASM_DOUBLE({ return Module.getCursorPosX(); });
    double y = EM_ASM_DOUBLE({ return Module.getCursorPosY(); });
    double system_scale = draw_system_scale();
    lua_pushinteger(L, dpi_cursor_coordinate(x, system_scale));
    lua_pushinteger(L, dpi_cursor_coordinate(y, system_scale));
    return 2;
}

static int IsKeyDown(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));

    const char *name = lua_tostring(L, 1);
    int result = EM_ASM_INT({
                                return Module.isKeyDown(UTF8ToString($0));
                            }, name);
    lua_pushboolean(L, result);
    return 1;
}

static int Copy(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));

    const char *text = lua_tostring(L, 1);

    EM_ASM({
               Module.copy(UTF8ToString($0));
           }, text);
    return 0;
}

EM_JS(int, paste, (), {
    var text = Module.takePasteText();
    if (text === undefined) {
        text = Module.rpcCall("paste").value;
    }
    var lengthBytes = lengthBytesUTF8(text) + 1;
    var stringOnWasmHeap = _malloc(lengthBytes);
    stringToUTF8(text, stringOnWasmHeap, lengthBytes);
    return stringOnWasmHeap;
});

static int Paste(lua_State *L) {
    const char *text = (const char *)paste();
    lua_pushlstring(L, text, strlen(text));
    free((void *)text);
    return 1;
}

static int SetWindowTitle(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));

    const char *title = lua_tostring(L, 1);

    EM_ASM({
        Module.setWindowTitle(UTF8ToString($0));
    }, title);

    return 0;
}

static int OpenURL(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    assert(lua_isstring(L, 1));

    const char *url = lua_tostring(L, 1);

    EM_ASM({
               Module.openUrl(UTF8ToString($0));
           }, url);

    return 0;
}

static int DownloadPage(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 3);
    assert(lua_isstring(L, 1));
    assert(lua_isstring(L, 2) || lua_isnil(L, 2));
    assert(lua_isstring(L, 3) || lua_isnil(L, 3));

    const char *url = lua_tostring(L, 1);
    const char *header = lua_tostring(L, 2);
    const char *body = lua_tostring(L, 3);

    EM_ASM({
               Module.fetch(UTF8ToString($0), UTF8ToString($1), UTF8ToString($2));
           }, url, header, body);

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int init() {
    backend_t app = wasmfs_create_nodefs_backend("");
    wasmfs_create_directory("/app", 0777, app);

    chdir("/app/root");

    GL = lua_newstate(my_alloc, NULL);
    lua_State *L = GL;

    // Open standard libraries
    luaL_openlibs(GL);
    lua_register(GL, "GetAbyssRecord", GetAbyssRecord);
    lua_register(GL, "IsMobileRuntime", IsMobileRuntime);
    lua_register(GL, "BeginUniqueSort", BeginUniqueSort);
    lua_register(GL, "GetRuntimeGCPause", GetRuntimeGCPause);
    lua_register(GL, "GetRuntimeItemTooltipCacheMode", GetRuntimeItemTooltipCacheMode);
    lua_register(GL, "UniqueSortAvailable", UniqueSortAvailable);
    lua_register(GL, "CancelUniqueSort", CancelUniqueSort);
    lua_register(GL, "PollUniqueSort", PollUniqueSort);
    luaL_getsubtable(L, LUA_REGISTRYINDEX, "_PRELOAD");
    lua_pushcfunction(L, luaopen_utf8);
    lua_setfield(L, -2, "lua-utf8");
    lua_pop(L, 1);

    // Handle lua errors
    lua_atpanic(L, at_panic);

    lua_newtable(L);
    lua_rawseti(L, LUA_REGISTRYINDEX, 0);

    lua_pushcclosure(L, OnError, 0);
    lua_setglobal(L, "OnError");

    lua_pushcclosure(L, OnOAuthLogout, 0);
    lua_setglobal(L, "OnOAuthLogout");

    // Callbacks
    lua_newtable(L);

    lua_pushvalue(L, -1);
    lua_pushcclosure(L, SetCallback, 1);
    lua_setglobal(L, "SetCallback");

    lua_pushvalue(L, -1);
    lua_pushcclosure(L, GetCallback, 1);
    lua_setglobal(L, "GetCallback");

    lua_pushvalue(L, -1);
    lua_pushcclosure(L, SetMainObject, 1);
    lua_setglobal(L, "SetMainObject");

    lua_pushvalue(L, -1);
    lua_pushcclosure(L, GetMainObject, 1);
    lua_setglobal(L, "GetMainObject");

    lua_setfield(L, LUA_REGISTRYINDEX, "uicallbacks");

    //
    if (!image_init(L)) return 1;
    draw_init(L);
    fs_init(L);
    sub_init(L);
    lcurl_register(L);

    //
    lua_pushcclosure(L, GetTime, 0);
    lua_setglobal(L, "GetTime");

    lua_pushcclosure(L, RequestFrames, 0);
    lua_setglobal(L, "RequestFrames");
    lua_pushcclosure(L, OnCalculationPending, 0);
    lua_setglobal(L, "OnCalculationPending");

    lua_pushcclosure(L, GetCursorPos, 0);
    lua_setglobal(L, "GetCursorPos");

    lua_pushcclosure(L, IsKeyDown, 0);
    lua_setglobal(L, "IsKeyDown");

    lua_pushcclosure(L, Copy, 0);
    lua_setglobal(L, "Copy");

    lua_pushcclosure(L, Paste, 0);
    lua_setglobal(L, "Paste");

    lua_pushcclosure(L, driver_deflate, 0);
    lua_setglobal(L, "Deflate");

    lua_pushcclosure(L, driver_inflate, 0);
    lua_setglobal(L, "Inflate");

    lua_pushcclosure(L, SetWindowTitle, 0);
    lua_setglobal(L, "SetWindowTitle");

    lua_pushcclosure(L, OpenURL, 0);
    lua_setglobal(L, "OpenURL");

    // pob-web specific
    lua_pushcclosure(L, DownloadPage, 0);
    lua_setglobal(L, "DownloadPage");

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int start() {
    lua_State *L = GL;

    st_start_time = emscripten_get_now();

    if (luaL_dostring(L, boot_lua) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        OnError(L);
        lua_pop(L, 1);
        return 1;
    }

    int extra = push_callback(L, "OnInit");
    if (extra < 0) return 1;
    if (lua_pcall(L, extra, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        OnError(L);
        lua_pop(L, 1);
        return 1;
    }

    extra = push_callback(L, "OnFrame");
    if (extra < 0) return 1;
    if (lua_pcall(L, extra, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        OnError(L);
        lua_pop(L, 1);
        return 1;
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int helper_boot() {
    st_start_time = emscripten_get_now();
    if (luaL_dostring(GL, helper_boot_lua) != LUA_OK) {
        fprintf(stderr, "Helper boot: %s\n", lua_tostring(GL, -1));
        lua_pop(GL, 1); return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
const char *helper_call(const char *input) {
    free(helper_result); helper_result = NULL;
    lua_getglobal(GL, "helperCall"); lua_pushstring(GL, input);
    if (lua_pcall(GL, 1, 1, 0) != LUA_OK) {
        fprintf(stderr, "Helper call: %s\n", lua_tostring(GL, -1));
        lua_pop(GL, 1); return NULL;
    }
    const char *text = lua_tostring(GL, -1);
    if (text) helper_result = strdup(text);
    lua_pop(GL, 1); return helper_result;
}

EMSCRIPTEN_KEEPALIVE
int on_frame() {
    lua_State *L = GL;

    draw_begin();

    if (push_callback(L, "OnFrame") < 0) {
        draw_end();
        return 1;
    }
    if (lua_pcall(L, 1, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        draw_end();
        return 1;
    }

    void *buffer;
    size_t size;
    draw_get_buffer(&buffer, &size);
    EM_ASM({
               Module.drawCommit($0, $1);
           }, buffer, size);

    draw_end();


    return 0;
}

__attribute__((noinline)) static void sentry_test_trap() {
    __builtin_trap();
}

EMSCRIPTEN_KEEPALIVE
void sentry_test_crash() {
    sentry_test_trap();
}

EMSCRIPTEN_KEEPALIVE
int on_key_down(const char *name, int double_click) {
    lua_State *L = GL;
    if (push_callback(L, "OnKeyDown") < 0) {
        return 1;
    }
    lua_pushstring(L, name);
    lua_pushboolean(L, double_click);
    if (lua_pcall(L, 3, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int on_key_up(const char *name, int double_click) {
    lua_State *L = GL;
    if (push_callback(L, "OnKeyUp") < 0) {
        return 1;
    }
    lua_pushstring(L, name);
    if (double_click >= 0) {
        lua_pushboolean(L, double_click);
        if (lua_pcall(L, 3, 0, 0) != LUA_OK) {
            fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
            return 1;
        }
    } else {
        if (lua_pcall(L, 2, 0, 0) != LUA_OK) {
            fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
            return 1;
        }
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int on_char(const char *name, int double_click) {
    lua_State *L = GL;
    if (push_callback(L, "OnChar") < 0) {
        return 1;
    }
    lua_pushstring(L, name);
    lua_pushboolean(L, double_click);
    if (lua_pcall(L, 3, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int on_download_page_result(const char *json) {
    lua_State *L = GL;
    lua_getglobal(L, "OnDownloadPageResult");
    lua_pushstring(L, json);
    if (lua_pcall(L, 1, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int on_subscript_finished(int id, const uint8_t *data) {
    lua_State *L = GL;

    int extra = push_callback(L, "OnSubFinished");
    if (extra >= 0) {
        lua_pushlightuserdata(L, (void *)id);
        int count = sub_lua_deserialize(L, data);
        if (lua_pcall(L, extra + 1 + count, 0, 0) != LUA_OK) {
            const char *msg = lua_tostring(L, -1);
            fprintf(stderr, "on_subscript_finished error: %s\n", msg);
            return 1;
        }
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int on_subscript_error(int id, const char *message) {
    lua_State *L = GL;

    int extra = push_callback(L, "OnSubError");
    if (extra >= 0) {
        lua_pushlightuserdata(L, (void *)id);
        lua_pushstring(L, message);
        if (lua_pcall(L, extra + 2, 0, 0) != LUA_OK) {
            const char *msg = lua_tostring(L, -1);
            fprintf(stderr, "on_subscript_error error: %s\n", msg);
            return 1;
        }
        return 0;
    }
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int load_build_from_code(const char *code) {
    lua_State *L = GL;
    lua_getglobal(L, "loadBuildFromCode");
    lua_pushstring(L, code);
    if (lua_pcall(L, 1, 0, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        return 1;
    }
    return 0;
}

static char *s_build_code = NULL;
static char *s_runtime_profile = NULL;

EMSCRIPTEN_KEEPALIVE
int flush_calculations(void) {
    if (!GL) return 0;
    lua_getglobal(GL, "flushCalculations");
    if (!lua_isfunction(GL, -1)) { lua_pop(GL, 1); return 0; }
    if (lua_pcall(GL, 0, 0, 0) != LUA_OK) {
        OnError(GL); lua_pop(GL, 1); return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int configure_calculation_scheduling(int enabled) {
    if (!GL) return 1;
    lua_getglobal(GL, "configureCalculationScheduling");
    lua_pushboolean(GL, enabled);
    if (lua_pcall(GL, 1, 0, 0) != LUA_OK) {
        OnError(GL); lua_pop(GL, 1); return 1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
const char *get_runtime_profile(int reset) {
    free(s_runtime_profile);
    s_runtime_profile = NULL;
    if (!GL) return NULL;
    lua_getglobal(GL, "getRuntimeProfile");
    lua_pushboolean(GL, reset);
    if (lua_pcall(GL, 1, 1, 0) != LUA_OK) { lua_pop(GL, 1); return NULL; }
    const char *text = lua_tostring(GL, -1);
    if (text) s_runtime_profile = strdup(text);
    lua_pop(GL, 1);
    return s_runtime_profile;
}

EMSCRIPTEN_KEEPALIVE
void destroy_runtime(void) {
    free(helper_result); helper_result = NULL;
    draw_destroy();
    image_destroy();
    if (GL) { lua_close(GL); GL = NULL; }
    free(s_build_code); s_build_code = NULL;
    free(s_runtime_profile); s_runtime_profile = NULL;
}

EMSCRIPTEN_KEEPALIVE
const char* get_build_code() {
    lua_State *L = GL;

    free(s_build_code);
    s_build_code = NULL;

    lua_getglobal(L, "getBuildCode");
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        fprintf(stderr, "Error: %s\n", lua_tostring(L, -1));
        lua_pop(L, 1);
        return NULL;
    }

    size_t len;
    const char *code = lua_tolstring(L, -1, &len);
    s_build_code = malloc(len + 1);
    memcpy(s_build_code, code, len + 1);
    lua_pop(L, 1);
    return s_build_code;
}

EMSCRIPTEN_KEEPALIVE
int request_mobile_action(const char *action) {
    if (!GL) return 1;
    lua_getglobal(GL, "requestMobileAction");
    lua_pushstring(GL, action);
    if (lua_pcall(GL, 1, 0, 0) != LUA_OK) { OnError(GL); lua_pop(GL, 1); return 1; }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
const char *get_mobile_action_state(void) {
    static char *state;
    free(state); state = NULL;
    if (!GL) return "{}";
    lua_getglobal(GL, "getMobilePolicyProfile");
    if (lua_pcall(GL, 0, 1, 0) != LUA_OK) { lua_pop(GL, 1); return "{}"; }
    const char *text=lua_tostring(GL,-1);
    if (text) state=strdup(text);
    lua_pop(GL,1); return state ? state : "{}";
}
