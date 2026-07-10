# ==========================================================================================
#  CMakeLists.txt — PulseSphere Analytics Sink Service
#
#  This build script compiles the Analytics Sink micro-service, which consumes curated
#  “social pulse” events from the internal event fabric (Kafka/LZ4/Protobuf stack) and
#  reliably stores them into a columnar analytics lake (Parquet + object-storage backend).
#
#  The service is written in C11, leverages librdkafka for streaming, Google Protobuf for
#  schema-validation, Zstandard for compression, and pluggable “Sink Drivers” that follow
#  the Strategy Pattern (i.e. Parquet, CSV, Firehose, BigQuery, etc).
#
#  Author: PulseSphere Core Team
# ==========================================================================================

cmake_minimum_required(VERSION 3.18 FATAL_ERROR)

# ---------------------------------------------------------------
# Project Meta
# ---------------------------------------------------------------
project(
    analytics_sink_service
    VERSION 2.4.1
    DESCRIPTION "PulseSphere — Real-Time Analytics Sink Service"
    LANGUAGES C
)

# ---------------------------------------------------------------
# Global Build Options
# ---------------------------------------------------------------
set(CMAKE_C_STANDARD                 11)
set(CMAKE_C_STANDARD_REQUIRED        ON)
set(CMAKE_C_EXTENSIONS               OFF)

# Default build type
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING
        "Choose the type of build (Debug, Release, RelWithDebInfo, MinSizeRel)." FORCE)
endif()

# Position Independent Code for shared libs
set(CMAKE_POSITION_INDEPENDENT_CODE  ON)

# ---------------------------------------------------------------
# Option Switches / Feature Flags
# ---------------------------------------------------------------
option(ENABLE_ASAN         "Build with AddressSanitizer"                       OFF)
option(ENABLE_UBSAN        "Build with UndefinedBehaviorSanitizer"             OFF)
option(ENABLE_LTO          "Enable Link-Time-Optimization (LTO)"               ON)
option(ENABLE_COVERAGE     "Enable GCC/Clang code-coverage instrumentation"    OFF)
option(ENABLE_CLANG_TIDY   "Run clang-tidy static analysis during compilation" OFF)
option(ENABLE_TESTING      "Build unit & integration tests"                    ON)

# ---------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------
include(FetchContent)
include(GNUInstallDirs)

# Threads
find_package(Threads REQUIRED)

# Protobuf (C)
find_package(Protobuf REQUIRED)
message(STATUS "Found Protobuf ${Protobuf_VERSION}")

# librdkafka
find_path(RDKAFKA_INCLUDE_DIR NAMES rdkafka.h)
find_library(RDKAFKA_LIBRARIES NAMES rdkafka)
if(NOT RDKAFKA_INCLUDE_DIR OR NOT RDKAFKA_LIBRARIES)
    message(FATAL_ERROR "librdkafka not found. Please install librdkafka-dev.")
endif()

# Zstandard
find_package(ZSTD REQUIRED)

# Arrow/Parquet C
find_package(Arrow REQUIRED COMPONENTS parquet)

# uuid (libuuid)
find_path(UUID_INCLUDE_DIR uuid/uuid.h)
find_library(UUID_LIBRARIES uuid)
if(NOT UUID_INCLUDE_DIR OR NOT UUID_LIBRARIES)
    message(FATAL_ERROR "libuuid not found.")
endif()

# ---------------------------------------------------------------
# Source Files
# ---------------------------------------------------------------
file(GLOB_RECURSE SRC_FILES CONFIGURE_DEPENDS
     "src/*.c"
     "src/*.h")

add_library(analytics_sink STATIC ${SRC_FILES})

