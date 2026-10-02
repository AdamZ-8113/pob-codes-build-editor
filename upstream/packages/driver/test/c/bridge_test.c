#include "byte_buffer.h"
#include "draw_color.h"
#include "draw.h"
#include "dpi.h"
#include "sub_serialization.h"
#include "image.h"
#include "compression.h"
#include "text_width_cache.h"
#include "lauxlib.h"
#include "lualib.h"

#include <emscripten.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "CHECK failed: %s (%s:%d)\n", #condition, __FILE__, __LINE__); \
            exit(EXIT_FAILURE); \
        } \
    } while (0)

static void test_subscript_values_round_trip(void) {
    DataItem input[] = {
        {.type = TYPE_DOUBLE, .value.doubleValue = 123.5},
        {.type = TYPE_BOOLEAN, .value.intValue = 1},
        {.type = TYPE_STRING, .value.stringValue = "result"},
    };
    unsigned char *serialized;
    serialize(input, 3, &serialized);

    int count;
    DataItem *output = deserialize(serialized, &count);
    CHECK(count == 3);
    CHECK(output[0].type == TYPE_DOUBLE);
    CHECK(output[0].value.doubleValue == 123.5);
    CHECK(output[1].type == TYPE_BOOLEAN);
    CHECK(output[1].value.intValue == 1);
    CHECK(output[2].type == TYPE_STRING);
    CHECK(strcmp(output[2].value.stringValue, "result") == 0);

    free_deserialized_data(output, count);
    free(serialized);
}

static void test_large_buffer_append(void) {
    const size_t large_size = 65549;
    unsigned char *large = malloc(large_size);
    memset(large, 0x5a, large_size);
    const unsigned char suffix[] = {1, 2, 3, 4};
    ByteBuffer buffer = {0};

    byte_buffer_append(&buffer, large, large_size);
    byte_buffer_append(&buffer, suffix, sizeof(suffix));

    CHECK(buffer.size == large_size + sizeof(suffix));
    CHECK(buffer.capacity >= buffer.size);
    CHECK(memcmp(buffer.data, large, large_size) == 0);
    CHECK(memcmp(buffer.data + large_size, suffix, sizeof(suffix)) == 0);
    void *retained = buffer.data;
    size_t capacity = buffer.capacity;
    buffer.size = 0;
    CHECK(byte_buffer_append(&buffer, suffix, sizeof(suffix)));
    CHECK(buffer.data == retained && buffer.capacity == capacity);
    CHECK(!byte_buffer_append(&buffer, suffix, SIZE_MAX));
    CHECK(buffer.data == retained && buffer.size == sizeof(suffix));
    byte_buffer_fail_allocation = 1;
    CHECK(!byte_buffer_append(&buffer, suffix, capacity));
    CHECK(buffer.data == retained && buffer.capacity == capacity && buffer.size == sizeof(suffix));
    CHECK(memcmp(buffer.data, suffix, sizeof(suffix)) == 0);
    byte_buffer_fail_allocation = 0;

    byte_buffer_free(&buffer);
    free(large);
}

static void check_color(DrawColor color, float r, float g, float b, float a) {
    CHECK(color.r == r);
    CHECK(color.g == g);
    CHECK(color.b == b);
    CHECK(color.a == a);
}

static void test_draw_color_escapes(void) {
    DrawColor color = {0};
    CHECK(draw_color_read_escape("^1", &color));
    check_color(color, 1.0f, 0.0f, 0.0f, 1.0f);
    CHECK(draw_color_read_escape("^xA1b2C3", &color));
    check_color(color, 161.0f / 255.0f, 178.0f / 255.0f, 195.0f / 255.0f, 1.0f);
    CHECK(draw_color_read_escape("^XA1B2C3", &color));
    CHECK(!draw_color_read_escape("^x12zz56", &color));
    CHECK(!draw_color_read_escape("plain", &color));

    color = (DrawColor){0};
    const char *text = "^1red ^x102030custom ^8gray";
    CHECK(draw_color_read_last_escape(text, strlen(text), &color));
    check_color(color, 0.7f, 0.7f, 0.7f, 1.0f);
    CHECK(!draw_color_read_last_escape("no escapes", 10, &color));
    CHECK(draw_color_read_last_escape("^1red^2", 5, &color));
    check_color(color, 1.0f, 0.0f, 0.0f, 1.0f);
}

