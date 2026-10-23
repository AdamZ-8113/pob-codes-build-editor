#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <math.h>
#include <emscripten.h>
#include "draw.h"
#include "byte_buffer.h"
#include "draw_color.h"
#include "dpi.h"
#include "lauxlib.h"
#include "image.h"
#include "text_width_cache.h"

static int st_layer = 0;
static int st_sublayer = 0;

static DrawColor st_color = {1.0f, 1.0f, 1.0f, 1.0f};

typedef enum {
    DRAW_SET_CLEAR_COLOR = 1,
    DRAW_SET_LAYER = 2,
    DRAW_SET_VIEWPORT = 3,
    DRAW_SET_COLOR = 4,
    DRAW_SET_COLOR_ESCAPE = 5,
    DRAW_IMAGE = 6,
    DRAW_IMAGE_QUAD = 7,
    DRAW_STRING = 8,
} DrawCommandType;

#pragma pack(push, 1)

typedef struct {
    uint8_t type;
    int16_t layer;
    int16_t sublayer;
} SetLayerCommand;

typedef struct {
    uint8_t type;
    int x, y, w, h;
} SetViewportCommand;

typedef struct {
    uint8_t type;
    uint8_t r, g, b, a;
} SetColorCommand;

static SetColorCommand st_color_command = {DRAW_SET_COLOR, 255, 255, 255, 255};

typedef struct {
    uint8_t type;
    int image_handle;
    float x, y, w, h;
    float s1, t1, s2, t2;
    int stackLayer;
    int maskLayer;
} DrawImageCommand;

typedef struct {
    uint8_t type;
    int image_handle;
    float x1, y1, x2, y2, x3, y3, x4, y4;
    float s1, t1, s2, t2, s3, t3, s4, t4;
    int stackLayer;
    int maskLayer;
} DrawImageQuadCommand;

typedef struct {
    uint8_t type;
    float x, y;
    uint8_t align;
    uint32_t height;
    uint8_t font;
    uint16_t text_size;
    char text[];
} DrawStringCommand;

#pragma pack(pop)

static ByteBuffer st_buffer = {0};
static size_t st_text_width_bridge_calls;

// One retained world-space drawing, owned by Lua. Keep original double
// coordinates: translating already-rounded floats causes visible pan jitter.
// Only translation is supported; viewport changes are deliberately rejected.
typedef struct {
    size_t offset;
    double xy[8];
} CachedPosition;

typedef struct {
    ByteBuffer commands, positions;
    DrawColor initial_color, final_color;
    SetColorCommand initial_color_command, final_color_command;
    int initial_layer, initial_sublayer, final_layer, final_sublayer;
    double scale;
    unsigned images;
    int valid;
} DrawCache;

static const char *DRAW_CACHE_TYPE = "TranslatedDrawCache";
static DrawCache *st_capture;
static size_t st_cache_captures, st_cache_replays, st_cache_misses, st_cache_bytes;
#define DRAW_CACHE_LIMIT (4 * 1024 * 1024)

static void cache_release(DrawCache *cache) {
    st_cache_bytes -= cache->commands.capacity + cache->positions.capacity;
    byte_buffer_free(&cache->commands);
    byte_buffer_free(&cache->positions);
    cache->valid = 0;
}

static void cache_append(ByteBuffer *buffer, const void *data, size_t size) {
    if (!st_capture || !st_capture->valid) return;
    if (size > DRAW_CACHE_LIMIT - st_capture->commands.size - st_capture->positions.size) {
        st_capture->valid = 0;
        return;
    }
    size_t previous = buffer->capacity;
    if (!byte_buffer_append(buffer, data, size)) st_capture->valid = 0;
    st_cache_bytes += buffer->capacity - previous;
}

static void cache_position(lua_State *L, int first, int count) {
    if (!st_capture || !st_capture->valid) return;
    CachedPosition position = { .offset = st_capture->commands.size };
    for (int i = 0; i < count; i++) position.xy[i] = lua_tonumber(L, first + i);
    cache_append(&st_capture->positions, &position, sizeof(position));
}

