#ifndef DRIVER_COMPRESSION_H
#define DRIVER_COMPRESSION_H

#include "lua.h"
#include <stddef.h>

int driver_deflate(lua_State *L);
int driver_inflate(lua_State *L);

#ifdef DRIVER_TESTING
extern int compression_fail_after;
extern int compression_live_buffers;
extern size_t compression_gc_threshold;
#endif

#endif
