```cmake
#
# PaletteFlux GraphQL Studio ― Top-level CMake configuration
#
# This file orchestrates the entire build, test, documentation and
# packaging pipeline for the PaletteFlux Studio backend.  It embraces
# modern CMake best-practices: targets-first, interface libraries for
# global compile options, optional sanitizers, coverage, LTO and a
# comprehensive packaging recipe via CPack.
#

cmake_minimum_required(VERSION 3.20)

# ──────────────────────────────────────────────────────────────────────
# Project meta-information
# ──────────────────────────────────────────────────────────────────────
project(
    PaletteFluxStudio
    VERSION 1.4.0
    DESCRIPTION "PaletteFlux GraphQL Studio – Creative centric API platform"
    LANGUAGES CXX)

# ──────────────────────────────────────────────────────────────────────
# Global build options exposed to users
# ──────────────────────────────────────────────────────────────────────
option(PFS_BUILD_TESTS       "Build unit tests"                       ON)
option(PFS_BUILD_DOCS        "Build API reference documentation"      ON)
option(PFS_ENABLE_SANITIZERS "Enable Address/UB sanitizers"          OFF)
option(PFS_ENABLE_COVERAGE   "Enable gcov/llvm-cov support"          OFF)
option(PFS_ENABLE_LTO        "Enable Link Time Optimization (LTO)"   ON)
option(PFS_WARN_AS_ERROR     "Treat warnings as errors"              OFF)

# ──────────────────────────────────────────────────────────────────────
# Toolchain overrides
# (Allow users to inject their own toolchain through CMAKE_TOOLCHAIN_FILE)
# ──────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────
# C++ dialect and global compile flags (via INTERFACE target)
# ──────────────────────────────────────────────────────────────────────
add_library(pfs_warnings INTERFACE)

target_compile_features(pfs_warnings INTERFACE cxx_std_20)

# Common warnings
if (MSVC)
    target_compile_options(pfs_warnings INTERFACE /W4)
else()
    target_compile_options(pfs_warnings INTERFACE -Wall -Wextra -Wpedantic)
endif()

# Promote warnings to errors when requested
if (PFS_WARN_AS_ERROR)
    if (MSVC)
        target_compile_options(pfs_warnings INTERFACE /WX)
    else()
        target_compile_options(pfs_warnings INTERFACE -Werror)
    endif()
endif()

# Sanitizers (only for Clang/GCC)
if (PFS_ENABLE_SANITIZERS AND NOT MSVC)
    message(STATUS "Building with sanitizers enabled")
    target_compile_options(pfs_warnings INTERFACE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options   (pfs_warnings INTERFACE -fsanitize=address,undefined -fno-omit-frame-pointer)
endif()

# Code coverage (Clang/GCC)
if (PFS_ENABLE_COVERAGE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    message(STATUS "Building with coverage flags")
    target_compile_options(pfs_warnings INTERFACE -O0 -g --coverage)
    target_link_options   (pfs_warnings INTERFACE --coverage)
endif()

# Link-time optimization
include(CheckIPOSupported)
if (PFS_ENABLE_LTO)
    check_ipo_supported(RESULT ipo_supported OUTPUT ipo_err)
    if (ipo_supported)
        message(STATUS "IPO/LTO enabled")
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
    else()
        message(WARNING "IPO/LTO not supported: ${ipo_err}")
    endif()
endif()

# ──────────────────────────────────────────────────────────────────────
# Dependencies
# ──────────────────────────────────────────────────────────────────────
include(FetchContent)

# Prefer system packages; fallback to FetchContent
find_package(fmt          9.1        QUIET)
find_package(spdlog       1.10       QUIET)
find_package(Boost        1.78 REQUIRED COMPONENTS program_options filesystem thread)
find_package(nlohmann_json 3.2       QUIET)
find_package(Threads                 REQUIRED)
find_package(OpenSSL                REQUIRED)

# Fallback: fmt
if (NOT fmt_FOUND)
    FetchContent_Declare(
        fmt
        GIT_REPOSITORY https://github.com/fmtlib/fmt.git
        GIT_TAG        9.1.0)
    FetchContent_MakeAvailable(fmt)
endif()

# Fallback: spdlog
if (NOT spdlog_FOUND)
    FetchContent_Declare(
        spdlog
        GIT_REPOSITORY https://github.com/gabime/spdlog.git
        GIT_TAG        v1.10.0)
    FetchContent_MakeAvailable(spdlog)
endif()

# Fallback: nlohmann_json
if (NOT nlohmann_json_FOUND)
    FetchContent_Declare(
        nlohmann_json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG        v3.11.2)
    FetchContent_MakeAvailable(nlohmann_json)
endif()

# cppgraphqlgen – used for schema code-generation
FetchContent_Declare(
    cppgraphqlgen
    GIT_REPOSITORY https://github.com/microsoft/cppgraphqlgen.git
    GIT_TAG        v3.6.0)
FetchContent_MakeAvailable(cppgraphqlgen)

# ──────────────────────────────────────────────────────────────────────
# Code generation: GraphQL schema → C++
# ──────────────────────────────────────────────────────────────────────
find_package(Python3 COMPONENTS Interpreter REQUIRED)

set(GRAPHQL_SCHEMA            ${CMAKE_SOURCE_DIR}/schema/paletteflux.graphql)
set(GRAPHQL_CODEGEN_DIR       ${CMAKE_BINARY_DIR}/generated/graphql)
set(GRAPHQL_CODEGEN_SCRIPT    ${CMAKE_SOURCE_DIR}/tools/codegen/gql_codegen.py)

file(MAKE_DIRECTORY ${GRAPHQL_CODEGEN_DIR})

add_custom_command(
    OUTPUT  ${GRAPHQL_CODEGEN_DIR}/Query.hpp # sentinel
    COMMAND ${Python3_EXECUTABLE}
            ${GRAPHQL_CODEGEN_SCRIPT}
            --schema ${GRAPHQL_SCHEMA}
            --output ${GRAPHQL_CODEGEN_DIR}
    DEPENDS ${GRAPHQL_SCHEMA} ${GRAPHQL_CODEGEN_SCRIPT}
    COMMENT "Generating GraphQL C++ stubs from schema"
    VERBATIM)

add_custom_target(codegen_graphql DEPENDS ${GRAPHQL_CODEGEN_DIR}/Query.hpp)

# ──────────────────────────────────────────────────────────────────────
# Source tree organisation
# ──────────────────────────────────────────────────────────────────────
add_subdirectory(src)

if (PFS_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

if (PFS_BUILD_DOCS)
    add_subdirectory(docs)
endif()

# ──────────────────────────────────────────────────────────────────────
# Packaging (CPack)
# ──────────────────────────────────────────────────────────────────────
include(CPack)

set(CPACK_PACKAGE_VENDOR               "PaletteFlux")
set(CPACK_PACKAGE_CONTACT              "dev@paletteflux.io")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY  "${PROJECT_DESCRIPTION}")
set(CPACK_RESOURCE_FILE_LICENSE        "${CMAKE_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGE_VERSION              ${PROJECT_VERSION})

if (WIN32)
    set(CPACK_GENERATOR                "ZIP")
else()
    set(CPACK_GENERATOR                "TGZ")
endif()

# ──────────────────────────────────────────────────────────────────────
# Developer convenience targets
# ──────────────────────────────────────────────────────────────────────
# ▸ clang-format – Enforces project style
find_program(CLANG_FORMAT_EXE NAMES clang-format)
if (CLANG_FORMAT_EXE)
    file(GLOB_RECURSE ALL_CXX_SOURCE_FILES
         CONFIGURE_DEPENDS
         src/*.cpp src/*.hpp
         tests/*.cpp
         include/**/*.hpp)
    add_custom_target(
        clang_format
        COMMAND ${CLANG_FORMAT_EXE}
                -i
                --style=file
                ${ALL_CXX_SOURCE_FILES}
        COMMENT "Running clang-format on source tree")
endif()

# ▸ make run – Launch development server (debug builds only)
add_custom_target(
    run
    COMMAND PaletteFluxStudio::server --config dev.yaml
    COMMENT "Starting PaletteFlux Studio development server"
    USES_TERMINAL
    WORKING_DIRECTORY ${CMAKE_BINARY_DIR}
    VERBATIM)

# Ensure code generation fires before actual build
add_dependencies(PaletteFluxCore codegen_graphql)

# ──────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────
message(STATUS "")
message(STATUS "Build configuration for PaletteFlux Studio")
message(STATUS "  Version           : ${PROJECT_VERSION}")
message(STATUS "  C++ Standard      : 20")
message(STATUS "  Build Tests       : ${PFS_BUILD_TESTS}")
message(STATUS "  Build Docs        : ${PFS_BUILD_DOCS}")
message(STATUS "  Sanitizers        : ${PFS_ENABLE_SANITIZERS}")
message(STATUS "  Coverage          : ${PFS_ENABLE_COVERAGE}")
message(STATUS "  LTO               : ${PFS_ENABLE_LTO}")
message(STATUS "")
```