/* Fonts are loaded before draw_init. A host that replaces fonts or its text
 * measurement implementation during a session must invalidate cached widths. */
EMSCRIPTEN_KEEPALIVE
void invalidate_text_width_cache(void) {
    text_width_cache_reset(text_width_cache_profile().enabled);
    st_text_width_bridge_calls = 0;
}

EMSCRIPTEN_KEEPALIVE
const char *get_draw_profile(void) {
    static char result[896];
    TextWidthCacheProfile cache = text_width_cache_profile();
    snprintf(result, sizeof(result), "{\"bytes\":%zu,\"capacity\":%zu,\"reallocations\":%zu,"
             "\"textWidth\":{\"enabled\":%s,\"calls\":%zu,\"hits\":%zu,\"misses\":%zu,"
             "\"bypasses\":%zu,\"bridgeCalls\":%zu,\"evictions\":%zu,\"entries\":%zu,"
             "\"textBytes\":%zu,\"allocatedBytes\":%zu},"
             "\"drawCache\":{\"captures\":%zu,\"replays\":%zu,\"misses\":%zu,\"allocatedBytes\":%zu}}",
             st_buffer.size, st_buffer.capacity, st_buffer.reallocations,
             cache.enabled ? "true" : "false", cache.calls, cache.hits, cache.misses,
             cache.bypasses, st_text_width_bridge_calls, cache.evictions, cache.entries,
             cache.text_bytes, cache.allocated_bytes,
             st_cache_captures, st_cache_replays, st_cache_misses, st_cache_bytes);
    return result;
}
static lua_State *st_state;
static int st_in_frame;
static double st_system_scale;

double draw_system_scale(void) {
    return st_in_frame ? st_system_scale : EM_ASM_DOUBLE({ return Module.getScreenScale(); });
}

#define get_system_scale draw_system_scale

static double get_screen_scale(void) {
    return dpi_get_scale(get_system_scale());
}

static void draw_push(const void *data, size_t size) {
    if (!byte_buffer_append(&st_buffer, data, size)) luaL_error(st_state, "Draw buffer allocation failed");
    if (st_capture) cache_append(&st_capture->commands, data, size);
}

static int ReleaseDrawCache(lua_State *L) {
    DrawCache *cache = luaL_checkudata(L, 1, DRAW_CACHE_TYPE);
    if (cache == st_capture) return luaL_error(L, "Cannot release an active drawing cache");
    cache_release(cache);
    return 0;
}

static int CaptureDrawCache(lua_State *L) {
    luaL_checktype(L, 1, LUA_TFUNCTION);
    if (st_capture || !st_in_frame) return luaL_error(L, "Drawing cache capture requires an unnested frame");
    DrawCache *cache = lua_newuserdata(L, sizeof(*cache));
    memset(cache, 0, sizeof(*cache));
    luaL_setmetatable(L, DRAW_CACHE_TYPE);
    cache->initial_color = st_color;
    cache->initial_color_command = st_color_command;
    cache->initial_layer = st_layer;
    cache->initial_sublayer = st_sublayer;
    cache->scale = get_screen_scale();
    cache->images = image_generation();
    cache->valid = 1;
    lua_pushvalue(L, 1);
    st_capture = cache;
    int status = lua_pcall(L, 0, 0, 0);
    st_capture = NULL;
    if (status != LUA_OK) {
        cache_release(cache);
        return lua_error(L);
    }
    cache->final_color = st_color;
    cache->final_color_command = st_color_command;
    cache->final_layer = st_layer;
    cache->final_sublayer = st_sublayer;
    // Loading new textures during capture needs a fresh pass after loading.
    if (!cache->valid || cache->images != image_generation()) {
        cache_release(cache);
        lua_pop(L, 1);
        lua_pushnil(L);
    } else {
        st_cache_captures++;
    }
    return 1;
}