static void test_dpi_scaling(void) {
    dpi_set_override_percent(0);
    dpi_render_init(NULL);
    CHECK(!dpi_is_aware());
    CHECK(dpi_get_scale(2.0) == 1.0);

    dpi_render_init("DPI_AWARE");
    CHECK(dpi_is_aware());
    CHECK(dpi_get_scale(2.0) == 2.0);
    CHECK(dpi_scale_coordinate(12.5, 2.0) == 25.0);
    CHECK(dpi_scale_font_height(15, 2.0) == 30);
    CHECK(dpi_scale_font_height(15, 1.5) == 24);
    CHECK(dpi_scale_font_height(15, 1.0) == 16);
    CHECK(dpi_scale_font_height(14, 0.5) == 8);
    CHECK(dpi_scale_font_height(0, 2.0) == 1);
    CHECK(dpi_scale_font_height(15.5, 1.0) == 16);
    CHECK(dpi_round_coordinate(1, 1.5) == 2);
    CHECK(dpi_ceil_extent(1, 1.5) == 2);

    dpi_set_override_percent(250);
    CHECK(dpi_get_override_percent() == 250);
    CHECK(dpi_get_scale(3.0) == 2.5);
    CHECK(dpi_scale_coordinate(10.0, 3.0) == 25.0);

    dpi_set_override_percent(0);
    CHECK(dpi_get_override_percent() == 0);
    CHECK(dpi_get_scale(3.0) == 3.0);
    CHECK(dpi_cursor_coordinate(75.0, 3.0) == 75);
    dpi_set_override_percent(150);
    CHECK(dpi_cursor_coordinate(75.0, 2.0) == 100);
    dpi_set_override_percent(250);
    CHECK(dpi_cursor_coordinate(125.0, 2.0) == 100);
    dpi_set_override_percent(-1);
    CHECK(dpi_get_override_percent() == -1);
    CHECK(dpi_get_scale(3.0) == 3.0);
}

static int test_image_resource_id(lua_State *L) {
    ImageHandle *image = lua_touserdata(L, 1);
    CHECK(image != NULL);
    lua_pushinteger(L, image->handle);
    return 1;
}

