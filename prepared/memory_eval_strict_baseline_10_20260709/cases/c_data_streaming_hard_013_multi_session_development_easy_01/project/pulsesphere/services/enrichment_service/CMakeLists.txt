cmake_minimum_required(VERSION 3.20)

#
# PulseSphere – Enrichment Service
# =================================
# Build configuration for the “Enrichment” micro-service responsible for
# geo-tagging, language detection, toxicity scoring, and custom strategy plugins.
#

project(pulsesphere_enrichment_service
        VERSION 1.3.0
        DESCRIPTION "PulseSphere Enrichment Micro-Service"
        LANGUAGES C)

include(GNUInstallDirs)
include(CMakePackageConfigHelpers)
include(CTest)

# ---------------------------------------------------------------------------
# User-visible build options
# ---------------------------------------------------------------------------
option(ENABLE_LTO           "Enable Link-Time Optimization (IPO)"              ON)
option(ENABLE_SANITIZERS    "Enable Address/UB sanitizers (Debug only)"        OFF)
option(ENABLE_COVERAGE      "Enable GCov/LCOV coverage flags (Debug only)"     OFF)
option(ENRICHMENT_PLUGINS   "Build enrichment plugins (shared objects)"        ON)

# ---------------------------------------------------------------------------
# Global language settings
# ---------------------------------------------------------------------------
set(C_STANDARD 11)
set(CMAKE_C_STANDARD         ${C_STANDARD})
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS        OFF)

# ---------------------------------------------------------------------------
# Compiler warnings + security hardening
# ---------------------------------------------------------------------------
if(MSVC)
    add_compile_options(/W4 /WX /Zi)
else()
    add_compile_options(
        -Wall -Wextra -pedantic
        -Werror              # Treat warnings as errors
        -fno-strict-aliasing # Safer optimisation
        -fstack-protector-strong
    )

    if(ENABLE_SANITIZERS AND CMAKE_BUILD_TYPE STREQUAL "Debug")
        add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
        add_link_options    (-fsanitize=address,undefined)
    endif()

    if(ENABLE_COVERAGE AND CMAKE_BUILD_TYPE STREQUAL "Debug")
        add_compile_options(--coverage -O0)
        add_link_options    (--coverage)
    endif()
endif()

# ---------------------------------------------------------------------------
# Link-Time Optimisation (IPO)
# ---------------------------------------------------------------------------
if(ENABLE_LTO)
    include(CheckIPOSupported)
    check_ipo_supported(RESULT LTO_SUPPORTED OUTPUT LTO_ERROR)
    if(LTO_SUPPORTED)
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION TRUE)
        message(STATUS "IPO/LTO enabled")
    else()
        message(WARNING "IPO/LTO requested but not supported: ${LTO_ERROR}")
    endif()
endif()

# ---------------------------------------------------------------------------
# External dependencies
# ---------------------------------------------------------------------------
find_package(Threads REQUIRED)
find_package(ZLIB         REQUIRED)
find_package(ProtobufC    REQUIRED)         # Protocol-Buffers-C for schema
find_package(PkgConfig    REQUIRED)

# -- pkg-config based look-ups
pkg_check_modules(JANSSON   REQUIRED jansson>=2.13)   # JSON parsing
pkg_check_modules(UTF8PROC  REQUIRED utf8proc)        # Unicode utilities

# ---------------------------------------------------------------------------
# Internal PulseSphere core libraries (pre-built or sibling CMake projects)
# ---------------------------------------------------------------------------
# When building the entire monorepo these targets might already exist.
# Fallback to find_library to permit standalone builds for the service.
#
#   pulsesphere_core         – Core utilities (logging, configuration, etc.)
#   pulsesphere_event_bus    – High-performance zero-copy event bus
#
if(NOT TARGET pulsesphere_core)
    list(APPEND CMAKE_PREFIX_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../../core/build")
    find_library(PULSES_CORE_LIB  pulsesphere_core   REQUIRED)
else()
    set(PULSES_CORE_LIB pulsesphere_core)
endif()

if(NOT TARGET pulsesphere_event_bus)
    list(APPEND CMAKE_PREFIX_PATH "${CMAKE_CURRENT_SOURCE_DIR}/../../event_bus/build")
    find_library(EVENT_BUS_LIB    pulsesphere_event_bus REQUIRED)
else()
    set(EVENT_BUS_LIB pulsesphere_event_bus)
endif()

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
file(GLOB_RECURSE ENRICHMENT_SOURCES CONFIGURE_DEPENDS
     "src/*.c"
     "include/*.h")

add_library(pulsesphere_enrichment STATIC ${ENRICHMENT_SOURCES})

target_include_directories(pulsesphere_enrichment
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${JANSSON_INCLUDE_DIRS}
        ${UTF8PROC_INCLUDE_DIRS}
        ${ZLIB_INCLUDE_DIRS}
        ${ProtobufC_INCLUDE_DIRS}
)

target_link_libraries(pulsesphere_enrichment
    PUBLIC
        ${PULSES_CORE_LIB}
        ${EVENT_BUS_LIB}
        Threads::Threads
    PRIVATE
        ${JANSSON_LIBRARIES}
        ${UTF8PROC_LIBRARIES}
        ${ZLIB_LIBRARIES}
        ${ProtobufC_LIBRARIES}
)

target_compile_definitions(pulsesphere_enrichment
    PRIVATE
        $<$<BOOL:${ENABLE_COVERAGE}>:ENABLE_COVERAGE>
        $<$<CONFIG:Debug>:DEBUG_BUILD>
)

set_target_properties(pulsesphere_enrichment PROPERTIES
    VERSION   ${PROJECT_VERSION}
    SOVERSION 1
    PUBLIC_HEADER "include/enrichment_service.h"
)

# ---------------------------------------------------------------------------
# Optional plugin framework
# ---------------------------------------------------------------------------
if(ENRICHMENT_PLUGINS)
    add_subdirectory(plugins)
endif()

# ---------------------------------------------------------------------------
# Service daemon executable (systemd-ready)
# ---------------------------------------------------------------------------
add_executable(enrichment_service_daemon
               service/main.c)

target_link_libraries(enrichment_service_daemon PRIVATE
                      pulsesphere_enrichment)

install(TARGETS enrichment_service_daemon
        RUNTIME DESTINATION ${CMAKE_INSTALL_SBINDIR})

# ---------------------------------------------------------------------------
# Installation & Packaging
# ---------------------------------------------------------------------------
install(TARGETS pulsesphere_enrichment
        EXPORT  pulsesphere_enrichmentTargets
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        PUBLIC_HEADER DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/enrichment)

install(EXPORT pulsesphere_enrichmentTargets
        FILE pulsesphere_enrichmentTargets.cmake
        NAMESPACE pulsesphere::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/pulsesphere_enrichment)

configure_package_config_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/pulsesphere_enrichmentConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/pulsesphere_enrichmentConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/pulsesphere_enrichment
)

install(FILES
    "${CMAKE_CURRENT_BINARY_DIR}/pulsesphere_enrichmentConfig.cmake"
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/pulsesphere_enrichment)

# ---------------------------------------------------------------------------
# Unit/Integration tests
# ---------------------------------------------------------------------------
if(BUILD_TESTING)
    enable_testing()
    add_subdirectory(test)
endif()

message(STATUS "PulseSphere Enrichment Service — configuration complete.")