static float cache_coordinate(double value, double delta, int narrow) {
    value += delta;
    return dpi_scale_coordinate(narrow ? (double)(float)value : value, get_system_scale());
}

static int cache_visible(float min_x, float min_y, float max_x, float max_y, int width, int height) {
    // A small physical-pixel guard also covers filtering and float rounding.
    return !(max_x < -2 || max_y < -2 || min_x > width + 2 || min_y > height + 2);
}

static int ReplayDrawCache(lua_State *L) {
    DrawCache *cache = luaL_checkudata(L, 1, DRAW_CACHE_TYPE);
    double dx = luaL_checknumber(L, 2), dy = luaL_checknumber(L, 3);
    if (!cache->valid || st_capture || !st_in_frame || !isfinite(dx) || !isfinite(dy) ||
        cache->scale != get_screen_scale() || cache->images != image_generation() ||
        cache->initial_layer != st_layer || cache->initial_sublayer != st_sublayer ||
        memcmp(&cache->initial_color, &st_color, sizeof(st_color)) ||
        memcmp(&cache->initial_color_command, &st_color_command, sizeof(st_color_command))) {
        st_cache_misses++;
        lua_pushboolean(L, 0);
        return 1;
    }
    int width = EM_ASM_INT({ return Module.getScreenWidth(); });
    int height = EM_ASM_INT({ return Module.getScreenHeight(); });
    size_t offset = 0, position_index = 0;
    const CachedPosition *positions = (const CachedPosition *)cache->positions.data;
    while (offset < cache->commands.size) {
        const uint8_t *data = cache->commands.data + offset;
        size_t size = 0;
        switch (*data) {
        case DRAW_SET_LAYER: size = sizeof(SetLayerCommand); break;
        case DRAW_SET_COLOR: size = sizeof(SetColorCommand); break;
        case DRAW_IMAGE: {
            DrawImageCommand cmd;
            memcpy(&cmd, data, sizeof(cmd));
            const CachedPosition *position = &positions[position_index++];
            assert(position->offset == offset);
            cmd.x = cache_coordinate(position->xy[0], dx, 1);
            cmd.y = cache_coordinate(position->xy[1], dy, 1);
            if (cmd.maskLayer >= 0 || cache_visible(fminf(cmd.x, cmd.x + cmd.w), fminf(cmd.y, cmd.y + cmd.h),
                    fmaxf(cmd.x, cmd.x + cmd.w), fmaxf(cmd.y, cmd.y + cmd.h), width, height)) draw_push(&cmd, sizeof(cmd));
            offset += sizeof(cmd);
            continue;
        }
        case DRAW_IMAGE_QUAD: {
            DrawImageQuadCommand cmd;
            memcpy(&cmd, data, sizeof(cmd));
            const CachedPosition *position = &positions[position_index++];
            assert(position->offset == offset);
            float xy[8];
            for (int i = 0; i < 8; i++) xy[i] = cache_coordinate(position->xy[i], i % 2 ? dy : dx, 1);
            memcpy(&cmd.x1, xy, sizeof(xy));
            float min_x = xy[0], max_x = xy[0], min_y = xy[1], max_y = xy[1];
            for (int i = 2; i < 8; i += 2) {
                min_x = fminf(min_x, xy[i]); max_x = fmaxf(max_x, xy[i]);
                min_y = fminf(min_y, xy[i+1]); max_y = fmaxf(max_y, xy[i+1]);
            }
            if (cmd.maskLayer >= 0 || cache_visible(min_x, min_y, max_x, max_y, width, height)) draw_push(&cmd, sizeof(cmd));
            offset += sizeof(cmd);
            continue;
        }
        case DRAW_STRING: {
            DrawStringCommand cmd;
            memcpy(&cmd, data, sizeof(cmd));
            const CachedPosition *position = &positions[position_index++];
            assert(position->offset == offset);
            cmd.x = cache_coordinate(position->xy[0], dx, 0);
            cmd.y = cache_coordinate(position->xy[1], dy, 0);
            draw_push(&cmd, sizeof(cmd));
            draw_push(data + sizeof(cmd), cmd.text_size);
            offset += sizeof(cmd) + cmd.text_size;
            continue;
        }
        default: assert(0); // Capture rejects viewport-dependent commands.
        }
        draw_push(data, size);
        offset += size;
    }
    st_color = cache->final_color;
    st_color_command = cache->final_color_command;
    st_layer = cache->final_layer;
    st_sublayer = cache->final_sublayer;
    st_cache_replays++;
    lua_pushboolean(L, 1);
    return 1;
}

