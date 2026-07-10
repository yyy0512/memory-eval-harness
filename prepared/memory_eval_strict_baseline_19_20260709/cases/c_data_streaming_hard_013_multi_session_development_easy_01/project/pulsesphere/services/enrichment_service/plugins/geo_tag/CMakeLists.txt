# Pulsesphere - Geo-Tag Enrichment Plug-in
# CMake build script
#
# This CMakeLists.txt builds the Geo-Tag plug-in as a shared library that can
# be loaded at run-time by the enrichment_service.  The plug-in uses the
# libmaxminddb (or optionally legacy GeoIP) API to look up country / region /
# city information based on IPv4/IPv6 addresses contained in incoming pulse
# events.
#
# ────────────────────────────────────────────────────────────────────────────────
#  Expected directory structure
#
#  plugins/geo_tag
#  ├── CMakeLists.txt          <-- (this file)
#  ├── geo_tag.c
#  ├── geo_tag.h
#  └── geo_tag_internal.h
#
# ────────────────────────────────────────────────────────────────────────────────
cmake_minimum_required(VERSION 3.15)

# ------------------------------------------------------------------------------
# Project metadata
# ------------------------------------------------------------------------------
project(geo_tag_plugin
        VERSION 1.3.0
        LANGUAGES C)

# ------------------------------------------------------------------------------
# User-configurable options
# ------------------------------------------------------------------------------
# Allow users to force the use of the legacy GeoIP C API when libmaxminddb
# is unavailable or undesired.
option(GEO_TAG_USE_GEOIP_LEGACY "Build geo-tag plug-in using the legacy GeoIP C API instead of libmaxminddb" OFF)

# ------------------------------------------------------------------------------
# Dependencies
# ------------------------------------------------------------------------------
include(CheckIncludeFile)
include(CMakeDependentOption)
include(GNUInstallDirs)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")

if (NOT GEO_TAG_USE_GEOIP_LEGACY)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(MAXMINDDB QUIET libmaxminddb)

    if (MAXMINDDB_FOUND)
        message(STATUS "Using libmaxminddb ${MAXMINDDB_VERSION} for geo-tag plug-in.")
        add_library(maxminddb::maxminddb UNKNOWN IMPORTED)
        set_target_properties(maxminddb::maxminddb PROPERTIES
            IMPORTED_LOCATION "${MAXMINDDB_LIBDIR}/libmaxminddb${CMAKE_SHARED_LIBRARY_SUFFIX}"
            INTERFACE_INCLUDE_DIRECTORIES "${MAXMINDDB_INCLUDEDIR}"
        )
    else()
        message(WARNING "libmaxminddb not found, falling back to legacy GeoIP C API.")
        set(GEO_TAG_USE_GEOIP_LEGACY ON CACHE BOOL "" FORCE)
    endif()
endif()

if (GEO_TAG_USE_GEOIP_LEGACY)
    find_path(GEOIP_INCLUDE_DIR NAMES GeoIP.h PATH_SUFFIXES geoip)
    find_library(GEOIP_LIBRARY  NAMES GeoIP)

    if (NOT GEOIP_INCLUDE_DIR OR NOT GEOIP_LIBRARY)
        message(FATAL_ERROR "Legacy GeoIP library requested but not found. "
                            "Install libgeoip-dev (Debian/Ubuntu) or geoip-devel (RHEL/Fedora).")
    endif()
    message(STATUS "Using legacy GeoIP C API for geo-tag plug-in.")
endif()

# ------------------------------------------------------------------------------
# Source files
# ------------------------------------------------------------------------------
set(PLUGINSRC
    geo_tag.c
    geo_tag_internal.h
    geo_tag.h
)

# ------------------------------------------------------------------------------
# Build the shared library
# ------------------------------------------------------------------------------
add_library(${PROJECT_NAME} SHARED ${PLUGINSRC})

# Generate a compile-time definition so source code can #ifdef around it.
if (GEO_TAG_USE_GEOIP_LEGACY)
    target_compile_definitions(${PROJECT_NAME} PRIVATE USE_GEOIP_LEGACY=1)
else()
    target_compile_definitions(${PROJECT_NAME} PRIVATE USE_MAXMIND_DB=1)
endif()

target_compile_features(${PROJECT_NAME} PRIVATE c_std_99)

# Strict compiler settings (can be relaxed with -DRELAX_COMPILER=ON)
option(RELAX_COMPILER "Disable -Werror and other strict compiler flags" OFF)
if (NOT RELAX_COMPILER)
    if (CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${PROJECT_NAME} PRIVATE
            -Wall -Wextra -Wpedantic -Wconversion -Werror
        )
    endif()
endif()

# Position-independent code is required for shared libraries.
set_target_properties(${PROJECT_NAME} PROPERTIES POSITION_INDEPENDENT_CODE ON)

# Link libraries
if (GEO_TAG_USE_GEOIP_LEGACY)
    target_include_directories(${PROJECT_NAME} PRIVATE ${GEOIP_INCLUDE_DIR})
    target_link_libraries(${PROJECT_NAME} PRIVATE ${GEOIP_LIBRARY})
else()
    target_link_libraries(${PROJECT_NAME} PRIVATE maxminddb::maxminddb)
endif()

# ------------------------------------------------------------------------------
# Installation
# ------------------------------------------------------------------------------
# Plug-ins are installed into  ${CMAKE_INSTALL_LIBDIR}/pulsesphere/plugins
set(PLUGIN_INSTALL_DIR "${CMAKE_INSTALL_LIBDIR}/pulsesphere/plugins" CACHE PATH
    "Directory where PulseSphere enrichment plug-ins are installed.")

install(TARGETS ${PROJECT_NAME}
        LIBRARY DESTINATION ${PLUGIN_INSTALL_DIR}
        PUBLIC_HEADER DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/plugins/geo_tag)

# ------------------------------------------------------------------------------
# Testing (optional)
# ------------------------------------------------------------------------------
option(BUILD_GEO_TAG_TESTS "Build geo-tag unit tests (requires Check)" OFF)

if (BUILD_GEO_TAG_TESTS)
    enable_testing()
    find_package(Check REQUIRED)

    add_executable(test_geo_tag tests/test_geo_tag.c)
    target_link_libraries(test_geo_tag PRIVATE ${PROJECT_NAME} Check::check)
    add_test(NAME geo_tag_unit COMMAND test_geo_tag)
endif()

# ------------------------------------------------------------------------------
# Packaging
# ------------------------------------------------------------------------------
include(CPack)

set(CPACK_PACKAGE_NAME         "pulsesphere-geo-tag-plugin")
set(CPACK_PACKAGE_VENDOR       "PulseSphere, Inc.")
set(CPACK_PACKAGE_DESCRIPTION  "Geo-IP enrichment plug-in for PulseSphere data-streaming platform")
set(CPACK_PACKAGE_VERSION      ${PROJECT_VERSION})
set(CPACK_PACKAGE_CONTACT      "opensource@pulsesphere.io")

# Distribute only runtime artifacts.
set(CPACK_COMPONENTS_ALL Runtime)

cpack_add_component(Runtime
    DISPLAY_NAME "Geo-Tag Plug-in Runtime"
    DESCRIPTION  "Shared library and resources required for geo-tag enrichment."
    REQUIRED)

message(STATUS "Geo-tag plug-in configuration complete: "
               "USE_GEOIP_LEGACY=${GEO_TAG_USE_GEOIP_LEGACY}  "
               "PLUGIN_INSTALL_DIR=${PLUGIN_INSTALL_DIR}")