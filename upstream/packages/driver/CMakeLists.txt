cmake_minimum_required(VERSION 3.28)

project("driver")

option(POB_COMPACT_VALUES "Use Lua's wasm32-compatible 8-byte values" ON)
if(POB_COMPACT_VALUES)
    add_compile_definitions(LUA_NANTRICK LUA_IEEEENDIAN=0)
endif()
add_link_options("-sMALLOC=mimalloc" "-sALLOW_MEMORY_GROWTH")

STRING (TOLOWER "${CMAKE_BUILD_TYPE}" CMAKE_BUILD_TYPE_LOWER)

add_custom_command(
        OUTPUT ${CMAKE_BINARY_DIR}/boot.c ${CMAKE_BINARY_DIR}/item_tooltip_cache_test.c ${CMAKE_BINARY_DIR}/helper_boot.c
        COMMAND ${CMAKE_COMMAND} -E echo "Writing boot.lua to boot.c"
        COMMAND ${CMAKE_COMMAND} -DDRIVER_SOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR} -P ${CMAKE_CURRENT_SOURCE_DIR}/gen_boot_c.cmake
        DEPENDS gc-policy.lua test/lua/gc-policy.lua
        DEPENDS item-comparison-workers.lua test/lua/item-comparison-workers.lua
        DEPENDS boot.lua helper-boot.lua node-power-workers.lua test/lua/node-power-workers.lua unique-sort-workers.lua test/lua/unique-sort-workers.lua item-tooltip-cache.lua runtime-profile.lua calculation-scheduler.lua unique-comparison-delay.lua gen_boot_c.cmake test/lua/item-tooltip-cache.lua test/lua/runtime-profile.lua test/lua/calculation-scheduler.lua test/lua/unique-comparison-delay.lua ../packer/src/timeless-seeds.lua test/lua/timeless-seeds.lua ../packer/src/timeless-inflate.lua test/lua/timeless-inflate.lua
)

file(GLOB_RECURSE LUA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/lua/*.c)
list(REMOVE_ITEM LUA_SOURCES ${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/lua/lua.c)
include_directories(${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/lua)

add_compile_options("-flto" "-g" "-sUSE_ZLIB")
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options("-O0")
endif()
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    add_compile_options("-O3")
endif()
set(CMAKE_EXECUTABLE_SUFFIX ".mjs")

add_executable(${PROJECT_NAME}
        ${LUA_SOURCES}
        ${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/luautf8/lutf8lib.c
        ${CMAKE_BINARY_DIR}/boot.c
        ${CMAKE_BINARY_DIR}/helper_boot.c
        src/c/driver.c
        src/c/compression.c
        src/c/draw.c
        src/c/draw.h
        src/c/text_width_cache.c
        src/c/text_width_cache.h
        src/c/draw_color.c
        src/c/draw_color.h
        src/c/dpi.c
        src/c/dpi.h
        src/c/byte_buffer.c
        src/c/byte_buffer.h
        src/c/image.c
        src/c/image.h
        src/c/fs.c
        src/c/fs.h
        src/c/util.c
        src/c/util.h
        src/c/wasmfs/nodefs.cpp
        src/c/wasmfs/nodefs.h
        src/c/wasmfs/nodefs_js.cpp
        src/c/sub.c
        src/c/sub.h
        src/c/sub_serialization.c
        src/c/sub_serialization.h
        src/c/lcurl.c
        src/c/lcurl.h
)

enable_testing()
add_executable(driver_tooltip_cache_test ${LUA_SOURCES} test/c/tooltip_cache_test.c ${CMAKE_BINARY_DIR}/item_tooltip_cache_test.c)
add_test(NAME driver_tooltip_cache_test COMMAND ${CMAKE_CROSSCOMPILING_EMULATOR}
        ${CMAKE_CURRENT_SOURCE_DIR}/test/run-native.mjs $<TARGET_FILE:driver_tooltip_cache_test>)
add_executable(driver_lua_syntax_test ${LUA_SOURCES} test/c/lua_syntax_test.c)
add_test(NAME driver_lua_syntax_test COMMAND ${CMAKE_CROSSCOMPILING_EMULATOR}
        ${CMAKE_CURRENT_SOURCE_DIR}/test/run-native.mjs $<TARGET_FILE:driver_lua_syntax_test>)
add_executable(driver_bridge_test
        ${LUA_SOURCES}
        test/c/bridge_test.c
        src/c/compression.c
        src/c/draw.c
        src/c/text_width_cache.c
        src/c/byte_buffer.c
        src/c/draw_color.c
        src/c/dpi.c
        src/c/sub_serialization.c
        src/c/image.c
        src/c/util.c
)
target_include_directories(driver_bridge_test PRIVATE src/c)
target_compile_definitions(driver_bridge_test PRIVATE DRIVER_TESTING)
target_link_options(driver_bridge_test PRIVATE "-sUSE_ZLIB")
add_test(NAME driver_bridge_test COMMAND ${CMAKE_CROSSCOMPILING_EMULATOR}
        ${CMAKE_CURRENT_SOURCE_DIR}/test/run-native.mjs $<TARGET_FILE:driver_bridge_test>)

add_executable(driver_fs_integration_test
        ${LUA_SOURCES}
        test/c/fs_integration_test.c
        src/c/fs.c
        src/c/wasmfs/nodefs.cpp
        src/c/wasmfs/nodefs_js.cpp
)
target_include_directories(driver_fs_integration_test PRIVATE src/c)
target_link_options(driver_fs_integration_test PRIVATE
        "-sWASMFS"
        "-sMODULARIZE"
        "-sEXPORT_ES6"
        "-sENVIRONMENT=node"
        "-sEXPORTED_RUNTIME_METHODS=ERRNO_CODES,setValue,HEAPU8,stringToUTF8OnStack,stackSave,stackRestore"
)

set(DRIVER_LINK_FLAGS
        "-flto"
        "-Wl,--build-id=sha1"
        "--no-entry"
        "-sUSE_ZLIB"
        "-sMODULARIZE"
        "-sSTACK_SIZE=1MB"
        "-sENVIRONMENT=worker"
        "-sALLOW_MEMORY_GROWTH"
        "-sWASMFS"
        "-sSTRICT"
        "-sEXPORTED_FUNCTIONS=_malloc,_free"
        "-sINCOMING_MODULE_JS_API=[print,printErr,wasmBinary]"
        "-sEXPORTED_RUNTIME_METHODS=cwrap,ccall,ERRNO_CODES,setValue,HEAPU8,stringToUTF8OnStack,stackSave,stackRestore"
)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(DRIVER_LINK_FLAGS "${DRIVER_LINK_FLAGS}" "-g3" "-sASSERTIONS=1" "-sSAFE_HEAP=1" "-sSTACK_OVERFLOW_CHECK=2")
endif()
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    # DWARF disables several Binaryen optimization passes. Keep profiler names,
    # but reserve full source-level debugging for the separate Debug build.
    set(DRIVER_LINK_FLAGS "${DRIVER_LINK_FLAGS}" "-g0" "-g2")
endif()
target_link_options(${PROJECT_NAME} PRIVATE ${DRIVER_LINK_FLAGS})

set_target_properties(${PROJECT_NAME}
        PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${PROJECT_SOURCE_DIR}/dist/${CMAKE_BUILD_TYPE_LOWER}
)