void draw_begin() {
    st_buffer.size = 0;
    st_system_scale = EM_ASM_DOUBLE({ return Module.getScreenScale(); });
    st_in_frame = 1;
    st_layer = 0;
    st_sublayer = 0;
    
}

void draw_get_buffer(void **data, size_t *size) {
    *data = st_buffer.data;
    *size = st_buffer.size;
}

void draw_end() {
    st_in_frame = 0;
}

void draw_destroy(void) {
    st_in_frame = 0;
    byte_buffer_free(&st_buffer);
    text_width_cache_reset(false);
    st_text_width_bridge_calls = 0;
}

static int GetScreenSize(lua_State *L) {
    int width = EM_ASM_INT({
        return Module.getScreenWidth();
    });
    int height = EM_ASM_INT({
        return Module.getScreenHeight();
    });
    double scale = dpi_is_aware() ? 1.0 : get_system_scale();
    lua_pushinteger(L, width / scale);
    lua_pushinteger(L, height / scale);
    return 2;
}

static int RenderInit(lua_State *L) {
    dpi_render_init(luaL_optstring(L, 1, NULL));
    return 0;
}

static int GetScreenScale(lua_State *L) {
    lua_pushnumber(L, get_screen_scale());
    return 1;
}

static int SetDPIScaleOverridePercent(lua_State *L) {
    dpi_set_override_percent(luaL_checkinteger(L, 1));
    return 0;
}

static int GetDPIScaleOverridePercent(lua_State *L) {
    lua_pushinteger(L, dpi_get_override_percent());
    return 1;
}

static int SetDrawLayer(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    if (n >= 2) {
        assert(lua_isnumber(L, 2));
    }

    int layer = st_layer;
    int sublayer;
    if (lua_isnil(L, 1)) {
        assert(n >= 2);
        sublayer = lua_tointeger(L, 2);
    } else if (n >= 2) {
        layer = lua_tointeger(L, 1);
        sublayer = lua_tointeger(L, 2);
    } else {
        layer = lua_tointeger(L, 1);
        sublayer = 0;
    }

    if (layer < -32768 || layer >= 32768) {
        return luaL_error(L, "invalid layer %d", layer);
    }
    if (sublayer < -32768 || sublayer >= 32768) {
        return luaL_error(L, "invalid sublayer %d", sublayer);
    }

    st_layer = layer;
    st_sublayer = sublayer;

    SetLayerCommand cmd = {DRAW_SET_LAYER, layer, sublayer };
    draw_push(&cmd, sizeof(cmd));

    return 0;
}

static int SetViewport(lua_State *L) {
    if (st_capture) st_capture->valid = 0;
    int n = lua_gettop(L);
    if (n > 0) {
        assert(n >= 4);
        assert(lua_isnumber(L, 1));
        assert(lua_isnumber(L, 2));
        assert(lua_isnumber(L, 3));
        assert(lua_isnumber(L, 4));

        double scale = get_system_scale();
        SetViewportCommand cmd = {DRAW_SET_VIEWPORT,
                                  dpi_round_coordinate(lua_tonumber(L, 1), scale),
                                  dpi_round_coordinate(lua_tonumber(L, 2), scale),
                                  dpi_ceil_extent(lua_tonumber(L, 3), scale),
                                  dpi_ceil_extent(lua_tonumber(L, 4), scale)};
        draw_push(&cmd, sizeof(cmd));
    } else {
        SetViewportCommand cmd = {DRAW_SET_VIEWPORT, 0, 0, 0, 0};
        draw_push(&cmd, sizeof(cmd));
    }

    return 0;
}

