#ifndef DRIVER_BYTE_BUFFER_H
#define DRIVER_BYTE_BUFFER_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint8_t *data;
    size_t size;
    size_t capacity;
    size_t reallocations;
} ByteBuffer;

int byte_buffer_append(ByteBuffer *buffer, const void *data, size_t size);
void byte_buffer_free(ByteBuffer *buffer);
#ifdef DRIVER_TESTING
extern int byte_buffer_fail_allocation;
#endif

#endif
