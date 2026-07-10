# ==============================================================================
#  PulseSphere – Real-Time Social Pulse Streaming Platform
#  Enrichment Service :: Toxicity Score Plug-in
#  -------------------------------------------------------------------------
#  CMake build script
# ==============================================================================
#  This CMakeLists.txt builds the toxicity-score enrichment plug-in as either a
#  shared or static library and takes care of compiler flags, third-party
#  dependencies, LTO/IPO, unit-tests, and installation rules.
# ==============================================================================

cmake_minimum_required(VERSION 3.15 FATAL_ERROR)
project(ps_toxicity_score LANGUAGES C VERSION 1.2.0)

# ------------------------------------------------------------------------------
#  Build options
# ------------------------------------------------------------------------------
option(TOXICITY_SCORE_STATIC    "Build plugin as a static library"           OFF)
option(ENABLE_LTO               "Enable Link-Time Optimisation (IPO/LTO)"    ON)
option(ENABLE_TESTING           "Build unit tests for this plugin"           ON)
option(USE_TENSORFLOW_C         "Use TensorFlow C API for classification"    ON)

# ------------------------------------------------------------------------------
#  Compiler config
# ------------------------------------------------------------------------------
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Default to Release if nothing selected
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Common compiler warnings
set(PS_COMMON_COMPILE_FLAGS
    -Wall
    -Wextra
    -Wpedantic
    -Wformat=2
    -Wconversion
    -Wshadow
    -Werror=implicit-function-declaration
)

add_compile_options(${PS_COMMON_COMPILE_FLAGS})

# Debug vs Release specific flags
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options(-O0 -g3)
else()
    add_compile_options(-O3)
endif()

# ------------------------------------------------------------------------------
#  Source files
# ------------------------------------------------------------------------------
set(PLUGIN_PUBLIC_HEADERS
    include/toxicity_score.h
    include/toxic_language_model.h
)

set(PLUGIN_SOURCES
    src/toxicity_score.c
    src/toxic_language_model.c
    src/toxicity_score_plugin.c
)

# ------------------------------------------------------------------------------
#  Target definition
# ------------------------------------------------------------------------------
if(TOXICITY_SCORE_STATIC)
    add_library(ps_toxicity_score STATIC ${PLUGIN_SOURCES} ${PLUGIN_PUBLIC_HEADERS})
else()
    add_library(ps_toxicity_score SHARED ${PLUGIN_SOURCES} ${PLUGIN_PUBLIC_HEADERS})
endif()

add_library(PulseSphere::ToxicityScore ALIAS ps_toxicity_score)

# Public include directories
target_include_directories(ps_toxicity_score
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

# Version information
set_target_properties(ps_toxicity_score PROPERTIES
    VERSION     ${PROJECT_VERSION}
    SOVERSION   1
    OUTPUT_NAME "toxicity_score"
)

# ------------------------------------------------------------------------------
#  Third-party dependencies
# ------------------------------------------------------------------------------

# ---- Jansson (JSON parsing) ---------------------------------------------------
find_path(JANSSON_INCLUDE_DIR jansson.h)
find_library(JANSSON_LIBRARY   jansson)

if(JANSSON_INCLUDE_DIR AND JANSSON_LIBRARY)
    add_library(jansson::jansson UNKNOWN IMPORTED)
    set_target_properties(jansson::jansson PROPERTIES
        IMPORTED_LOCATION             "${JANSSON_LIBRARY}"
        INTERFACE_INCLUDE_DIRECTORIES "${JANSSON_INCLUDE_DIR}"
    )
else()
    message(FATAL_ERROR "Required dependency 'jansson' not found on system.")
endif()

# ---- Threads -----------------------------------------------------------------
find_package(Threads REQUIRED)

# ---- TensorFlow C (optional) --------------------------------------------------
if(USE_TENSORFLOW_C)
    find_package(TensorFlowC QUIET)
    if(TensorFlowC_FOUND)
        target_compile_definitions(ps_toxicity_score PRIVATE USE_TENSORFLOW_C)
        target_link_libraries(ps_toxicity_score PRIVATE TensorFlowC::TensorFlowC)
    else()
        message(WARNING "TensorFlow C API requested but not found, continuing without it.")
    endif()
endif()

# ---- PulseSphere Core API (interface library provided by root project) -------
# Expect PulseSphere::Core to be available from parent project; fail otherwise.
if(TARGET PulseSphere::Core)
    target_link_libraries(ps_toxicity_score PUBLIC PulseSphere::Core)
else()
    message(FATAL_ERROR "PulseSphere::Core target not found – ensure you are building within the PulseSphere super-build.")
endif()

# ---- Link other dependencies --------------------------------------------------
target_link_libraries(ps_toxicity_score
    PRIVATE
        jansson::jansson
        Threads::Threads
)

# ------------------------------------------------------------------------------
#  Link-Time Optimisation / IPO
# ------------------------------------------------------------------------------
if(ENABLE_LTO AND NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    include(CheckIPOSupported)
    check_ipo_supported(RESULT ipo_ok OUTPUT ipo_err)
    if(ipo_ok)
        set_property(TARGET ps_toxicity_score PROPERTY INTERPROCEDURAL_OPTIMIZATION TRUE)
    else()
        message(WARNING "IPO/LTO requested but not supported: ${ipo_err}")
    endif()
endif()

# ------------------------------------------------------------------------------
#  Installation
# ------------------------------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS ps_toxicity_score
        EXPORT  PulseSpherePluginTargets
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
)

install(DIRECTORY include/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
        FILES_MATCHING PATTERN "*.h"
)

install(EXPORT PulseSpherePluginTargets
        FILE PulseSpherePluginTargets.cmake
        NAMESPACE PulseSphere::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere
)

# ------------------------------------------------------------------------------
#  Unit tests
# ------------------------------------------------------------------------------
if(ENABLE_TESTING)
    enable_testing()
    add_subdirectory(test)
endif()

# ------------------------------------------------------------------------------
#  CPack (optional packaging support)
# ------------------------------------------------------------------------------
include(CPack)
set(CPACK_PACKAGE_NAME        "ps_toxicity_score")
set(CPACK_PACKAGE_VENDOR      "PulseSphere")
set(CPACK_PACKAGE_VERSION     ${PROJECT_VERSION})
set(CPACK_GENERATOR           "TGZ")
# (Further packager settings can be added if necessary)

# ==============================================================================