static void draw_set_color(float r, float g, float b, float a) {
    st_color = (DrawColor){r, g, b, a};
    
    SetColorCommand cmd = {DRAW_SET_COLOR, (uint8_t )(r * 255), (uint8_t)(g * 255), (uint8_t)(b * 255), (uint8_t)(a * 255)};
    st_color_command = cmd;
    draw_push(&cmd, sizeof(cmd));
}

static int draw_set_color_escape(lua_State *L, const char *text) {
    if (!draw_color_read_escape(text, &st_color)) {
        return luaL_error(L, "SetDrawColor() argument 1: invalid color escape sequence");
    }
    // Escape colors were already parsed for GetDrawColor(). Send their exact
    // rendered bytes rather than allocating a string for JS to parse again.
    // Round only this path: ^8 renders as #b3b3b3, whereas numeric colors retain
    // their existing truncation. Keep st_color's Lua-visible floats unchanged.
    SetColorCommand cmd = {DRAW_SET_COLOR,
        (uint8_t)lroundf(st_color.r * 255), (uint8_t)lroundf(st_color.g * 255),
        (uint8_t)lroundf(st_color.b * 255), (uint8_t)lroundf(st_color.a * 255)};
    st_color_command = cmd;
    draw_push(&cmd, sizeof(cmd));
    return 0;
}

static int GetDrawColor(lua_State *L) {
    lua_pushnumber(L, st_color.r);
    lua_pushnumber(L, st_color.g);
    lua_pushnumber(L, st_color.b);
    lua_pushnumber(L, st_color.a);
    return 4;
}

static int SetDrawColor(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 1);
    if (lua_type(L, 1) == LUA_TSTRING) {
        return draw_set_color_escape(L, lua_tostring(L, 1));
    } else {
        assert(n >= 3);

        float alpha = 1.0f;
        if (n >= 4 && !lua_isnil(L, 4)) {
            alpha = lua_tonumber(L, 4);
        }
        draw_set_color(lua_tonumber(L, 1), lua_tonumber(L, 2), lua_tonumber(L, 3), alpha);
    }
    return 0;
}

static void draw_image(int image_handle, float x, float y, float w, float h, float s1, float t1, float s2, float t2, int stack_layer, int mask_layer) {
    DrawImageCommand cmd = {DRAW_IMAGE, image_handle, x, y, w, h, s1, t1, s2, t2, stack_layer, mask_layer};
    draw_push(&cmd, sizeof(cmd));
}

