#include <assert.h>
#include <emscripten.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include "image.h"
#include "util.h"

enum TextureFlags {
    TF_CLAMP = 0x01,
    TF_NOMIPMAP = 0x02,
    TF_NEAREST = 0x04,
};

// ---- VFS

typedef struct {
    char *name;
    int width;
    int height;
} VfsEntry;

static VfsEntry *st_vfs_entries;
static size_t st_vfs_count;

void image_destroy(void) {
    for (size_t i = 0; i < st_vfs_count; i++) free(st_vfs_entries[i].name);
    free(st_vfs_entries);
    st_vfs_entries = NULL;
    st_vfs_count = 0;
}

static int compare_vfs(const void *a, const void *b) {
    return strcmp(((const VfsEntry *)a)->name, ((const VfsEntry *)b)->name);
}

static int parse_vfs_tsv(void) {
    image_destroy();
    FILE *f = fopen(".image.tsv", "r");
    if (f == NULL) {
        log_error("Failed to open .image.tsv");
        return 0;
    }
    char *line = NULL;
    size_t line_capacity = 0, capacity = 0;
    ssize_t length;
    int ok = 1;
    while ((length = getline(&line, &line_capacity, f)) >= 0) {
        if (length && line[length - 1] == '\n') line[--length] = 0;
        if (length && line[length - 1] == '\r') line[--length] = 0;
        char *width_text = strchr(line, '\t');
        char *height_text = width_text ? strchr(width_text + 1, '\t') : NULL;
        if (!width_text || !height_text || width_text == line || length > 65536 ||
            (size_t)length != strlen(line)) { ok = 0; break; }
        *width_text++ = 0;
        *height_text++ = 0;
        char *end_width, *end_height;
        errno = 0;
        long width = strtol(width_text, &end_width, 10);
        long height = strtol(height_text, &end_height, 10);
        if (errno || *end_width || *end_height || width <= 0 || height <= 0 ||
            width > INT_MAX || height > INT_MAX) { ok = 0; break; }
        if (st_vfs_count == capacity) {
            size_t next = capacity ? capacity * 2 : 1024;
            if (next < capacity || next > SIZE_MAX / sizeof(VfsEntry)) { ok = 0; break; }
            VfsEntry *entries = realloc(st_vfs_entries, next * sizeof(VfsEntry));
            if (!entries) { ok = 0; break; }
            st_vfs_entries = entries;
            capacity = next;
        }
        char *name = strdup(line);
        if (!name) { ok = 0; break; }
        st_vfs_entries[st_vfs_count++] = (VfsEntry){name, (int)width, (int)height};
    }
    // getline can fail allocation without setting the stream's error flag.
    if (!feof(f) || ferror(f)) ok = 0;
    free(line);
    fclose(f);
    if (ok && st_vfs_count) {
        qsort(st_vfs_entries, st_vfs_count, sizeof(VfsEntry), compare_vfs);
        for (size_t i = 1; i < st_vfs_count; i++) {
            if (!strcmp(st_vfs_entries[i-1].name, st_vfs_entries[i].name)) ok = 0;
        }
    }
    if (!ok) { image_destroy(); log_error("Invalid or unallocatable .image.tsv"); }
    return ok;
}

static VfsEntry *lookup_vfs_entry(const char *name) {
    VfsEntry key = {(char *)name, 0, 0};
    return st_vfs_count ? bsearch(&key, st_vfs_entries, st_vfs_count, sizeof(VfsEntry), compare_vfs) : NULL;
}

// ----

static const char *IMAGE_HANDLE_TYPE = "ImageHandle";

static int st_next_handle = 0;
static const char st_image_resources = 0;

