# ===================================================================
#  PulseSphere :: ingestion_service :: CMakeLists.txt
#
#  Build rules for the real-time ingestion micro-service.  This target
#  is responsible for compiling the high-throughput social-pulse data
#  ingestion pipeline and its plug-ins.
#
#  Author: PulseSphere Engineering Team
#  License: Apache-2.0
# ===================================================================

cmake_minimum_required (VERSION 3.16)

# ------------------------------------------------------------
#  Project meta
# ------------------------------------------------------------
project (ingestion_service
    VERSION     1.4.0
    DESCRIPTION "PulseSphere Real-Time Social Pulse Ingestion Service"
    LANGUAGES   C
)

# ------------------------------------------------------------
#  Build-type and compile options
# ------------------------------------------------------------
if (NOT CMAKE_BUILD_TYPE)
    set (CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif ()

set (CMAKE_C_STANDARD          17)
set (CMAKE_C_STANDARD_REQUIRED ON)
set (CMAKE_C_EXTENSIONS        OFF)

# Treat warnings as errors in CI / when explicitly requested
option (ENABLE_WERROR "Treat warnings as errors" OFF)

# Sanitizers are helpful during development
option (ENABLE_SANITIZERS "Enable address/undefined behaviour sanitizers" OFF)

# Coverage generation
option (ENABLE_COVERAGE "Enable coverage flags" OFF)


# -------------------------
#  Compiler flags
# -------------------------
set (_COMMON_WARN_FLAGS
    -Wall
    -Wextra
    -Wconversion
    -Wpedantic
    -Werror=implicit-function-declaration
    -Wno-unused-parameter
)

list (APPEND CMAKE_C_FLAGS ${_COMMON_WARN_FLAGS})

if (ENABLE_WERROR)
    list (APPEND CMAKE_C_FLAGS "-Werror")
endif ()

if (ENABLE_SANITIZERS AND NOT "${CMAKE_BUILD_TYPE}" STREQUAL "Release")
    list (APPEND CMAKE_C_FLAGS "-fsanitize=address,undefined")
    list (APPEND CMAKE_EXE_LINKER_FLAGS "-fsanitize=address,undefined")
endif ()

if (ENABLE_COVERAGE AND NOT "${CMAKE_BUILD_TYPE}" STREQUAL "Release")
    list (APPEND CMAKE_C_FLAGS "--coverage")
    list (APPEND CMAKE_EXE_LINKER_FLAGS "--coverage")
endif ()


# ------------------------------------------------------------
#  Dependencies  (system / third-party)
# ------------------------------------------------------------
include (CheckIncludeFile)
include (FindPkgConfig)

# LibUV – event loop
pkg_check_modules (LIBUV REQUIRED libuv)

# Apache Kafka C client
pkg_check_modules (RDKAFKA REQUIRED rdkafka)

# json-c – schema validation
pkg_check_modules (JSONC REQUIRED json-c)

# protobuf-c – for internal schema definitions
pkg_check_modules (PROTOBUF_C REQUIRED libprotobuf-c)

# Zstandard – compression of archived pulse windows
pkg_check_modules (ZSTD REQUIRED libzstd)

# For tests
find_package (Threads)

# ------------------------------------------------------------
#  Source layout
# ------------------------------------------------------------
set (INGESTION_SRC_DIR   ${CMAKE_CURRENT_SOURCE_DIR}/src)
set (INGESTION_INC_DIR   ${CMAKE_CURRENT_SOURCE_DIR}/include)
set (PLUGIN_DIR          ${CMAKE_CURRENT_SOURCE_DIR}/plugins)

file (GLOB_RECURSE INGESTION_SOURCES
    CONFIGURE_DEPENDS
    ${INGESTION_SRC_DIR}/*.c
)

file (GLOB_RECURSE INGESTION_HEADERS
    CONFIGURE_DEPENDS
    ${INGESTION_INC_DIR}/*.h
)

# ------------------------------------------------------------
#  Core library (static)
# ------------------------------------------------------------
add_library (ingestion_core STATIC
    ${INGESTION_SOURCES}
    ${INGESTION_HEADERS}
)

target_include_directories (ingestion_core
    PUBLIC
        ${INGESTION_INC_DIR}
    SYSTEM PUBLIC
        ${LIBUV_INCLUDE_DIRS}
        ${RDKAFKA_INCLUDE_DIRS}
        ${JSONC_INCLUDE_DIRS}
        ${PROTOBUF_C_INCLUDE_DIRS}
        ${ZSTD_INCLUDE_DIRS}
)

target_link_libraries (ingestion_core
    PUBLIC
        ${LIBUV_LIBRARIES}
        ${RDKAFKA_LIBRARIES}
        ${JSONC_LIBRARIES}
        ${PROTOBUF_C_LIBRARIES}
        ${ZSTD_LIBRARIES}
        Threads::Threads
)

target_compile_definitions (ingestion_core
    PUBLIC
        $<$<CONFIG:Debug>:PULSESHPHERE_DEBUG>
)

# ------------------------------------------------------------
#  Service executable
# ------------------------------------------------------------
add_executable (ingestion_service
    main.c                             # top-level entry point
)

target_link_libraries (ingestion_service
    PRIVATE
        ingestion_core
)

set_target_properties (ingestion_service
    PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin
)

# ------------------------------------------------------------
#  Plug-in discovery (Strategy Pattern)
# ------------------------------------------------------------
file (GLOB PLUGIN_SOURCES
    CONFIGURE_DEPENDS
    ${PLUGIN_DIR}/*/plugin_*.c
)

foreach (_plugin_src ${PLUGIN_SOURCES})
    get_filename_component (_plugin_name ${_plugin_src} NAME_WE)
    add_library (${_plugin_name} MODULE ${_plugin_src})

    target_include_directories (${_plugin_name}
        PRIVATE
            ${INGESTION_INC_DIR}
    )

    target_link_libraries (${_plugin_name}
        PRIVATE
            ingestion_core
    )

    set_target_properties (${_plugin_name}
        PROPERTIES
            LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/plugins
            PREFIX ""                        # produce plugin_xxx.so
    )
endforeach ()


# ------------------------------------------------------------
#  Testing (CMocka)
# ------------------------------------------------------------
option (ENABLE_TESTS "Build unit tests" ON)

if (ENABLE_TESTS)
    enable_testing ()
    pkg_check_modules (CMOCKA REQUIRED cmocka)

    file (GLOB_RECURSE TEST_SOURCES
        CONFIGURE_DEPENDS
        ${CMAKE_CURRENT_SOURCE_DIR}/tests/test_*.c
    )

    add_executable (ingestion_tests
        ${TEST_SOURCES}
    )

    target_include_directories (ingestion_tests
        PRIVATE
            ${INGESTION_INC_DIR}
            ${CMOCKA_INCLUDE_DIRS}
    )

    target_link_libraries (ingestion_tests
        PRIVATE
            ingestion_core
            ${CMOCKA_LIBRARIES}
    )

    add_test (
        NAME ingestion_unit_tests
        COMMAND ingestion_tests
    )
endif ()

# ------------------------------------------------------------
#  Code quality helpers
# ------------------------------------------------------------
find_program (CLANG_TIDY_EXE NAMES clang-tidy)
if (CLANG_TIDY_EXE)
    set (CMAKE_C_CLANG_TIDY
        ${CLANG_TIDY_EXE};
        -checks=*;
        -warnings-as-errors=*;
    )
endif ()

# ------------------------------------------------------------
#  Installation
# ------------------------------------------------------------
include (GNUInstallDirs)

install (TARGETS ingestion_service
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install (TARGETS ingestion_core
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
)

install (DIRECTORY ${INGESTION_INC_DIR}/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/ingestion
    FILES_MATCHING PATTERN "*.h"
)

install (TARGETS ${_plugin_name}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}/ingestion/plugins
)

# ------------------------------------------------------------
#  Packaging
# ------------------------------------------------------------
include (CPack)
set (CPACK_GENERATOR "TGZ")
set (CPACK_PACKAGE_NAME "pulsesphere-ingestion-service")
set (CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set (CPACK_PACKAGE_VENDOR "PulseSphere Inc")

cpack ()
