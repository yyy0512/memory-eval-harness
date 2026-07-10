cmake_minimum_required(VERSION 3.16)

#
# PulseSphere – Language Detection Plugin
# ---------------------------------------
# Builds the language detection enrichment plug-in as a shared library that can
# be hot-swapped at runtime by the enrichment service.  The plug-in optionally
# links against ICU (Unicode handling) and CLD2 (statistical language model).
#

project(pulse_language_detect_plugin LANGUAGES C)

# --------------------------------------------------------------------------
# Sources
# --------------------------------------------------------------------------
add_library(language_detect SHARED
    src/language_detect.c
    src/language_model.c
    src/unicode_utils.c
)

add_library(PulseSphere::LanguageDetect ALIAS language_detect)

# --------------------------------------------------------------------------
# Compile options & properties
# --------------------------------------------------------------------------
target_compile_features(language_detect PRIVATE c_std_11)

target_compile_options(language_detect PRIVATE
    -Wall
    -Wextra
    -Wpedantic
    $<$<CONFIG:Release>:-O3>
)

set_target_properties(language_detect PROPERTIES
    POSITION_INDEPENDENT_CODE ON
    OUTPUT_NAME              language_detect
    VERSION                  1.0.0
    SOVERSION                1
)

# --------------------------------------------------------------------------
# Include directories
# --------------------------------------------------------------------------
target_include_directories(language_detect
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
)

# --------------------------------------------------------------------------
# External dependencies
# --------------------------------------------------------------------------
# ICU – International Components for Unicode
find_package(ICU REQUIRED COMPONENTS uc i18n data)
if(ICU_FOUND)
    target_link_libraries(language_detect PRIVATE ICU::uc ICU::i18n ICU::data)
    target_compile_definitions(language_detect PRIVATE HAS_ICU=1)
endif()

# CLD2 – Compact Language Detector v2 (optional)
find_path(CLD2_INCLUDE_DIR NAMES public/compact_lang_det.h)
find_library(CLD2_LIBRARY   NAMES cld2 cld2_static)

if(CLD2_INCLUDE_DIR AND CLD2_LIBRARY)
    message(STATUS "CLD2 detected: ${CLD2_LIBRARY}")
    target_include_directories(language_detect PRIVATE ${CLD2_INCLUDE_DIR})
    target_link_libraries(language_detect  PRIVATE ${CLD2_LIBRARY})
    target_compile_definitions(language_detect PRIVATE HAS_CLD2=1)
else()
    message(WARNING "CLD2 not found – falling back to internal n-gram heuristics.")
    target_compile_definitions(language_detect PRIVATE NO_CLD2=1)
endif()

# --------------------------------------------------------------------------
# Installation
# --------------------------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS language_detect
    EXPORT      PulseSpherePlugins
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}/pulsesphere/plugins
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}        # Windows
)

install(DIRECTORY include/
    DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/plugins/language_detect
)

# Export targets for find_package()
install(EXPORT PulseSpherePlugins
    FILE       PulseSpherePlugins.cmake
    NAMESPACE  PulseSphere::
    DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/PulseSphere
)

# --------------------------------------------------------------------------
# Testing
# --------------------------------------------------------------------------
option(ENABLE_LANGUAGE_DETECT_TESTS "Build unit tests for language_detect plug-in" ON)

if(ENABLE_LANGUAGE_DETECT_TESTS)
    enable_testing()
    add_subdirectory(tests)
endif()

# --------------------------------------------------------------------------
# Optional tooling
# --------------------------------------------------------------------------
find_program(CLANG_TIDY_EXE NAMES clang-tidy)
if(CLANG_TIDY_EXE)
    set_target_properties(language_detect PROPERTIES C_CLANG_TIDY "${CLANG_TIDY_EXE}")
endif()