static void test_image_resource_reuse(void) {
    // This fixture lives only in the executable's in-memory Emscripten FS.
    FILE *manifest = fopen(".image.tsv", "w");
    CHECK(manifest != NULL);
    fputs("icon-a.png\t32\t48\nicon-b.png\t80\t96\n", manifest);
    fclose(manifest);
    EM_ASM({
        Module.imageCalls = [];
        Module.imageLoad = (id, filename, flags) => Module.imageCalls.push({id, filename, flags});
    });
    lua_State *L = luaL_newstate();
    CHECK(L != NULL);
    luaL_openlibs(L);
    CHECK(image_init(L));
    lua_pushcfunction(L, test_image_resource_id);
    lua_setglobal(L, "resourceId");
    const char *script =
        "local empty = NewImageHandle()\n"
        "assert(resourceId(empty) == -1)\n"
        "local w,h = empty:ImageSize(); assert(w == 1 and h == 1)\n"
        "for i=1,1000 do NewImageHandle() end\n"
        "local a = NewImageHandle(); a:Load('icon-a.png')\n"
        "local original = resourceId(a); assert(original == 1)\n"
        "w,h = a:ImageSize(); assert(w == 32 and h == 48)\n"
        "local b = NewImageHandle(); b:Load('icon-a.png','ASYNC')\n"
        "assert(a ~= b and resourceId(b) == original)\n"
        "local flags = {{'MIPMAP'}, {'MIPMAP','CLAMP'}, {}, {'CLAMP'},\n"
        "  {'MIPMAP','NEAREST'}, {'MIPMAP','NEAREST','CLAMP'}, {'NEAREST'}, {'CLAMP','NEAREST'}}\n"
        "local ids = {}\n"
        "for i, f in ipairs(flags) do\n"
        "  local image = NewImageHandle(); image:Load('icon-a.png', table.unpack(f))\n"
        "  assert(not ids[resourceId(image)]); ids[resourceId(image)] = true\n"
        "end\n"
        "b:Load('icon-a.png','NEAREST','CLAMP','ASYNC','CLAMP')\n"
        "local sharedFlags = resourceId(b)\n"
        "a:Load('icon-a.png','CLAMP','NEAREST'); assert(resourceId(a) == sharedFlags)\n"
        "b:Load('icon-b.png'); assert(not ids[resourceId(b)])\n"
        "local secondSource = resourceId(b)\n"
        "w,h = b:ImageSize(); assert(w == 80 and h == 96)\n"
        "a:Load('icon-b.png'); assert(resourceId(a) == secondSource)\n"
        "w,h = a:ImageSize(); assert(w == 80 and h == 96)\n"
        "a:Load('icon-a.png'); assert(resourceId(a) == original)\n"
        "w,h = a:ImageSize(); assert(w == 32 and h == 48)\n"
        "for i=1,1000 do\n"
        "  local icon = NewImageHandle(); icon:Load('icon-a.png')\n"
        "  assert(resourceId(icon) == original)\n"
        "end\n"
        "collectgarbage('collect')\n"
        "local icon = NewImageHandle(); icon:Load('icon-a.png')\n"
        "assert(resourceId(icon) == original)\n";
    if (luaL_dostring(L, script) != LUA_OK) {
        fprintf(stderr, "Image resource regression: %s\n", lua_tostring(L, -1));
        exit(EXIT_FAILURE);
    }
    // Eight effective flag combinations plus a different filename: repeated
    // allocations/reloads must not grow the native/JS resource identity set.
    CHECK(EM_ASM_INT({ return new Set(Module.imageCalls.map(call => call.id)).size; }) == 9);
    CHECK(EM_ASM_INT({ return Module.imageCalls.length; }) == 9);
    CHECK(EM_ASM_INT({
        return Module.imageCalls.every(call => call.id > 0 &&
            (call.filename === 'icon-a.png' || call.filename === 'icon-b.png') &&
            call.flags >= 0 && call.flags <= 7);
    }));
    lua_close(L);
    image_destroy();
    remove(".image.tsv");
}

static void test_image_index_bounds(void) {
    lua_State *L = luaL_newstate();
    FILE *f = fopen(".image.tsv", "w");
    CHECK(f);
    for (int i = 0; i < 2049; i++) fprintf(f, "image-%d.png\t%d\t48\n", i, i + 1);
    for (int i = 0; i < 1500; i++) fputc('x', f);
    fputs(".png\t30\t40\n", f);
    fclose(f);
    CHECK(image_init(L));
    luaL_openlibs(L);
    CHECK(luaL_dostring(L, "local a=NewImageHandle(); a:Load('image-2048.png'); local w,h=a:ImageSize(); assert(w==2049 and h==48)") == LUA_OK);
    CHECK(luaL_dostring(L, "local a=NewImageHandle(); a:Load(string.rep('x',1500)..'.png'); local w,h=a:ImageSize(); assert(w==30 and h==40)") == LUA_OK);
    const char *bad[] = {"bad\t12\n", "bad\t-1\t2\n", "bad\tx\t2\n", "bad\t1\t2\nbad\t1\t2\n"};
    for (size_t i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) {
        f = fopen(".image.tsv", "w"); fputs(bad[i], f); fclose(f);
        CHECK(!image_init(L));
    }
    image_destroy();
    lua_close(L);
    remove(".image.tsv");
}

static void test_draw_frame_reuse(void) {
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    draw_init(L);
    dpi_render_init("DPI_AWARE");
    dpi_set_override_percent(0);
    EM_ASM({ Module.scale = 2; Module.scaleCalls = 0; Module.getScreenScale = () => { Module.scaleCalls++; return Module.scale; }; });
    void *first; size_t size;
    draw_begin();
    CHECK(luaL_dostring(L, "DrawString(10,20,'LEFT',14,'FIXED','abc'); DrawString(10,20,'LEFT',14,'FIXED','abc')") == LUA_OK);
    draw_get_buffer(&first, &size);
    CHECK(size == 40);
    unsigned char expected[] = {8,0,0,160,65,0,0,32,66,0,28,0,0,0,0,3,0,'a','b','c'};
    CHECK(!memcmp(first, expected, 20) && !memcmp((char *)first + 20, expected, 20));
    CHECK(EM_ASM_INT({ return Module.scaleCalls; }) == 1);
    draw_end();
    EM_ASM({ Module.scale = 1; });
    draw_begin();
    CHECK(luaL_dostring(L, "DrawString(10,20,'LEFT',14,'FIXED','abc')") == LUA_OK);
    void *second; draw_get_buffer(&second, &size);
    CHECK(first == second && size == 20);
    CHECK(EM_ASM_INT({ return Module.scaleCalls; }) == 2);
    float x; memcpy(&x, (char *)second + 1, sizeof(x)); CHECK(x == 10);
    draw_end();
    draw_destroy();
    lua_close(L);
}

