cmake_minimum_required(VERSION 3.16)

# -----------------------------------------------------------------------------
#  PulseSphere :: lib/common
#
#  Purpose:
#    Build and export the reusable "pulsesphere_common" component that provides
#    low-level utilities (logging, time-keeping, thread primitives, config
#    helpers, etc.) to every other PulseSphere service or plug-in.
#
#  Design goals:
#    * Modern, target-based CMake (>=3.16)
#    * Isolate compile options per-target
#    * Facilitate static or shared build via an opt-in switch
#    * Expose PUBLIC compile definitions/imported libs (pthread, rt, m, dl)
#    * Enable sanitizers & coverage in developer builds
#    * Allow installation & export of CMake package for downstream consumers
# -----------------------------------------------------------------------------

# =============================================================================
#  Build options
# =============================================================================
option(PULSES_COMMON_SHARED            "Build common library as shared"          ON)
option(PULSES_COMMON_ENABLE_SANITIZERS "Enable Address/Undefined sanitizers"     OFF)
option(PULSES_COMMON_ENABLE_COVERAGE   "Enable code-coverage instrumentation"    OFF)
option(PULSES_COMMON_STRICT_COMPILE    "Treat warnings as errors"                ON)

# =============================================================================
#  Library target
# =============================================================================
add_library(pulsesphere_common
    ${PULSES_COMMON_SHARED}  # STATIC or SHARED
    # -------------------------------------------------------------------------
    # NOTE: Keep this list alphabetically sorted for maintainability.
    # -------------------------------------------------------------------------
    src/ps_assert.c
    src/ps_config.c
    src/ps_hash.c
    src/ps_logging.c
    src/ps_memory.c
    src/ps_metrics.c
    src/ps_spinlock.c
    src/ps_string.c
    src/ps_thread.c
    src/ps_time.c
)

# -----------------------------------------------------------------------------
#  Versioning
# -----------------------------------------------------------------------------
set_target_properties(pulsesphere_common PROPERTIES
    VERSION     1.1.0
    SOVERSION   1
    C_STANDARD  17
    C_STANDARD_REQUIRED YES
    C_EXTENSIONS NO
    POSITION_INDEPENDENT_CODE ON
)

# =============================================================================
#  Include directories
# =============================================================================
target_include_directories(pulsesphere_common
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

# =============================================================================
#  Platform-specific libraries
# =============================================================================
find_package(Threads REQUIRED)

# "rt" is required for clock_gettime() on old glibc; ignore on platforms that
# do not expose it (e.g., macOS)
include(CheckLibraryExists)
check_library_exists(rt clock_gettime "" HAVE_LIBRT)
if (HAVE_LIBRT)
    set(REALTIME_LIB rt)
endif()

find_library(DL_LIB dl)
if (DL_LIB)
    set(DL_LIB dl)
endif()

target_link_libraries(pulsesphere_common
    PUBLIC
        Threads::Threads
        ${REALTIME_LIB}
        ${DL_LIB}
        m                                           # libm for math helpers
)

# =============================================================================
#  Compile & link options
# =============================================================================
# Helper macro to replicate the same warnings across compilers
function(ps_enable_warnings TARGET)
    if (MSVC)
        target_compile_options(${TARGET} PRIVATE /W4)
    else()
        target_compile_options(${TARGET} PRIVATE
            -Wall -Wextra -Wpedantic
            -Wconversion -Wsign-conversion
            -Wformat=2 -Wformat-security
            -Wno-unused-parameter
        )
    endif()
endfunction()

ps_enable_warnings(pulsesphere_common)

if (PULSES_COMMON_STRICT_COMPILE AND NOT MSVC)
    target_compile_options(pulsesphere_common PRIVATE -Werror)
endif()

# -----------------------------------------------------------------------------
#  Sanitizers
# -----------------------------------------------------------------------------
if (PULSES_COMMON_ENABLE_SANITIZERS AND NOT MSVC)
    message(STATUS "Building PulseSphere Common with sanitizers enabled")
    target_compile_options(pulsesphere_common
        PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer
    )
    target_link_options(pulsesphere_common
        PUBLIC -fsanitize=address,undefined -fno-omit-frame-pointer
    )
endif()

# -----------------------------------------------------------------------------
#  Coverage
# -----------------------------------------------------------------------------
if (PULSES_COMMON_ENABLE_COVERAGE AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    message(STATUS "Building PulseSphere Common with coverage flags")
    target_compile_options(pulsesphere_common PUBLIC -O0 --coverage)
    target_link_options   (pulsesphere_common PUBLIC --coverage)
endif()

# =============================================================================
#  Installation
# =============================================================================
include(GNUInstallDirs)

install(TARGETS pulsesphere_common
    EXPORT  PulseSphereCommonTargets
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}  COMPONENT runtime
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}  COMPONENT runtime
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}  COMPONENT development
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
)

install(
    DIRECTORY include/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
    COMPONENT  development
)

# -----------------------------------------------------------------------------
#  Export CMake package for find_package()
# -----------------------------------------------------------------------------
install(EXPORT PulseSphereCommonTargets
    FILE       PulseSphereCommonTargets.cmake
    NAMESPACE  PulseSphere::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphereCommon
)

include(CMakePackageConfigHelpers)
configure_package_config_file(
    ${CMAKE_CURRENT_LIST_DIR}/cmake/PulseSphereCommonConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereCommonConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphereCommon
    NO_SET_AND_CHECK_MACRO
    NO_CHECK_REQUIRED_COMPONENTS_MACRO
)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereCommonConfigVersion.cmake
    VERSION 1.1.0
    COMPATIBILITY SameMajorVersion
)

install(
    FILES
        ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereCommonConfig.cmake
        ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereCommonConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphereCommon
)

# =============================================================================
#  ctest / unit tests hook (optional)
# =============================================================================
if (PROJECT_IS_TOP_LEVEL AND BUILD_TESTING)
    enable_testing()
    add_subdirectory(test)
endif()

# =============================================================================
#  Summary
# =============================================================================
message(STATUS "PulseSphere Common configured:")
message(STATUS "  Build type                : ${CMAKE_BUILD_TYPE}")
message(STATUS "  Build shared libs         : ${PULSES_COMMON_SHARED}")
message(STATUS "  Enable sanitizers         : ${PULSES_COMMON_ENABLE_SANITIZERS}")
message(STATUS "  Enable coverage           : ${PULSES_COMMON_ENABLE_COVERAGE}")
message(STATUS "  Strict compile (-Werror)  : ${PULSES_COMMON_STRICT_COMPILE}")