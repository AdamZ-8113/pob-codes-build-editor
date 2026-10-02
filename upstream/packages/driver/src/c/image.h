#ifndef DRIVER_IMAGE_H
#define DRIVER_IMAGE_H

#include "lua.h"

typedef struct {
    int handle;
    int width;
    int height;
} ImageHandle;

extern int image_init(lua_State *L);
extern void image_destroy(void);

#endif //DRIVER_IMAGE_H
