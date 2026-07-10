```cmake
#
# PaletteFlux Studio ― Source-level CMake Build Script
#
# This CMakeLists belongs to the `src/` directory and is responsible for
# assembling the PaletteFlux GraphQL Studio core library as well as its
# auxiliary executable tools used during development (schema generation,
# hot-reload dev-server, etc.).
#
# It is assumed that the top-level CMakeLists already called
#   project(PaletteFluxStudio LANGUAGES CXX)
# and added this folder via `add_subdirectory(src)`.
#

cmake_minimum_required(VERSION 3.20)

# -------------------------------------------------------------
#  Build Options
# -------------------------------------------------------------
option(PFS_ENABLE_WARNINGS_AS_ERRORS "Treat all compiler warnings as errors" ON)
option(PFS_ENABLE_CLANG_TIDY         "Run clang-tidy static analysis"       OFF)
option(PFS_ENABLE_CPPCHECK           "Run cppcheck static analysis"         OFF)
option(PFS_ENABLE_SANITIZERS         "Enable address/UB sanitizers"         OFF)
option(PFS_BUILD_DEV_TOOLS           "Build developer-only tools"           ON)

# -------------------------------------------------------------
#  C++ Standard, Position Independent Code
# -------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# -------------------------------------------------------------
#  Source File Discovery
# -------------------------------------------------------------
# NB: headers are also listed so IDEs will show them, but they
# are not compiled directly.
file(GLOB_RECURSE PFS_CORE_SOURCES
     CONFIGURE_DEPENDS
     ./paletteflux/*.cpp
     ./paletteflux/*.hpp
     ./paletteflux/*.h
)

# -------------------------------------------------------------
#  Third-Party Dependencies
# -------------------------------------------------------------
include(FetchContent)

# JSON (https://github.com/nlohmann/json)
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY  https://github.com/nlohmann/json.git
    GIT_TAG         v3.11.2
)
FetchContent_MakeAvailable(nlohmann_json)

# Boost (header-only portions and selected compiled libs)
find_package(Boost 1.76 REQUIRED COMPONENTS filesystem program_options)

# spdlog for structured logging
FetchContent_Declare(
    spdlog
    GIT_REPOSITORY https://github.com/gabime/spdlog.git
    GIT_TAG        v1.12.0
)
FetchContent_MakeAvailable(spdlog)

# graphqlcpp (hypothetical modern C++ GraphQL implementation)
# For demonstration we mimic retrieval; in real project this would be replaced.
FetchContent_Declare(
    graphqlcpp
    GIT_REPOSITORY https://github.com/paletteflux/graphqlcpp.git
    GIT_TAG        main
)
FetchContent_MakeAvailable(graphqlcpp)

# -------------------------------------------------------------
#  Core Library Target
# -------------------------------------------------------------
add_library(paletteflux_core STATIC
    ${PFS_CORE_SOURCES}
)

target_include_directories(paletteflux_core
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}>
        $<INSTALL_INTERFACE:include>
)

target_link_libraries(paletteflux_core
    PUBLIC
        Boost::filesystem
        Boost::program_options
        nlohmann_json::nlohmann_json
        spdlog::spdlog
        graphqlcpp::graphqlcpp                             # exported by fetch
)

# Enable LTO in Release if supported
include(CheckIPOSupported)
check_ipo_supported(RESULT PFS_LTO_SUPPORTED OUTPUT PFS_LTO_OUTPUT)
if(PFS_LTO_SUPPORTED AND CMAKE_BUILD_TYPE STREQUAL "Release")
    set_target_properties(paletteflux_core PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)
endif()

# -------------------------------------------------------------
#  Compiler Warnings and Sanitizers
# -------------------------------------------------------------
if(MSVC)
    target_compile_options(paletteflux_core PRIVATE /permissive- /W4)
else()
    target_compile_options(paletteflux_core PRIVATE
        -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion
    )
    if(PFS_ENABLE_WARNINGS_AS_ERRORS)
        target_compile_options(paletteflux_core PRIVATE -Werror)
    endif()

    if(PFS_ENABLE_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
        target_compile_options(paletteflux_core PRIVATE -fsanitize=address,undefined)
        target_link_options(paletteflux_core    PRIVATE -fsanitize=address,undefined)
    endif()
endif()

# -------------------------------------------------------------
#  Static Analysis (opt-in)
# -------------------------------------------------------------
if(PFS_ENABLE_CLANG_TIDY)
    set_target_properties(paletteflux_core PROPERTIES
        CXX_CLANG_TIDY "clang-tidy;-warnings-as-errors=*"
    )
endif()

if(PFS_ENABLE_CPPCHECK)
    set_target_properties(paletteflux_core PROPERTIES
        CXX_CPPCHECK "cppcheck;--enable=all;--inconclusive;--std=c++20"
    )
endif()

# -------------------------------------------------------------
#  Dev Tools (schema generator & hot-reload server)
# -------------------------------------------------------------
if(PFS_BUILD_DEV_TOOLS)
    # Schema Generator — converts *.graphql files into C++ reflection artefacts
    add_executable(pfs_schema_gen tools/schema_generator/main.cpp)
    target_link_libraries(pfs_schema_gen PRIVATE paletteflux_core)

    # Hot-Reload Dev Server — lightweight HTTP+GraphQL playground
    add_executable(pfs_dev_server tools/dev_server/main.cpp)
    target_link_libraries(pfs_dev_server PRIVATE paletteflux_core)
endif()

# -------------------------------------------------------------
#  Install Rules
# -------------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS paletteflux_core
        EXPORT  PaletteFluxCoreTargets
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
)

install(DIRECTORY paletteflux/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/paletteflux
        FILES_MATCHING
        PATTERN "*.hpp"
        PATTERN "*.h"
)

if(PFS_BUILD_DEV_TOOLS)
    install(TARGETS pfs_schema_gen pfs_dev_server
            RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

# -------------------------------------------------------------
#  CMake Package Configuration
# -------------------------------------------------------------
include(CMakePackageConfigHelpers)

set(PFS_VERSION 1.3.0)

write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/PaletteFluxCoreConfigVersion.cmake"
    VERSION     ${PFS_VERSION}
    COMPATIBILITY AnyNewerVersion
)

configure_package_config_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/PaletteFluxCoreConfig.cmake.in
    "${CMAKE_CURRENT_BINARY_DIR}/PaletteFluxCoreConfig.cmake"
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PaletteFluxCore
)

install(EXPORT PaletteFluxCoreTargets
        FILE    PaletteFluxCoreTargets.cmake
        NAMESPACE PaletteFlux::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PaletteFluxCore
)

install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/PaletteFluxCoreConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/PaletteFluxCoreConfigVersion.cmake"
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PaletteFluxCore
)

# -------------------------------------------------------------
#  Summary
# -------------------------------------------------------------
message(STATUS "PaletteFlux Studio Core will be built with:")
message(STATUS " • Warnings as Errors:  ${PFS_ENABLE_WARNINGS_AS_ERRORS}")
message(STATUS " • clang-tidy:          ${PFS_ENABLE_CLANG_TIDY}")
message(STATUS " • cppcheck:            ${PFS_ENABLE_CPPCHECK}")
message(STATUS " • Sanitizers:          ${PFS_ENABLE_SANITIZERS}")
message(STATUS " • Dev Tools:           ${PFS_BUILD_DEV_TOOLS}")
message(STATUS " • LTO Supported:       ${PFS_LTO_SUPPORTED}")
```
