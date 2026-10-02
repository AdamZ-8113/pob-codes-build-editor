#include "compression.h"
#include "lauxlib.h"
#include <limits.h>
#include <stdint.h>
#include <stdlib.h>
#include <zlib.h>

#define INPUT_LIMIT ((size_t)128 << 20)

#ifdef DRIVER_TESTING
int compression_fail_after = -1;
int compression_live_buffers = 0;
size_t compression_gc_threshold = (size_t)8 << 20;
#else
#define compression_gc_threshold ((size_t)8 << 20)
#endif

static void *resize_buffer(lua_State *L, void *buffer, size_t size) {
#ifdef DRIVER_TESTING
    if (compression_fail_after == 0) return NULL;
    if (compression_fail_after > 0) compression_fail_after--;
#endif
    void *next = realloc(buffer, size);
    if (!next) {
        // C allocations do not contribute to Lua's automatic GC threshold.
        // Large jewel loads can therefore hit the Wasm limit with reclaimable
        // Lua comparison trees still alive. Retry after collecting those trees.
        lua_gc(L, LUA_GCCOLLECT, 0);
        next = realloc(buffer, size);
    }
#ifdef DRIVER_TESTING
    if (next && !buffer) compression_live_buffers++;
#endif
    return next;
}

static void free_buffer(void *buffer) {
#ifdef DRIVER_TESTING
    if (buffer) compression_live_buffers--;
#endif
    free(buffer);
}

static int fail(lua_State *L, const char *message) {
    lua_pushnil(L);
    lua_pushstring(L, message);
    return 2;
}

static int copy_result(lua_State *L) {
    lua_pushlstring(L, lua_touserdata(L, 1), (size_t)lua_tointeger(L, 2));
    return 1;
}

static int finish(lua_State *L, void *output, size_t size) {
    // A Lua string allocation may throw. Keep that throw inside a protected
    // call so even exhausted heaps release the native decompression buffer.
    lua_pushcfunction(L, copy_result);
    lua_pushlightuserdata(L, output);
    lua_pushinteger(L, size);
    int status = lua_pcall(L, 2, 1, 0);
    free_buffer(output);
    if (status != LUA_OK) return lua_error(L);
    return 1;
}

int driver_deflate(lua_State *L) {
    luaL_checkstack(L, 4, "compression result");
    size_t input_size;
    const char *input = luaL_checklstring(L, 1, &input_size);
    if (input_size > INPUT_LIMIT) return fail(L, "Input larger than 128 MiB");
    z_stream stream = {0};
    int status = deflateInit(&stream, Z_BEST_COMPRESSION);
    if (status != Z_OK) return fail(L, "deflateInit failed");
    size_t capacity = deflateBound(&stream, input_size);
    // The previous bridge allocated at most 128 MiB but told zlib it owned
    // the larger deflateBound buffer. Reject the over-limit bound instead.
    if (capacity > INPUT_LIMIT) {
        deflateEnd(&stream);
        return fail(L, "Compressed output bound larger than 128 MiB");
    }
    void *output = resize_buffer(L, NULL, capacity);
    if (!output) {
        deflateEnd(&stream);
        return fail(L, "Not enough memory to compress data");
    }
    stream.next_in = (Bytef *)input;
    stream.avail_in = (uInt)input_size;
    stream.next_out = output;
    stream.avail_out = (uInt)capacity;
    status = deflate(&stream, Z_FINISH);
    size_t size = stream.total_out;
    deflateEnd(&stream);
    if (status != Z_STREAM_END) {
        free_buffer(output);
        return fail(L, zError(status));
    }
    return finish(L, output, size);
}

int driver_inflate(lua_State *L) {
    luaL_checkstack(L, 4, "compression result");
    size_t input_size;
    const char *input = luaL_checklstring(L, 1, &input_size);
    if (input_size > INPUT_LIMIT) return fail(L, "Input larger than 128 MiB");
    // Multipart Timeless archives are tens of MiB. Collect dead part strings
    // and previous comparison trees before adding native zlib output storage,
    // which Lua's automatic collector cannot include in its memory pressure.
    // Ordinary imported build codes stay below this first-use data threshold.
    if (input_size >= compression_gc_threshold) lua_gc(L, LUA_GCCOLLECT, 0);
    z_stream stream = {0};
    int status = inflateInit(&stream);
    if (status != Z_OK) return fail(L, "inflateInit failed");
    size_t capacity = input_size > 16384 ? input_size * 4 : 65536;
    void *output = resize_buffer(L, NULL, capacity);
    if (!output) {
        inflateEnd(&stream);
        return fail(L, "Not enough memory to decompress data");
    }
    stream.next_in = (Bytef *)input;
    stream.avail_in = (uInt)input_size;
    stream.next_out = output;
    stream.avail_out = (uInt)capacity;
    const char *error = NULL;
    while ((status = inflate(&stream, Z_NO_FLUSH)) == Z_OK) {
        if (stream.avail_out != 0) continue;
        if (capacity > UINT_MAX / 2 || capacity > SIZE_MAX / 2) {
            error = "Decompressed data exceeds runtime size limit";
            break;
        }
        void *next = resize_buffer(L, output, capacity * 2);
        if (!next) {
            error = "Not enough memory to decompress data";
            break;
        }
        output = next;
        capacity *= 2;
        stream.next_out = (Bytef *)output + stream.total_out;
        stream.avail_out = (uInt)(capacity - stream.total_out);
    }
    size_t size = stream.total_out;
    inflateEnd(&stream);
    if (error || status != Z_STREAM_END) {
        free_buffer(output);
        return fail(L, error ? error : zError(status));
    }
    return finish(L, output, size);
}