static int DrawImage(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 5);

    // | n  |img| corners | uvs | stack | mask |
    // | 5  | X | X       |	    |       |      |
    // | 6  | X | X       |     | X     |      |
    // | 7  | X | X       |     | X     | X    |
    // | 9  | X | X       | X   |       |      |
    // | 10 | X | X       | X   | X     |      |
    // | 11 | X | X       | X   | X     | X    |

    enum ArgFlag : uint8_t { AF_IMG = 0x1, AF_XY = 0x2, AF_UV = 0x4, AF_STACK = 0x8, AF_MASK = 0x10 };
    enum ArgFlag af = (enum ArgFlag)0;
    switch (n) {
        case 11: af = (enum ArgFlag)(af | AF_MASK);
        case 10: af = (enum ArgFlag)(af | AF_STACK);
        case 9: af = (enum ArgFlag)(af | AF_IMG | AF_XY | AF_UV); break;
        case 7: af = (enum ArgFlag)(af | AF_MASK);
        case 6: af = (enum ArgFlag)(af | AF_STACK);
        case 5: af = (enum ArgFlag)(af | AF_IMG | AF_XY); break;
        default: assert(0);
    }

    int k = 1;

    int handle = 0;
    if (af & AF_IMG) {
        if (!lua_isnil(L, k)) {
            ImageHandle *image_handle = lua_touserdata(L, 1);
            handle = image_handle->handle;
        }
        k += 1;
    }

    float xys[2][2] = { { 0, 0 }, { 0, 0 } };
    if (af & AF_XY) {
        for (int i = k; i < k + 4; i++) {
            const int idx = i - k;
            xys[idx/2][idx%2] = (float)lua_tonumber(L, i);
        }
        k += 4;
    }

    float uvs[2][2] = { { 0, 0 }, { 1, 1 } };
    if (af & AF_UV) {
        for (int i = k; i < k + 4; i++) {
            int idx = i - k;
            uvs[idx/2][idx%2] = (float)lua_tonumber(L, i);
        }
        k += 4;
    }

    int stackLayer = 0;
    if (af & AF_STACK) {
        const int val = (int)lua_tointeger(L, k);
        stackLayer = val - 1;
        k += 1;
    }

    int maskLayer = -1;
    if (af & AF_MASK) {
        if (lua_isnumber(L, k)) {
            const int val = (int)lua_tointeger(L, k);
            maskLayer = val - 1;
        }
        k += 1;
    }

    double scale = get_system_scale();
    if (st_capture && handle < 0) st_capture->valid = 0;
    cache_position(L, 2, 2);
    draw_image(handle,
               dpi_scale_coordinate(xys[0][0], scale), dpi_scale_coordinate(xys[0][1], scale),
               dpi_scale_coordinate(xys[1][0], scale), dpi_scale_coordinate(xys[1][1], scale),
               uvs[0][0], uvs[0][1], uvs[1][0], uvs[1][1], stackLayer, maskLayer);

    return 0;
}

static void draw_image_quad(int image_handle, float x1, float y1, float x2, float y2, float x3, float y3, float x4, float y4,
                            float s1, float t1, float s2, float t2, float s3, float t3, float s4, float t4, int stack_layer, int mask_layer) {
    DrawImageQuadCommand cmd = {DRAW_IMAGE_QUAD, image_handle, x1, y1, x2, y2, x3, y3, x4, y4, s1, t1, s2, t2, s3, t3, s4, t4, stack_layer, mask_layer};
    draw_push(&cmd, sizeof(cmd));
}

static int DrawImageQuad(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 9);

    // | n  |img| corners | uvs | stack | mask |
    // | 9  | X | X       |	    |       |      |
    // | 10 | X | X       |     | X     |      |
    // | 11 | X | X       |     | X     | X    |
    // | 17 | X | X       | X   |       |      |
    // | 18 | X | X       | X   | X     |      |
    // | 19 | X | X       | X   | X     | X    |

    enum ArgFlag : uint8_t { AF_IMG = 0x1, AF_XY = 0x2, AF_UV = 0x4, AF_STACK = 0x8, AF_MASK = 0x10 };
    enum ArgFlag af = (enum ArgFlag)0;
    switch (n) {
        case 19: af = (enum ArgFlag)(af | AF_MASK);
        case 18: af = (enum ArgFlag)(af | AF_STACK);
        case 17: af = (enum ArgFlag)(af | AF_IMG | AF_XY | AF_UV); break;
        case 11: af = (enum ArgFlag)(af | AF_MASK);
        case 10: af = (enum ArgFlag)(af | AF_STACK);
        case 9: af = (enum ArgFlag)(af | AF_IMG | AF_XY); break;
        default: assert(0);
    }

    int k = 1;

    int handle = 0;
    if (af & AF_IMG) {
        if (!lua_isnil(L, k)) {
            ImageHandle *image_handle = lua_touserdata(L, 1);
            handle = image_handle->handle;
        }
        k += 1;
    }

    float xys[4][2] = { { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 } };
    if (af & AF_XY) {
        for (int i = k; i < k + 8; i++) {
            const int idx = i - k;
            xys[idx/2][idx%2] = (float)lua_tonumber(L, i);
        }
        k += 8;
    }

    float uvs[4][2] = { { 0, 0 }, { 1, 0 }, { 1, 1 }, { 0, 1 } };
    if (af & AF_UV) {
        for (int i = k; i < k + 8; i++) {
            int idx = i - k;
            uvs[idx/2][idx%2] = (float)lua_tonumber(L, i);
        }
        k += 8;
    }

    int stackLayer = 0;
    if (af & AF_STACK) {
        const int val = (int)lua_tointeger(L, k);
        stackLayer = val - 1;
        k += 1;
    }

    int maskLayer = -1;
    if (af & AF_MASK) {
        if (lua_isnumber(L, k)) {
            const int val = (int)lua_tointeger(L, k);
            maskLayer = val - 1;
        }
        k += 1;
    }

    double scale = get_system_scale();
    if (st_capture && handle < 0) st_capture->valid = 0;
    cache_position(L, 2, 8);
    draw_image_quad(handle,
                    dpi_scale_coordinate(xys[0][0], scale), dpi_scale_coordinate(xys[0][1], scale),
                    dpi_scale_coordinate(xys[1][0], scale), dpi_scale_coordinate(xys[1][1], scale),
                    dpi_scale_coordinate(xys[2][0], scale), dpi_scale_coordinate(xys[2][1], scale),
                    dpi_scale_coordinate(xys[3][0], scale), dpi_scale_coordinate(xys[3][1], scale),
                    uvs[0][0], uvs[0][1], uvs[1][0], uvs[1][1], uvs[2][0], uvs[2][1], uvs[3][0], uvs[3][1], stackLayer, maskLayer);

    return 0;
}