static void test_text_width_cache_bounds(void) {
    text_width_cache_reset(true);
    int width;
    // Release Lua argument assertions are disabled. The existing bridge maps
    // a null text pointer to an empty JS string; caching must defer to it.
    width = 777;
    CHECK(!text_width_cache_get(14, 1, NULL, &width) && width == 777);
    text_width_cache_put(14, 1, NULL, 0);
    CHECK(text_width_cache_profile().entries == 0 && text_width_cache_profile().bypasses == 1);
    for (int height = 1; height <= 2; height++) {
        text_width_cache_put(height, 1, "tiny font", 10);
        CHECK(!text_width_cache_get(height, 1, "tiny font", &width));
    }
    CHECK(text_width_cache_profile().entries == 0 && text_width_cache_profile().bypasses == 3);
    char *temporary = malloc(32);
    strcpy(temporary, "owned Lua-independent text");
    text_width_cache_put(14, 1, temporary, 42);
    memset(temporary, 'x', 25);
    free(temporary);
    CHECK(text_width_cache_get(14, 1, "owned Lua-independent text", &width) && width == 42);
    CHECK(!text_width_cache_get(16, 1, "owned Lua-independent text", &width));
    CHECK(!text_width_cache_get(14, 2, "owned Lua-independent text", &width));
    // These strings have identical FNV-1a hashes. Equality must still compare
    // owned bytes rather than treating the hash as a unique string identity.
    text_width_cache_put(14, 1, "costarring", 100);
    text_width_cache_put(14, 1, "liquid", 200);
    CHECK(text_width_cache_get(14, 1, "costarring", &width) && width == 100);
    CHECK(text_width_cache_get(14, 1, "liquid", &width) && width == 200);

    // Numerous independently hashed keys exercise chains and exact equality.
    text_width_cache_reset(true);
    char key[32];
    for (int i = 0; i < TEXT_WIDTH_CACHE_MAX_ENTRIES; i++) {
        snprintf(key, sizeof(key), "entry-%d", i);
        text_width_cache_put(14, 1, key, i);
    }
    for (int i = 0; i < TEXT_WIDTH_CACHE_MAX_ENTRIES; i++) {
        snprintf(key, sizeof(key), "entry-%d", i);
        CHECK(text_width_cache_get(14, 1, key, &width) && width == i);
    }
    CHECK(text_width_cache_get(14, 1, "entry-0", &width));
    text_width_cache_put(14, 1, "overflow", -123);
    CHECK(text_width_cache_get(14, 1, "entry-0", &width) && width == 0);
    CHECK(!text_width_cache_get(14, 1, "entry-1", &width));
    CHECK(text_width_cache_get(14, 1, "overflow", &width) && width == -123);
    TextWidthCacheProfile profile = text_width_cache_profile();
    CHECK(profile.entries == TEXT_WIDTH_CACHE_MAX_ENTRIES && profile.evictions == 1);

    text_width_cache_reset(true);
    temporary = malloc(TEXT_WIDTH_CACHE_MAX_TEXT_BYTES + 1);
    memset(temporary, 'a', TEXT_WIDTH_CACHE_MAX_TEXT_BYTES);
    temporary[300000] = '\0';
    for (int i = 0; i < 4; i++) {
        temporary[0] = 'a' + i;
        text_width_cache_put(14, 1, temporary, i);
        profile = text_width_cache_profile();
        CHECK(profile.text_bytes <= TEXT_WIDTH_CACHE_MAX_TEXT_BYTES);
    }
    CHECK(profile.entries == 3 && profile.evictions == 1);
    CHECK(text_width_cache_get(14, 1, temporary, &width) && width == 3);
    temporary[0] = 'a';
    CHECK(!text_width_cache_get(14, 1, temporary, &width));
    temporary[300000] = 'a';
    temporary[TEXT_WIDTH_CACHE_MAX_TEXT_BYTES] = '\0';
    text_width_cache_put(14, 1, temporary, 99);
    CHECK(text_width_cache_profile().entries == 3);
    CHECK(text_width_cache_profile().bypasses == 1);
    free(temporary);
    text_width_cache_fail_allocation = 1;
    text_width_cache_put(14, 1, "allocation failure", 1);
    text_width_cache_fail_allocation = 0;
    CHECK(!text_width_cache_get(14, 1, "allocation failure", &width));
    CHECK(text_width_cache_profile().bypasses == 2);
    text_width_cache_reset(false);
    profile = text_width_cache_profile();
    CHECK(profile.entries == 0 && profile.text_bytes == 0 && !profile.enabled);
    text_width_cache_put(14, 1, "disabled", 10);
    CHECK(!text_width_cache_get(14, 1, "disabled", &width));
    CHECK(text_width_cache_profile().entries == 0);
}

