cmake_minimum_required(VERSION 3.16)

#
#  PulseSphere – Validation Service
#  --------------------------------
#  CMake build script for the schema-on-read validation micro-service used
#  in the PulseSphere data-streaming platform.
#
#  This build script:
#    • Enables modern C17 features and strict compiler warnings
#    • Optionally activates clang-tidy and sanitizer instrumentation
#    • Discovers required third-party dependencies (jansson, OpenSSL, librdkafka)
#    • Produces both a reusable shared library and a standalone service binary
#    • Provides installation/export rules for downstream consumers
#    • Hooks into CTest for unit/integration tests
#

project(ValidationService
        VERSION 1.2.0
        DESCRIPTION "PulseSphere – Real-Time Social Pulse Validation Service"
        LANGUAGES C)

# ---------------------------------------------------------------------------
# Build options
# ---------------------------------------------------------------------------
option(ENABLE_CLANG_TIDY  "Enable clang-tidy static analysis"         ON)
option(ENABLE_SANITIZERS  "Compile with Address/UB sanitizers"        OFF)
option(BUILD_SHARED_LIBS  "Build shared libraries instead of static"  ON)
option(BUILD_TESTS        "Build unit and integration tests"          ON)

# ---------------------------------------------------------------------------
# Compiler configuration
# ---------------------------------------------------------------------------
set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Global compile flags
if (NOT MSVC)
    add_compile_options(
        -Wall -Wextra -Wpedantic
        -Werror
    )
    if (ENABLE_SANITIZERS)
        add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
        add_link_options   (-fsanitize=address,undefined -fno-omit-frame-pointer)
    endif()
else()
    add_compile_options(/W4 /WX)
endif()

# clang-tidy integration -----------------------------------------------------
if (ENABLE_CLANG_TIDY)
    find_program(CLANG_TIDY_EXE NAMES clang-tidy)
    if (CLANG_TIDY_EXE)
        message(STATUS "clang-tidy enabled: ${CLANG_TIDY_EXE}")
        set(CMAKE_C_CLANG_TIDY
            "${CLANG_TIDY_EXE};-checks=*,-llvm-include-order,-llvm-header-guard;-warnings-as-errors=*")
    else()
        message(WARNING "clang-tidy requested but not found")
    endif()
endif()

# ---------------------------------------------------------------------------
# Third-party dependencies
# ---------------------------------------------------------------------------
find_package(Jansson REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(Threads  REQUIRED)

# librdkafka (Apache Kafka C/C++ client, used for event fabric publishing)
find_library(LIBRDKAFKA rdkafka REQUIRED)
mark_as_advanced(LIBRDKAFKA)

# ---------------------------------------------------------------------------
# Source files
# ---------------------------------------------------------------------------
file(GLOB_RECURSE VALIDATION_SERVICE_SOURCES CONFIGURE_DEPENDS
     ${CMAKE_CURRENT_SOURCE_DIR}/src/*.c)

file(GLOB_RECURSE VALIDATION_SERVICE_HEADERS CONFIGURE_DEPENDS
     ${CMAKE_CURRENT_SOURCE_DIR}/include/*.h)

# ---------------------------------------------------------------------------
# Library target
# ---------------------------------------------------------------------------
add_library(validation_service ${VALIDATION_SERVICE_SOURCES} ${VALIDATION_SERVICE_HEADERS})

target_include_directories(validation_service
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:include>
    PRIVATE
        ${JANSSON_INCLUDE_DIRS})

target_link_libraries(validation_service
    PUBLIC
        ${JANSSON_LIBRARIES}
        OpenSSL::SSL
        ${LIBRDKAFKA}
        Threads::Threads)

target_compile_definitions(validation_service
    PRIVATE
        $<$<CONFIG:Debug>:VALIDATION_SERVICE_DEBUG>)

set_target_properties(validation_service PROPERTIES
    VERSION       ${PROJECT_VERSION}
    SOVERSION     1
    OUTPUT_NAME   pulsesphere_validation)

# ---------------------------------------------------------------------------
# Service executable (entry-point)
# ---------------------------------------------------------------------------
add_executable(validation_service_app src/main.c)
target_link_libraries(validation_service_app PRIVATE validation_service)

# ---------------------------------------------------------------------------
# Installation rules
# ---------------------------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS validation_service validation_service_app
        EXPORT  ValidationServiceTargets
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
        INCLUDES DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})

install(DIRECTORY include/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}
        FILES_MATCHING PATTERN "*.h")

# ---------------------------------------------------------------------------
# CMake package configuration (for find_package)
# ---------------------------------------------------------------------------
include(CMakePackageConfigHelpers)

write_basic_package_version_file(
    ${CMAKE_CURRENT_BINARY_DIR}/ValidationServiceConfigVersion.cmake
    VERSION       ${PROJECT_VERSION}
    COMPATIBILITY AnyNewerVersion)

configure_package_config_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/ValidationServiceConfig.cmake.in
    ${CMAKE_CURRENT_BINARY_DIR}/ValidationServiceConfig.cmake
    INSTALL_DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ValidationService)

install(EXPORT ValidationServiceTargets
        FILE  ValidationServiceTargets.cmake
        NAMESPACE PulseSphere::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ValidationService)

install(FILES
        ${CMAKE_CURRENT_BINARY_DIR}/ValidationServiceConfig.cmake
        ${CMAKE_CURRENT_BINARY_DIR}/ValidationServiceConfigVersion.cmake
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/ValidationService)

# ---------------------------------------------------------------------------
# Testing
# ---------------------------------------------------------------------------
if (BUILD_TESTS)
    enable_testing()
    add_subdirectory(test)
endif()

# ---------------------------------------------------------------------------
# Packaging (CPack)
# ---------------------------------------------------------------------------
include(CPack)