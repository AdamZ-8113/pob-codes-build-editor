#ifndef DRIVER_DRAW_H
#define DRIVER_DRAW_H

#include "lua.h"

extern void draw_init(lua_State *L);
extern void draw_begin();
extern void draw_get_buffer(void **data, size_t *size);
extern void draw_end();
extern void draw_destroy(void);
extern double draw_system_scale(void);
extern const char *get_draw_profile(void);
extern void invalidate_text_width_cache(void);

#endif //DRIVER_DRAW_H