static void test_draw_string_width_cache(void) {
    EM_ASM({
        Module.nativeTextWidthCacheEnabled = true;
        Module.scale = 2;
        Module.widthCalls = [];
        Module.getScreenScale = () => Module.scale;
        Module.getStringWidth = (height, font, text) => {
            Module.widthCalls.push({height, font, text});
            return text.length * height + font * 100;
        };
    });
    lua_State *L = luaL_newstate();
    CHECK(L != NULL);
    luaL_openlibs(L);
    draw_init(L);
    dpi_render_init("DPI_AWARE");
    dpi_set_override_percent(0);
    draw_begin();
    CHECK(luaL_dostring(L,
        "assert(DrawStringWidth(14,'FIXED','abc') == 42)\n"
        "for i=1,1000 do assert(DrawStringWidth(14,'FIXED','abc') == 42) end\n"
        "assert(not pcall(DrawStringWidth,14,'not a font','abc'))\n") == LUA_OK);
    CHECK(EM_ASM_INT({ return Module.widthCalls.length; }) == 1);
    draw_end();
    EM_ASM({ Module.scale = 1; });
    draw_begin();
    CHECK(luaL_dostring(L,
        "assert(DrawStringWidth(28,'FIXED','abc') == 84)\n"
        "assert(DrawStringWidth(14,'FIXED','abc') == 42)\n"
        "SetDPIScaleOverridePercent(200)\n"
        "assert(DrawStringWidth(14,'FIXED','abc') == 42)\n"
        "RenderInit()\n"
        "assert(DrawStringWidth(14,'FIXED','abc') == 42)\n"
        "RenderInit('DPI_AWARE'); SetDPIScaleOverridePercent(150)\n"
        "assert(DrawStringWidth(14,'FIXED','abc') == 44)\n"
        "SetDPIScaleOverridePercent(0)\n"
        "assert(DrawStringWidth('14','FIXED',123) == DrawStringWidth(14,'FIXED','123'))\n"
        "assert(DrawStringWidth(14,'FIXED','abc\\0ignored') == 42)\n") == LUA_OK);
    CHECK(EM_ASM_INT({ return Module.widthCalls.length; }) == 4);
    draw_end();
    // Compare all fonts and untouched UTF-8/color/multiline strings with the
    // uncached bridge. Store expected results in Lua, then destroy the cache.
    const char *fixture =
        "fonts={'FIXED','VAR','VAR BOLD','FONTIN SC','FONTIN SC ITALIC','FONTIN','FONTIN ITALIC'}\n"
        "strings={'','^1red ^x123456color','two\\nlines','caf\\195\\169 \\240\\159\\152\\128'}\n"
        "widths={}\n"
        "for i,f in ipairs(fonts) do widths[i]={}; for j,s in ipairs(strings) do\n"
        " widths[i][j]=DrawStringWidth(14,f,s)\n"
        " assert(DrawStringWidth(14,f,s)==widths[i][j])\n"
        "end end\n"
        "collectgarbage('collect')\n"
        "for i,f in ipairs(fonts) do for j,s in ipairs(strings) do assert(DrawStringWidth(14,f,s)==widths[i][j]) end end\n";
    draw_begin();
    CHECK(luaL_dostring(L, fixture) == LUA_OK);
    draw_end();
    CHECK(EM_ASM_INT({ return Module.widthCalls.length; }) == 32);
    TextWidthCacheProfile profile = text_width_cache_profile();
    CHECK(profile.entries == 32 && profile.hits >= 1000 && profile.misses == 32);
    CHECK(strstr(get_draw_profile(), "\"bridgeCalls\":32") != NULL);
    CHECK(strstr(get_draw_profile(), "\"enabled\":true") != NULL);
    // Model Canvas retaining a preceding font when a tiny CSS size is invalid.
    // The same key can then return a different authoritative JS width.
    EM_ASM({ Module.tinyWidth = 100; Module.getStringWidth = () => ++Module.tinyWidth; });
    CHECK(luaL_dostring(L,
        "assert(DrawStringWidth(0,'FIXED','tiny')==101)\n"
        "assert(DrawStringWidth(0,'FIXED','tiny')==102)\n"
        "assert(DrawStringWidth(2,'FIXED','tiny')==103)\n"
        "assert(DrawStringWidth(2,'FIXED','tiny')==104)\n") == LUA_OK);
    CHECK(text_width_cache_profile().entries == 32 && text_width_cache_profile().bypasses == 4);
    CHECK(strstr(get_draw_profile(), "\"bridgeCalls\":36") != NULL);
#ifdef NDEBUG
    EM_ASM({
        Module.getStringWidth = (height, font, text) => {
            Module.widthCalls.push({height, font, text});
            return text.length * height + font * 100;
        };
    });
    CHECK(luaL_dostring(L,
        "assert(DrawStringWidth(14,'FIXED',nil)==0)\n"
        "assert(DrawStringWidth(14,'FIXED',{})==0)\n") == LUA_OK);
    CHECK(EM_ASM_INT({ return Module.widthCalls.length; }) == 34);
    CHECK(text_width_cache_profile().entries == 32 && text_width_cache_profile().bypasses == 6);
    CHECK(strstr(get_draw_profile(), "\"bridgeCalls\":38") != NULL);
#endif
    // Runtime font/measurement replacement has an explicit invalidation hook.
    EM_ASM({ Module.getStringWidth = () => 777; Module.widthCalls = []; });
    invalidate_text_width_cache();
    CHECK(text_width_cache_profile().entries == 0 && text_width_cache_profile().enabled);
    CHECK(luaL_dostring(L, "assert(DrawStringWidth(14,'FIXED','abc')==777); assert(DrawStringWidth(14,'FIXED','abc')==777)") == LUA_OK);
    CHECK(text_width_cache_profile().misses == 1 && text_width_cache_profile().hits == 1);
    CHECK(strstr(get_draw_profile(), "\"bridgeCalls\":1") != NULL);
    draw_destroy();
    CHECK(text_width_cache_profile().entries == 0 && text_width_cache_profile().text_bytes == 0);
    EM_ASM({
        Module.nativeTextWidthCacheEnabled = false;
        Module.widthCalls = [];
        Module.getStringWidth = (height, font, text) => {
            Module.widthCalls.push({height, font, text});
            return text.length * height + font * 100;
        };
    });
    draw_init(L);
    draw_begin();
    CHECK(luaL_dostring(L,
        "for i,f in ipairs(fonts) do for j,s in ipairs(strings) do\n"
        " assert(DrawStringWidth(14,f,s)==widths[i][j])\n"
        " assert(DrawStringWidth(14,f,s)==widths[i][j])\n"
        "end end\n") == LUA_OK);
    draw_end();
    CHECK(EM_ASM_INT({ return Module.widthCalls.length; }) == 56);
    profile = text_width_cache_profile();
    CHECK(!profile.enabled && profile.entries == 0 && profile.calls == 56 && profile.bypasses == 56);
    CHECK(strstr(get_draw_profile(), "\"bridgeCalls\":56") != NULL);
    draw_destroy();
    lua_close(L);
}

