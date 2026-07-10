cmake_minimum_required(VERSION 3.16)

# =========================================================
#  PulseSphere: Real-Time Social Pulse Streaming Platform
#  CMake top-level build configuration
# =========================================================
#
#  This CMakeLists.txt orchestrates the build of the core
#  PulseSphere runtime, optional plug-ins, unit/integration
#  tests, and developer tooling such as clang-tidy static
#  analysis and code coverage instrumentation.
#
#  Key highlights:
#   • C11 is enforced for all compilation units
#   • Strict warnings are enabled and optionally promoted
#     to build-breaking errors
#   • External dependencies (OpenSSL, ZSTD, libuv, etc.)
#     are discovered via find_package()
#   • Sanitizers (ASan, UBSan, TSAN) and coverage can be
#     toggled with simple CMake options
#   • Out-of-source builds, RPATH correctness, and proper
#     install rules are provided
#
# =========================================================

# ---------------------------------------------------------
#  Project metadata
# ---------------------------------------------------------
project(PulseSphere
        VERSION 1.0.0
        DESCRIPTION "High-throughput streaming engine for social pulse events"
        LANGUAGES C)

# ---------------------------------------------------------
#  Build options
# ---------------------------------------------------------
option(PULSESPHERE_BUILD_SHARED          "Build shared library instead of static"          ON)
option(PULSESPHERE_ENABLE_SANITIZERS     "Enable Address/UB/Thread sanitizers"             OFF)
option(PULSESPHERE_WARNINGS_AS_ERRORS    "Treat compiler warnings as errors"               ON)
option(PULSESPHERE_ENABLE_COVERAGE       "Enable code coverage flags"                      OFF)
option(PULSESPHERE_CLANG_TIDY            "Run clang-tidy static analysis during build"     OFF)
option(PULSESPHERE_BUILD_TESTS           "Compile unit and integration tests"              ON)
option(PULSESPHERE_BUILD_EXAMPLES        "Compile example applications"                    ON)
option(PULSESPHERE_BUILD_PLUGINS         "Build optional runtime plug-ins"                 ON)

# ---------------------------------------------------------
#  Toolchain checks
# ---------------------------------------------------------
if (NOT CMAKE_C_STANDARD)
    set(CMAKE_C_STANDARD 11)
endif()
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

# ---------------------------------------------------------
#  Compiler flags
# ---------------------------------------------------------
include(CheckCCompilerFlag)

set(PULSESPHERE_BASE_FLAGS
    "-Wall" "-Wextra" "-Wpedantic"
    "-Wcast-align" "-Wpointer-arith" "-Wwrite-strings"
    "-Wmissing-declarations" "-Wmissing-prototypes"
    "-Wstrict-prototypes" "-Wformat=2")

foreach(flag IN LISTS PULSESPHERE_BASE_FLAGS)
    check_c_compiler_flag(${flag} _supported)
    if (_supported)
        add_compile_options($<$<COMPILE_LANGUAGE:C>:${flag}>)
    endif()
endforeach()

if (PULSESPHERE_WARNINGS_AS_ERRORS)
    add_compile_options($<$<COMPILE_LANGUAGE:C>:-Werror>)
endif()

# ---------------------------------------------------------
#  Sanitizers
# ---------------------------------------------------------
if (PULSESPHERE_ENABLE_SANITIZERS AND NOT MSVC)
    set(SAN_FLAGS "-fsanitize=address,undefined,thread")
    add_compile_options(${SAN_FLAGS})
    add_link_options(${SAN_FLAGS})
endif()