# Public include directory for downstream targets
target_include_directories(analytics_sink
    PUBLIC
        $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
        $<INSTALL_INTERFACE:${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/analytics_sink>
    PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ---------------------------------------------------------------
# Compile Options & Warnings
# ---------------------------------------------------------------
if (MSVC)
    target_compile_options(analytics_sink PRIVATE /W4 /permissive- /D_CRT_SECURE_NO_WARNINGS)
else()
    # Generic GCC/Clang warnings
    target_compile_options(analytics_sink PRIVATE
        -Wall -Wextra -Wpedantic
        -Wshadow -Wformat=2 -Wcast-align
        -Wstrict-prototypes -Wundef -Wpointer-arith
        -Wwrite-strings -Wmissing-prototypes
        -Wno-unused-parameter
    )
endif()

# ---------------------------------------------------------------
# Definitions & Feature Flags
# ---------------------------------------------------------------
target_compile_definitions(analytics_sink
    PRIVATE
        $<$<CONFIG:Debug>:PS_ENABLE_DEBUG_LOGS=1>
        PS_VERSION_MAJOR=${PROJECT_VERSION_MAJOR}
        PS_VERSION_MINOR=${PROJECT_VERSION_MINOR}
        PS_VERSION_PATCH=${PROJECT_VERSION_PATCH}
)

# ---------------------------------------------------------------
# Link Libraries
# ---------------------------------------------------------------
target_link_libraries(analytics_sink
    PUBLIC
        Threads::Threads
        ${Protobuf_LIBRARIES}
        Arrow::arrow_shared
        Arrow::parquet_shared
    PRIVATE
        ${RDKAFKA_LIBRARIES}
        ZSTD::ZSTD
        ${UUID_LIBRARIES}
)

# ---------------------------------------------------------------
# Sanitizers
# ---------------------------------------------------------------
if(ENABLE_ASAN AND NOT MSVC)
    target_compile_options(analytics_sink PRIVATE -fsanitize=address -fno-omit-frame-pointer)
    target_link_options(analytics_sink    PRIVATE -fsanitize=address -fno-omit-frame-pointer)
endif()

if(ENABLE_UBSAN AND NOT MSVC)
    target_compile_options(analytics_sink PRIVATE -fsanitize=undefined -fno-omit-frame-pointer)
    target_link_options(analytics_sink    PRIVATE -fsanitize=undefined -fno-omit-frame-pointer)
endif()

# ---------------------------------------------------------------
# Clang-Tidy
# ---------------------------------------------------------------
if(ENABLE_CLANG_TIDY)
    find_program(CLANG_TIDY_EXE NAMES clang-tidy)
    if(CLANG_TIDY_EXE)
        set_target_properties(analytics_sink PROPERTIES C_CLANG_TIDY "${CLANG_TIDY_EXE}")
    else()
        message(WARNING "clang-tidy requested but executable not found.")
    endif()
endif()

# ---------------------------------------------------------------
# Link-Time Optimization
# ---------------------------------------------------------------
include(CheckIPOSupported)
if(ENABLE_LTO)
    check_ipo_supported(RESULT LTO_AVAILABLE OUTPUT LTO_ERROR)
    if(LTO_AVAILABLE)
        set_target_properties(analytics_sink PROPERTIES INTERPROCEDURAL_OPTIMIZATION TRUE)
    else()
        message(WARNING "LTO not supported: ${LTO_ERROR}")
    endif()
endif()

# ---------------------------------------------------------------
# Coverage (Only valid for GCC/Clang)
# ---------------------------------------------------------------
if(ENABLE_COVERAGE AND CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(analytics_sink PRIVATE -O0 -g --coverage)
    target_link_options(analytics_sink    PRIVATE --coverage)
endif()

# ---------------------------------------------------------------
# Service Entry-Point
# ---------------------------------------------------------------
add_executable(analytics_sinkd src/main.c)
target_link_libraries(analytics_sinkd PRIVATE analytics_sink)

# ---------------------------------------------------------------
# Installation
# ---------------------------------------------------------------
install(TARGETS analytics_sink analytics_sinkd
        EXPORT analytics_sink_targets
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
        LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
        ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})

install(DIRECTORY include/
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/pulsesphere/analytics_sink
        FILES_MATCHING PATTERN "*.h")

install(EXPORT analytics_sink_targets
        NAMESPACE PulseSphere::
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/cmake/analytics_sink)

# ---------------------------------------------------------------
# Testing
# ---------------------------------------------------------------
if(ENABLE_TESTING)
    enable_testing()
    FetchContent_Declare(
        googletest
        URL https://github.com/google/googletest/archive/release-1.12.1.tar.gz
    )
    FetchContent_MakeAvailable(googletest)

    file(GLOB_RECURSE TEST_SRC CONFIGURE_DEPENDS tests/*.c)
    add_executable(analytics_sink_tests ${TEST_SRC})
    target_link_libraries(analytics_sink_tests PRIVATE analytics_sink gtest gtest_main)
    add_test(NAME analytics_sink_tests COMMAND analytics_sink_tests)
endif()

# ---------------------------------------------------------------
# Packaging (CPack)
# ---------------------------------------------------------------
include(CPack)
set(CPACK_PACKAGE_VENDOR         "PulseSphere Inc.")
set(CPACK_PACKAGE_DESCRIPTION    "Analytics Sink Service for PulseSphere")
set(CPACK_PACKAGE_CONTACT        "opensource@pulsesphere.io")
set(CPACK_PACKAGE_VERSION        ${PROJECT_VERSION})
set(CPACK_RESOURCE_FILE_LICENSE  "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_GENERATOR              "TGZ;ZIP")
# ==========================================================================================