typedef struct {
    lua_Alloc original;
    void *user;
    size_t minimum_size;
} DeniedLuaAllocation;

static void *deny_lua_allocation(void *opaque, void *ptr, size_t old_size, size_t size) {
    DeniedLuaAllocation *allocator = opaque;
    if (size >= allocator->minimum_size) return NULL;
    return allocator->original(allocator->user, ptr, old_size, size);
}

static void test_compression_errors_and_growth(void) {
    lua_State *L = luaL_newstate();
    luaL_openlibs(L);
    lua_pushcfunction(L, driver_deflate); lua_setglobal(L, "Deflate");
    lua_pushcfunction(L, driver_inflate); lua_setglobal(L, "Inflate");
    CHECK(luaL_dostring(L,
        "payload = string.rep('binary\\0\\255\\128data', 20000)\n"
        "compressed = assert(Deflate(payload))\n"
        "assert(Inflate(compressed) == payload)\n"
        "assert(Inflate(assert(Deflate(''))) == '')\n"
        "for _, input in ipairs({'', 'invalid', compressed:sub(1, #compressed - 2)}) do\n"
        " for i = 1, 4 do local value, why = Inflate(input); assert(value == nil and type(why) == 'string') end\n"
        "end\n") == LUA_OK);
    CHECK(compression_live_buffers == 0);
    compression_fail_after = 0;
    CHECK(luaL_dostring(L,
        "local value, why = Inflate(compressed); assert(value == nil and why:find('memory'))\n"
        "value, why = Deflate(payload); assert(value == nil and why:find('memory'))\n") == LUA_OK);
    CHECK(compression_live_buffers == 0);
    // Initial output allocation succeeds, then its first growth fails.
    compression_fail_after = 1;
    CHECK(luaL_dostring(L,
        "local value, why = Inflate(compressed); assert(value == nil and why:find('memory'))\n") == LUA_OK);
    CHECK(compression_live_buffers == 0);
    compression_fail_after = -1;
    CHECK(luaL_dostring(L, "assert(Inflate(compressed) == payload)") == LUA_OK);
    CHECK(compression_live_buffers == 0);
    CHECK(luaL_dostring(L,
        "collectgarbage('stop'); collected = 0\n"
        "do local probe = setmetatable({}, {__gc = function() collected = collected + 1 end}) end\n"
        "assert(Inflate(compressed) == payload); assert(collected == 0)\n") == LUA_OK);
    size_t threshold = compression_gc_threshold;
    compression_gc_threshold = 1;
    CHECK(luaL_dostring(L,
        "assert(Inflate(compressed) == payload); assert(collected == 1); collectgarbage('restart')\n") == LUA_OK);
    compression_gc_threshold = threshold;
    // Native inflate succeeds, but Lua cannot allocate the resulting string.
    // The protected copy must release its C buffer before propagating the error.
    lua_pushcfunction(L, driver_inflate);
    lua_getglobal(L, "compressed");
    DeniedLuaAllocation allocator;
    allocator.original = lua_getallocf(L, &allocator.user);
    // Refuse the 260k result string, while still allowing Lua to allocate its
    // protected-call/error machinery. Denying that machinery tests Lua itself
    // and can panic before entering the function under test.
    allocator.minimum_size = 200000;
    compression_fail_after = 3; // Initial storage plus two successful growths.
    lua_setallocf(L, deny_lua_allocation, &allocator);
    int status = lua_pcall(L, 1, 1, 0);
    lua_setallocf(L, allocator.original, allocator.user);
    CHECK(status == LUA_ERRMEM || status == LUA_ERRRUN);
    CHECK(strstr(lua_tostring(L, -1), "memory") != NULL);
    CHECK(compression_fail_after == 0);
    compression_fail_after = -1;
    CHECK(compression_live_buffers == 0);
    lua_pop(L, 1);
    lua_close(L);
}

int main(void) {
    test_subscript_values_round_trip();
    test_large_buffer_append();
    test_draw_color_escapes();
    test_dpi_scaling();
    test_image_resource_reuse();
    test_image_index_bounds();
    test_draw_frame_reuse();
    test_text_width_cache_bounds();
    test_draw_string_width_cache();
    test_compression_errors_and_growth();
    return 0;
}
