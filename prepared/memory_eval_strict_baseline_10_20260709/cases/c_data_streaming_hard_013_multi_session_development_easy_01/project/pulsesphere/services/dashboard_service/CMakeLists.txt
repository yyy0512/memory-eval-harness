cmake_minimum_required(VERSION 3.18)

# ─────────────────────────────────────────────────────────────────────────────
# PulseSphere :: Dashboard Service
# CMake build script
#
# This script configures, builds, tests, and installs the real-time dashboard
# micro-service responsible for publishing curated pulse events to the Web UI.
# ─────────────────────────────────────────────────────────────────────────────

# -----------------------------------------------------------------------------
# Project metadata
# -----------------------------------------------------------------------------
project(pulsesphere_dashboard_service
        VERSION 1.3.0
        DESCRIPTION "PulseSphere Dashboard Service – Real-Time Social Pulse Visualization"
        HOMEPAGE_URL "https://github.com/pulsesphere/pulsesphere"
        LANGUAGES C)

# -----------------------------------------------------------------------------
# User-configurable options
# -----------------------------------------------------------------------------
option(BUILD_SHARED_LIBS  "Build libraries as shared."                     ON)
option(WARNINGS_AS_ERRORS "Treat compiler warnings as errors."            ON)
option(ENABLE_CLANG_TIDY  "Enable clang-tidy static analysis."            OFF)
option(ENABLE_SANITIZER   "Enable Address/Undefined Behavior sanitizer."  OFF)
option(ENABLE_COVERAGE    "Enable GCC/Clang code-coverage generation."    OFF)

# -----------------------------------------------------------------------------
# Compiler settings
# -----------------------------------------------------------------------------
set(C_STANDARD_REQUIRED  ON)
set(CMAKE_C_STANDARD     11)

if(MSVC)
    add_compile_options(/W4 /permissive-)
    if(WARNINGS_AS_ERRORS)
        add_compile_options(/WX)
    endif()
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
    if(WARNINGS_AS_ERRORS)
        add_compile_options(-Werror)
    endif()
    if(ENABLE_SANITIZER AND CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
        add_compile_options(-fsanitize=address,undefined)
        set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -fsanitize=address,undefined")
    endif()
    if(ENABLE_COVERAGE AND CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
        add_compile_options(--coverage)
        link_libraries(--coverage)
    endif()
endif()

# -----------------------------------------------------------------------------
# clang-tidy (optional)
# -----------------------------------------------------------------------------
if(ENABLE_CLANG_TIDY)
    find_program(CLANG_TIDY_EXE NAMES clang-tidy)
    if(CLANG_TIDY_EXE)
        message(STATUS "clang-tidy enabled")
        set(CMAKE_C_CLANG_TIDY "${CLANG_TIDY_EXE}")
    else()
        message(WARNING "clang-tidy requested but not found")
    endif()
endif()

# -----------------------------------------------------------------------------
# External dependencies
# -----------------------------------------------------------------------------
include(FetchContent)
include(GNUInstallDirs)

# libuv (event loop / async I/O)
find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBUV REQUIRED libuv)

# protobuf (schema definition)
find_package(Protobuf 3.15 REQUIRED)
if(NOT Protobuf_FOUND)
    message(FATAL_ERROR "Protocol Buffers not found. Aborting.")
endif()

# zlib (compression)
find_package(ZLIB REQUIRED)

# Internal common utilities (exported by top-level build)
find_package(pulsesphere_common REQUIRED CONFIG)

# -----------------------------------------------------------------------------
# Build the dashboard service executable
# -----------------------------------------------------------------------------
file(GLOB_RECURSE DASHBOARD_SRC CONFIGURE_DEPENDS
     "src/*.c"
     "include/*.h")

add_executable(pulsesphere_dashboard_service ${DASHBOARD_SRC})

target_include_directories(pulsesphere_dashboard_service
        PRIVATE
            "${PROJECT_SOURCE_DIR}/include"
            ${LIBUV_INCLUDE_DIRS}
            ${Protobuf_INCLUDE_DIRS}
            ${ZLIB_INCLUDE_DIRS}
        PUBLIC
            $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
            $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}>)

target_link_libraries(pulsesphere_dashboard_service
        PRIVATE
            pulsesphere_common::core                 # ← exported target
            ${LIBUV_LIBRARIES}
            ${Protobuf_LIBRARIES}
            ZLIB::ZLIB)

# -----------------------------------------------------------------------------
# Installation
# -----------------------------------------------------------------------------
install(TARGETS pulsesphere_dashboard_service
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        COMPONENT runtime)

install(DIRECTORY include/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/dashboard_service
        COMPONENT devel)

# -----------------------------------------------------------------------------
# Unit / integration tests
# -----------------------------------------------------------------------------
enable_testing()

add_executable(pulsesphere_dashboard_tests
        tests/test_dashboard_service.c
        tests/test_event_translation.c)

target_link_libraries(pulsesphere_dashboard_tests
        PRIVATE
            pulsesphere_dashboard_service
            pulsesphere_common::test_utils
            ${LIBUV_LIBRARIES}
            ${Protobuf_LIBRARIES}
            ZLIB::ZLIB)

add_test(NAME dashboard_service_unit_tests
         COMMAND pulsesphere_dashboard_tests)

# -----------------------------------------------------------------------------
# Packaging (CPack)
# -----------------------------------------------------------------------------
include(CPack)

set(CPACK_PACKAGE_NAME "pulsesphere-dashboard-service")
set(CPACK_PACKAGE_VENDOR "PulseSphere")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY
    "Real-Time Dashboard Service component of PulseSphere")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGING_INSTALL_PREFIX "/usr")

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
message(STATUS "")
message(STATUS "Build configuration for Dashboard Service:")
message(STATUS "  Build type          : ${CMAKE_BUILD_TYPE}")
message(STATUS "  Compiler            : ${CMAKE_C_COMPILER_ID} ${CMAKE_C_COMPILER_VERSION}")
message(STATUS "  Warnings as errors  : ${WARNINGS_AS_ERRORS}")
message(STATUS "  clang-tidy          : ${ENABLE_CLANG_TIDY}")
message(STATUS "  Sanitizers          : ${ENABLE_SANITIZER}")
message(STATUS "  Code coverage       : ${ENABLE_COVERAGE}")
message(STATUS "")