#include "byte_buffer.h"

#include <stdlib.h>
#include <string.h>
#ifdef DRIVER_TESTING
int byte_buffer_fail_allocation;
#endif

int byte_buffer_append(ByteBuffer *buffer, const void *data, size_t size) {
    if (size > SIZE_MAX - buffer->size) return 0;
    if (!size) return 1;
    size_t required = buffer->size + size;
    if (required > buffer->capacity) {
#ifdef DRIVER_TESTING
        if (byte_buffer_fail_allocation) return 0;
#endif
        size_t capacity = buffer->capacity ? buffer->capacity : 65536;
        while (capacity < required) {
            if (capacity > SIZE_MAX / 2) { capacity = required; break; }
            capacity *= 2;
        }
        void *next = realloc(buffer->data, capacity);
        if (!next) return 0;
        buffer->data = next;
        buffer->capacity = capacity;
        buffer->reallocations++;
    }
    memcpy(buffer->data + buffer->size, data, size);
    buffer->size += size;
    return 1;
}

void byte_buffer_free(ByteBuffer *buffer) {
    free(buffer->data);
    *buffer = (ByteBuffer){0};
}
