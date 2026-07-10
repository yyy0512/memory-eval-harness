# PulseSphere :: Event Fabric
#
# CMake build script for the "event_fabric" core library.  This component is
# responsible for the internal publish/subscribe event bus that glues together
# all PulseSphere micro-services running in a single process.  It offers:
#
#   • Zero-copy message dispatch
#   • Pluggable serializer / deserializer back-ends
#   • Runtime metrics & observability hooks
#   • Thread-safe and lock-free fast-path
#
# The library is designed to be embedded in both production binaries and unit
# test harnesses, so we expose an OBJECT library variant as well as SHARED /
# STATIC flavours.
#
# ---------------------------------------------------------------------------

cmake_minimum_required(VERSION 3.18)

# Defend against accidental direct invocation ---------------------------------
if(PROJECT_SOURCE_DIR STREQUAL CMAKE_SOURCE_DIR)
    message(FATAL_ERROR
        "\n\n✖ This CMakeLists.txt is a sub-module of the top-level PulseSphere "
        "build system.\n   Please configure from the repository root, e.g.:\n\n"
        "       mkdir -p build && cd build\n"
        "       cmake .. -DCMAKE_BUILD_TYPE=Release\n")
endif()

# ------------------------------------------------------------------------------
# Library Setup
# ------------------------------------------------------------------------------

set(EVENT_FABRIC_TARGET       event_fabric)
set(EVENT_FABRIC_VERSION      1.4.0)

file(GLOB_RECURSE EVENT_FABRIC_PUBLIC_HEADERS CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/include/pulsesphere/event_fabric/*.h")

file(GLOB_RECURSE EVENT_FABRIC_PRIVATE_HEADERS CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/src/*.h")

file(GLOB_RECURSE EVENT_FABRIC_SOURCES CONFIGURE_DEPENDS
     "${CMAKE_CURRENT_SOURCE_DIR}/src/*.c")

add_library(${EVENT_FABRIC_TARGET} SHARED
    ${EVENT_FABRIC_SOURCES}
    ${EVENT_FABRIC_PUBLIC_HEADERS}
    ${EVENT_FABRIC_PRIVATE_HEADERS})

add_library(${EVENT_FABRIC_TARGET}::shared ALIAS ${EVENT_FABRIC_TARGET})

# ------------------------------------------------------------------------------
# Build Options
# ------------------------------------------------------------------------------

target_compile_features(${EVENT_FABRIC_TARGET} PUBLIC c_std_11)

# General warnings
if (CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${EVENT_FABRIC_TARGET} PRIVATE
        -Wall -Wextra -Wpedantic -Werror
        -Wno-unused-parameter -Wstrict-prototypes
        $<$<CONFIG:Debug>:-Og -g3>)
elseif (MSVC)
    target_compile_options(${EVENT_FABRIC_TARGET} PRIVATE
        /W4 /wd4201 /permissive-)
endif()

# Enable position-independent code for static builds
set_target_properties(${EVENT_FABRIC_TARGET} PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    VERSION              ${EVENT_FABRIC_VERSION}
    SOVERSION            1
    OUTPUT_NAME          pulsesphere_event_fabric)

# Enable LTO if requested
option(EVENT_FABRIC_ENABLE_LTO "Enable Link-Time Optimization" ON)
if(EVENT_FABRIC_ENABLE_LTO AND NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    include(CheckIPOSupported)
    check_ipo_supported(RESULT ipo_supported OUTPUT ipo_error)
    if(ipo_supported)
        set_target_properties(${EVENT_FABRIC_TARGET} PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)
    else()
        message(WARNING "IPO/LTO not supported: ${ipo_error}")
    endif()
endif()

# ------------------------------------------------------------------------------
# Include Paths & Public Interface
# ------------------------------------------------------------------------------

target_include_directories(${EVENT_FABRIC_TARGET}
    PUBLIC
        "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>"
        "$<INSTALL_INTERFACE:include>"
    PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/src")

# Public dependencies ----------------------------------------------------------
# (Other PulseSphere sub-libraries are pulled in as INTERFACE to avoid circular
#  dependencies at link time.)

add_library(pulsesphere::core INTERFACE IMPORTED)   # placeholder for actual core lib
target_link_libraries(${EVENT_FABRIC_TARGET}
    PUBLIC  pulsesphere::core
    PRIVATE Threads::Threads)

# Threads ----------------------------------------------------------------------
find_package(Threads REQUIRED)

# ------------------------------------------------------------------------------
# Sanitizers (Debug only)
# ------------------------------------------------------------------------------

option(EVENT_FABRIC_ENABLE_SANITIZERS "Build with Address/UB sanitizers" ON)
if(EVENT_FABRIC_ENABLE_SANITIZERS AND CMAKE_BUILD_TYPE STREQUAL "Debug")
    if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${EVENT_FABRIC_TARGET} PRIVATE -fsanitize=address,undefined)
        target_link_options(${EVENT_FABRIC_TARGET}    PRIVATE -fsanitize=address,undefined)
    endif()
endif()

# ------------------------------------------------------------------------------
# Installation Rules
# ------------------------------------------------------------------------------

include(GNUInstallDirs)

install(TARGETS ${EVENT_FABRIC_TARGET}
    EXPORT  PulseSphereTargets
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

install(DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/include/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
        FILES_MATCHING PATTERN "*.h")

# ------------------------------------------------------------------------------
# Export & Package Config
# ------------------------------------------------------------------------------

install(EXPORT PulseSphereTargets
    FILE PulseSphereTargets.cmake
    NAMESPACE pulsesphere::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere)

include(CMakePackageConfigHelpers)

configure_package_config_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/PulseSphereConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere
    NO_SET_AND_CHECK_MACRO
    NO_CHECK_REQUIRED_COMPONENTS_MACRO)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfigVersion.cmake
    VERSION ${EVENT_FABRIC_VERSION}
    COMPATIBILITY SameMajorVersion)

install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfig.cmake
    ${CMAKE_CURRENT_BINARY_DIR}/PulseSphereConfigVersion.cmake
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere)

# ------------------------------------------------------------------------------
# Unit Tests
# ------------------------------------------------------------------------------

option(EVENT_FABRIC_BUILD_TESTS "Build event_fabric unit tests." ON)
if(EVENT_FABRIC_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# ------------------------------------------------------------------------------
# Automatic source export for IDEs
# ------------------------------------------------------------------------------

set_property(TARGET ${EVENT_FABRIC_TARGET} PROPERTY VS_GLOBAL_VcpkgEnabled FALSE)

# End of CMakeLists.txt ---------------------------------------------------------