# ---------------------------------------------------------
#  Coverage
# ---------------------------------------------------------
if (PULSESPHERE_ENABLE_COVERAGE AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    add_compile_options(--coverage -O0)
    add_link_options(--coverage)
endif()

# ---------------------------------------------------------
#  clang-tidy
# ---------------------------------------------------------
if (PULSESPHERE_CLANG_TIDY)
    find_program(CLANG_TIDY_EXE NAMES clang-tidy)
    if (CLANG_TIDY_EXE)
        set(CMAKE_C_CLANG_TIDY "${CLANG_TIDY_EXE};-warnings-as-errors=*")
    else()
        message(WARNING "clang-tidy requested but not found")
    endif()
endif()

# ---------------------------------------------------------
#  External dependencies
# ---------------------------------------------------------
find_package(Threads          REQUIRED)
find_package(OpenSSL          REQUIRED)
find_package(ZLIB             REQUIRED)
find_package(PkgConfig        REQUIRED)

pkg_check_modules(LIBUV       REQUIRED libuv)
pkg_check_modules(ZSTD        REQUIRED libzstd)

# ---------------------------------------------------------
#  Include directories
# ---------------------------------------------------------
include_directories(
    ${PROJECT_SOURCE_DIR}/include
    ${LIBUV_INCLUDE_DIRS}
    ${ZSTD_INCLUDE_DIRS}
    ${OPENSSL_INCLUDE_DIR}
    ${ZLIB_INCLUDE_DIRS}
)

# ---------------------------------------------------------
#  Source files
# ---------------------------------------------------------
file(GLOB_RECURSE PULSESPHERE_SRC
    CONFIGURE_DEPENDS
    "${PROJECT_SOURCE_DIR}/src/core/*.c"
    "${PROJECT_SOURCE_DIR}/src/utils/*.c"
    "${PROJECT_SOURCE_DIR}/src/io/*.c"
    "${PROJECT_SOURCE_DIR}/src/stream/*.c"
)

# ---------------------------------------------------------
#  Build library
# ---------------------------------------------------------
set(LIB_TYPE STATIC)
if (PULSESPHERE_BUILD_SHARED)
    set(LIB_TYPE SHARED)
    add_definitions(-DPULSESPHERE_SHARED)
endif()

add_library(pulsesphere ${LIB_TYPE} ${PULSESPHERE_SRC})

target_link_libraries(pulsesphere
    PUBLIC
        Threads::Threads
        OpenSSL::SSL
        OpenSSL::Crypto
        ZLIB::ZLIB
        ${LIBUV_LIBRARIES}
        ${ZSTD_LIBRARIES}
)

target_include_directories(pulsesphere
    PUBLIC
        $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

set_target_properties(pulsesphere PROPERTIES
    VERSION      ${PROJECT_VERSION}
    SOVERSION    1
    C_VISIBILITY_PRESET hidden
    POSITION_INDEPENDENT_CODE ON
)

# ---------------------------------------------------------
#  Plug-ins
# ---------------------------------------------------------
if (PULSESPHERE_BUILD_PLUGINS)
    add_subdirectory(plugins)
endif()

# ---------------------------------------------------------
#  Example apps
# ---------------------------------------------------------
if (PULSESPHERE_BUILD_EXAMPLES)
    add_subdirectory(examples)
endif()

# ---------------------------------------------------------
#  Tests
# ---------------------------------------------------------
if (PULSESPHERE_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# ---------------------------------------------------------
#  Installation
# ---------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS pulsesphere
        EXPORT   PulseSphereTargets
        RUNTIME  DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY  DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE  DESTINATION ${CMAKE_INSTALL_LIBDIR})

install(DIRECTORY include/ DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

# Generate and install CMake package config files
include(CMakePackageConfigHelpers)
write_basic_package_version_file(
    "${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfigVersion.cmake"
    VERSION       ${PROJECT_VERSION}
    COMPATIBILITY AnyNewerVersion)

configure_package_config_file(
    "${CMAKE_CURRENT_LIST_DIR}/cmake/PulseSphereConfig.cmake.in"
    "${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfig.cmake"
    INSTALL_DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere")

install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfig.cmake"
    "${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfigVersion.cmake"
    DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere")

install(EXPORT PulseSphereTargets
        FILE   PulseSphereTargets.cmake
        NAMESPACE PulseSphere::
        DESTINATION "${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere")

# ---------------------------------------------------------
#  Packaging (CPack)
# ---------------------------------------------------------
include(CPack)
set(CPACK_PACKAGE_NAME               "PulseSphere")
set(CPACK_PACKAGE_VENDOR             "PulseSphere OSS")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Real-Time Social Pulse Streaming Platform")
set(CPACK_PACKAGE_VERSION            ${PROJECT_VERSION})
set(CPACK_PACKAGE_CONTACT            "dev@pulsesphere.io")
set(CPACK_RESOURCE_FILE_LICENSE      "${PROJECT_SOURCE_DIR}/LICENSE")
set(CPACK_RESOURCE_FILE_README       "${PROJECT_SOURCE_DIR}/README.md")

# ---------------------------------------------------------
#  Developer output
# ---------------------------------------------------------
message(STATUS "PulseSphere ${PROJECT_VERSION}")
message(STATUS "  Build type                : ${CMAKE_BUILD_TYPE}")
message(STATUS "  Install prefix            : ${CMAKE_INSTALL_PREFIX}")
message(STATUS "  Shared library            : ${PULSESPHERE_BUILD_SHARED}")
message(STATUS "  Sanitizers                : ${PULSESPHERE_ENABLE_SANITIZERS}")
message(STATUS "  Coverage                  : ${PULSESPHERE_ENABLE_COVERAGE}")
message(STATUS "  clang-tidy                : ${PULSESPHERE_CLANG_TIDY}")
message(STATUS "  Build tests               : ${PULSESPHERE_BUILD_TESTS}")
message(STATUS "  Build plug-ins            : ${PULSESPHERE_BUILD_PLUGINS}")
message(STATUS "  Build examples            : ${PULSESPHERE_BUILD_EXAMPLES}")