static const char *alignMap[6] = { "LEFT", "CENTER", "RIGHT", "CENTER_X", "RIGHT_X", NULL };
static const char *fontMap[8] = { "FIXED", "VAR", "VAR BOLD", "FONTIN SC", "FONTIN SC ITALIC", "FONTIN", "FONTIN ITALIC", NULL };

static int DrawString(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 6);
    assert(lua_isnumber(L, 1));
    assert(lua_isnumber(L, 2));
    assert(lua_isstring(L, 3) || lua_isnil(L, 3));
    assert(lua_isnumber(L, 4));
    assert(lua_isstring(L, 5));
    assert(lua_isstring(L, 6));

    const char *text = lua_tostring(L, 6);
    size_t text_size = strlen(text);
    if (text_size > UINT16_MAX) text_size = UINT16_MAX;
    DrawStringCommand header;
    DrawStringCommand *cmd = &header;
    cmd->type = DRAW_STRING;
    double scale = get_system_scale();
    cmd->x = dpi_scale_coordinate(lua_tonumber(L, 1), scale);
    cmd->y = dpi_scale_coordinate(lua_tonumber(L, 2), scale);
    cmd->align = luaL_checkoption(L, 3, "LEFT", alignMap);
    cmd->height = dpi_scale_font_height(lua_tonumber(L, 4), scale);
    cmd->font = luaL_checkoption(L, 5, "FIXED", fontMap);
    cmd->text_size = text_size;
    cache_position(L, 1, 2);
    draw_push(cmd, sizeof(DrawStringCommand));
    draw_push(text, text_size);

    if (draw_color_read_last_escape(text, text_size, &st_color)) {
        st_color_command = (SetColorCommand){DRAW_SET_COLOR,
            (uint8_t)lroundf(st_color.r * 255), (uint8_t)lroundf(st_color.g * 255),
            (uint8_t)lroundf(st_color.b * 255), (uint8_t)lroundf(st_color.a * 255)};
    }

    return 0;
}

static int DrawStringWidth(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 3);
    assert(lua_isnumber(L, 1));
    assert(lua_isstring(L, 2));
    assert(lua_isstring(L, 3));

    double system_scale = get_system_scale();
    double scale = dpi_get_scale(system_scale);
    int height = dpi_scale_font_height(lua_tonumber(L, 1), system_scale);
    int font = luaL_checkoption(L, 2, "FIXED", fontMap);
    const char *text = lua_tostring(L, 3);

    int width;
    if (!text_width_cache_get(height, font, text, &width)) {
        st_text_width_bridge_calls++;
        width = EM_ASM_INT({
            return Module.getStringWidth($0, $1, UTF8ToString($2));
        }, height, font, text);
        text_width_cache_put(height, font, text, width);
    }

    lua_pushnumber(L, width / scale);
    return 1;
}