// Intern immutable texture identities in the Lua state's registry. Repeated UI
// frames may create new userdata, but only a new filename/effective-flags pair
// allocates another resource ID. The table is reclaimed with the Lua state.
static int image_resource_id(lua_State *L, const char *filename, int flags, ImageHandle *image) {
    lua_rawgetp(L, LUA_REGISTRYINDEX, &st_image_resources);
    lua_getfield(L, -1, filename);
    if (lua_isnil(L, -1)) {
        lua_pop(L, 1);
        lua_newtable(L);
        lua_pushvalue(L, -1);
        lua_setfield(L, -3, filename);
    }
    lua_rawgeti(L, -1, flags);
    int is_new = lua_isnil(L, -1);
    if (lua_isnil(L, -1)) {
        lua_pop(L, 1);
        lua_newtable(L);
        VfsEntry *entry = lookup_vfs_entry(filename);
        lua_pushinteger(L, ++st_next_handle); lua_rawseti(L, -2, 1);
        lua_pushinteger(L, entry ? entry->width : 1); lua_rawseti(L, -2, 2);
        lua_pushinteger(L, entry ? entry->height : 1); lua_rawseti(L, -2, 3);
        lua_pushvalue(L, -1);
        lua_rawseti(L, -3, flags);
    }
    lua_rawgeti(L, -1, 1); image->handle = lua_tointeger(L, -1); lua_pop(L, 1);
    lua_rawgeti(L, -1, 2); image->width = lua_tointeger(L, -1); lua_pop(L, 1);
    lua_rawgeti(L, -1, 3); image->height = lua_tointeger(L, -1); lua_pop(L, 1);
    lua_pop(L, 3);
    return is_new;
}

static int is_user_data(lua_State *L, int index, const char *type) {
    if (lua_type(L, index) != LUA_TUSERDATA) {
        return 0;
    }

    if (lua_getmetatable(L, index) == 0) {
        return 0;
    }

    lua_getfield(L, LUA_REGISTRYINDEX, type);
    int result = lua_rawequal(L, -2, -1);
    lua_pop(L, 2);

    return result;
}

static ImageHandle *get_image_handle(lua_State *L) {
    assert(is_user_data(L, 1, IMAGE_HANDLE_TYPE));
    ImageHandle *image_handle = lua_touserdata(L, 1);
    // Keep the userdata rooted while Load may allocate registry tables/strings.
    return image_handle;
}

static int NewImageHandle(lua_State *L) {
    ImageHandle *image_handle = lua_newuserdata(L, sizeof(ImageHandle));
    // Zero means the white fallback in draw.c; unloaded images must stay absent.
    image_handle->handle = -1;
    image_handle->width = 1;
    image_handle->height = 1;

    lua_pushvalue(L, lua_upvalueindex(1));
    lua_setmetatable(L, -2);

    return 1;
}

static int ImageHandle_Load(lua_State *L) {
    ImageHandle *image_handle = get_image_handle(L);

    int n = lua_gettop(L);
    assert(n >= 2);
    assert(lua_isstring(L, 2));

    const char *filename = lua_tostring(L, 2);

    int flags = TF_NOMIPMAP;
    for (int f = 3; f <= n; ++f) {
        if (!lua_isstring(L, f)) {
            continue;
        }

        const char *flag = lua_tostring(L, f);
        if (!strcmp(flag, "ASYNC")) {
            // async texture loading removed
        } else if (!strcmp(flag, "CLAMP")) {
            flags |= TF_CLAMP;
        } else if (!strcmp(flag, "MIPMAP")) {
            flags &= ~TF_NOMIPMAP;
        } else if (!strcmp(flag, "NEAREST")) {
            flags |= TF_NEAREST;
        } else {
            assert(0);
        }
    }

    if (image_resource_id(L, filename, flags, image_handle)) EM_ASM({
               Module.imageLoad($0, UTF8ToString($1), $2);
           }, image_handle->handle, filename, flags);

    return 0;
}

static int ImageHandle_ImageSize(lua_State *L) {
    ImageHandle *image_handle = get_image_handle(L);

    lua_pushinteger(L, image_handle->width);
    lua_pushinteger(L, image_handle->height);

    return 2;
}

int image_init(lua_State *L) {
    // Parse vfs.tsv
    if (!parse_vfs_tsv()) return 0;
    st_next_handle = 0;

    lua_newtable(L);
    lua_rawsetp(L, LUA_REGISTRYINDEX, &st_image_resources);

    // Image handles
    lua_newtable(L);
    lua_pushvalue(L, -1);
    lua_pushcclosure(L, NewImageHandle, 1);
    lua_setglobal(L, "NewImageHandle");

    lua_pushvalue(L, -1);
    lua_setfield(L, -2, "__index");

    lua_pushcfunction(L, ImageHandle_Load);
    lua_setfield(L, -2, "Load");

    lua_pushcfunction(L, ImageHandle_ImageSize);
    lua_setfield(L, -2, "ImageSize");

    lua_setfield(L, LUA_REGISTRYINDEX, IMAGE_HANDLE_TYPE);
    return 1;
}