static int DrawStringCursorIndex(lua_State *L) {
    int n = lua_gettop(L);
    assert(n >= 5);
    assert(lua_isnumber(L, 1));
    assert(lua_isstring(L, 2));
    assert(lua_isstring(L, 3));
    assert(lua_isnumber(L, 4));
    assert(lua_isnumber(L, 5));

    double system_scale = get_system_scale();
    int size = dpi_scale_font_height(lua_tonumber(L, 1), system_scale);
    int font = luaL_checkoption(L, 2, "FIXED", fontMap);
    const char *text = lua_tostring(L, 3);
    int x = dpi_round_coordinate(lua_tonumber(L, 4), system_scale);
    int y = dpi_round_coordinate(lua_tonumber(L, 5), system_scale);

    int index = EM_ASM_INT({
        return Module.getStringCursorIndex($0, $1, UTF8ToString($2), $3, $4);
    }, size, font, text, x, y);

    lua_pushinteger(L, index);
    return 1;
}

void draw_init(lua_State *L) {
    st_state = L;
    st_capture = NULL;
    st_cache_captures = st_cache_replays = st_cache_misses = 0;
    luaL_newmetatable(L, DRAW_CACHE_TYPE);
    lua_pushcfunction(L, ReleaseDrawCache);
    lua_setfield(L, -2, "__gc");
    lua_pop(L, 1);
    lua_pushcfunction(L, CaptureDrawCache); lua_setglobal(L, "CaptureDrawCache");
    lua_pushcfunction(L, ReplayDrawCache); lua_setglobal(L, "ReplayDrawCache");
    lua_pushcfunction(L, ReleaseDrawCache); lua_setglobal(L, "ReleaseDrawCache");
    text_width_cache_reset(EM_ASM_INT({ return Module.nativeTextWidthCacheEnabled !== false; }));
    st_text_width_bridge_calls = 0;
    lua_pushcclosure(L, RenderInit, 0);
    lua_setglobal(L, "RenderInit");

    lua_pushcclosure(L, GetScreenSize, 0);
    lua_setglobal(L, "GetScreenSize");

    lua_pushcclosure(L, GetScreenScale, 0);
    lua_setglobal(L, "GetScreenScale");

    lua_pushcclosure(L, SetDPIScaleOverridePercent, 0);
    lua_setglobal(L, "SetDPIScaleOverridePercent");

    lua_pushcclosure(L, GetDPIScaleOverridePercent, 0);
    lua_setglobal(L, "GetDPIScaleOverridePercent");

    lua_pushcclosure(L, SetDrawLayer, 0);
    lua_setglobal(L, "SetDrawLayer");

    lua_pushcclosure(L, SetViewport, 0);
    lua_setglobal(L, "SetViewport");

    lua_pushcclosure(L, GetDrawColor, 0);
    lua_setglobal(L, "GetDrawColor");

    lua_pushcclosure(L, SetDrawColor, 0);
    lua_setglobal(L, "SetDrawColor");

    lua_pushcclosure(L, DrawImage, 0);
    lua_setglobal(L, "DrawImage");

    lua_pushcclosure(L, DrawImageQuad, 0);
    lua_setglobal(L, "DrawImageQuad");

    lua_pushcclosure(L, DrawString, 0);
    lua_setglobal(L, "DrawString");

    lua_pushcclosure(L, DrawStringWidth, 0);
    lua_setglobal(L, "DrawStringWidth");

    lua_pushcclosure(L, DrawStringCursorIndex, 0);
    lua_setglobal(L, "DrawStringCursorIndex");
}
