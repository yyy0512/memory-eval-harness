cmake_minimum_required(VERSION 3.23)

# ================================================================
#  ChronoFlow Nexus – Top-Level CMake
#  A high-performance C++20 micro-service for time-tracking analytics
# ================================================================
project(
    ChronoFlowNexus
    VERSION 1.4.2
    DESCRIPTION "ChronoFlow Nexus – Time-tracking, analytics & insights micro-service"
    LANGUAGES CXX
)

# ----------------------------------------------------------------
#  Build options
# ----------------------------------------------------------------
option(CFN_ENABLE_TESTS        "Build unit & integration tests"         ON)
option(CFN_ENABLE_BENCHMARKS   "Build micro-benchmarks"                 OFF)
option(CFN_ENABLE_LTO          "Enable Link-Time Optimisation"          ON)
option(CFN_ENABLE_SANITIZER    "Build with Address/UB sanitizers"       OFF)
option(CFN_ENABLE_COVERAGE     "Collect test coverage information"      OFF)
option(CFN_ENABLE_PCH          "Enable pre-compiled headers"            ON)
option(CFN_ENABLE_CLANG_TIDY   "Run clang-tidy static analysis"         OFF)

# ----------------------------------------------------------------
#  Global compile settings
# ----------------------------------------------------------------
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Make RelWithDebInfo the default. Users can override with `-DCMAKE_BUILD_TYPE=...`
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE RelWithDebInfo CACHE STRING
        "Choose the type of build (Debug, Release, RelWithDebInfo, MinSizeRel)"
        FORCE
    )
endif()

# strict compilation flags
if(MSVC)
    add_compile_options(/W4 /WX)
else()
    add_compile_options(-Wall -Wextra -Wpedantic -Werror)
endif()

# Sanitizers (Clang/GCC only)
if(CFN_ENABLE_SANITIZER AND NOT MSVC)
    add_compile_options(-fsanitize=address -fno-omit-frame-pointer)
    link_libraries(-fsanitize=address)
endif()

# Code-coverage flags (GCC/Clang)
if(CFN_ENABLE_COVERAGE AND (CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang"))
    add_compile_options(-O0 --coverage)
    link_libraries(--coverage)
endif()

# LTO
include(CheckIPOSupported)
if(CFN_ENABLE_LTO)
    check_ipo_supported(RESULT lto_supported OUTPUT lto_output)
    if(lto_supported)
        message(STATUS "IPO/LTO enabled")
        set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)
    else()
        message(WARNING "IPO/LTO not supported: ${lto_output}")
    endif()
endif()

# ----------------------------------------------------------------
#  Tooling integrations
# ----------------------------------------------------------------
if(CFN_ENABLE_CLANG_TIDY)
    find_program(CLANG_TIDY_EXE NAMES clang-tidy)
    if(CLANG_TIDY_EXE)
        message(STATUS "clang-tidy found: ${CLANG_TIDY_EXE}")
        set(CMAKE_CXX_CLANG_TIDY
            "${CLANG_TIDY_EXE};-extra-arg=-std=c++20;-warnings-as-errors=*")
    else()
        message(WARNING "clang-tidy requested but not found!")
    endif()
endif()

# ----------------------------------------------------------------
#  Third-party dependencies
# ----------------------------------------------------------------
include(FetchContent)

# fmt
find_package(fmt 9 REQUIRED)

# spdlog
find_package(spdlog 1.10 REQUIRED)

# nlohmann/json
find_package(nlohmann_json 3.10 REQUIRED)

# Boost
find_package(Boost 1.78.0 REQUIRED COMPONENTS
    program_options filesystem system date_time)

# Protobuf & gRPC
find_package(Protobuf REQUIRED)
find_package(gRPC     REQUIRED)

# cpp-rest-sdk (for REST layer)
find_package(cpprestsdk CONFIG REQUIRED)

# abseil (for base utilities)
find_package(absl CONFIG REQUIRED)

# OpenSSL (for TLS endpoints)
find_package(OpenSSL REQUIRED)

# Threads
find_package(Threads REQUIRED)

# Catch2 (tests) via FetchContent for reproducibility
if(CFN_ENABLE_TESTS)
    FetchContent_Declare(
        catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.5.0
    )
    FetchContent_MakeAvailable(catch2)
endif()

# Google Benchmark (optional)
if(CFN_ENABLE_BENCHMARKS)
    FetchContent_Declare(
        googlebenchmark
        GIT_REPOSITORY https://github.com/google/benchmark.git
        GIT_TAG        v1.8.3
    )
    set(BENCHMARK_ENABLE_TESTING OFF CACHE BOOL "" FORCE)
    FetchContent_MakeAvailable(googlebenchmark)
endif()

# ----------------------------------------------------------------
#  Pre-compiled headers helper
# ----------------------------------------------------------------
function(cfn_enable_pch TARGET)
    if(CFN_ENABLE_PCH AND TARGET ${TARGET})
        if(MSVC)
            target_precompile_headers(${TARGET} PRIVATE <vector> <string> <memory>)
        else()
            target_precompile_headers(${TARGET} PRIVATE
                <vector> <string> <memory> <optional> <utility>)
        endif()
    endif()
endfunction()

# ----------------------------------------------------------------
#  Configure a version header
# ----------------------------------------------------------------
configure_file(
    ${CMAKE_CURRENT_SOURCE_DIR}/cmake/Version.hpp.in
    ${CMAKE_CURRENT_BINARY_DIR}/generated/chrono_flow/version.hpp
    @ONLY
)

include_directories(${CMAKE_CURRENT_BINARY_DIR}/generated)

# ----------------------------------------------------------------
#  Source organisation
# ----------------------------------------------------------------
add_subdirectory(src/domain)
add_subdirectory(src/infrastructure)
add_subdirectory(src/application)
add_subdirectory(src/interface)   # REST/GraphQL façade
add_subdirectory(src/transport)   # HTTP, gRPC & Gateway façade

# ----------------------------------------------------------------
#  Top-level executable
# ----------------------------------------------------------------
add_executable(chrono_flow_nexus
    src/main/main.cpp
)

target_link_libraries(chrono_flow_nexus
    PRIVATE
        chrono_flow_transport
        chrono_flow_interface
        chrono_flow_application
        chrono_flow_domain
        chrono_flow_infrastructure
        Boost::boost
        Boost::program_options
        fmt::fmt
        spdlog::spdlog
        nlohmann_json::nlohmann_json
        cpprestsdk::cpprest
        protobuf::libprotobuf
        gRPC::grpc++
        OpenSSL::SSL
        Threads::Threads
)

cfn_enable_pch(chrono_flow_nexus)

set_target_properties(chrono_flow_nexus PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

# ----------------------------------------------------------------
#  Installation
# ----------------------------------------------------------------
include(GNUInstallDirs)

install(TARGETS chrono_flow_nexus
        RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

install(
    DIRECTORY api/schema
    DESTINATION ${CMAKE_INSTALL_DATADIR}/chrono_flow_nexus/schema
    FILES_MATCHING PATTERN "*.graphql"
)

# ----------------------------------------------------------------
#  Tests
# ----------------------------------------------------------------
if(CFN_ENABLE_TESTS)
    enable_testing()
    add_subdirectory(test)
endif()

# ----------------------------------------------------------------
#  Benchmarks
# ----------------------------------------------------------------
if(CFN_ENABLE_BENCHMARKS)
    add_subdirectory(benchmark)
endif()

# ----------------------------------------------------------------
#  Packaging via CPack
# ----------------------------------------------------------------
include(CPack)
set(CPACK_PACKAGE_NAME "ChronoFlowNexus")
set(CPACK_PACKAGE_VERSION ${PROJECT_VERSION})
set(CPACK_PACKAGE_CONTACT "dev@chronoflow.io")
set(CPACK_PACKAGE_VENDOR  "ChronoFlow Inc.")
set(CPACK_RESOURCE_FILE_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/LICENSE")
set(CPACK_PACKAGE_DESCRIPTION
    "ChronoFlow Nexus – a high-performance micro-service that exposes REST & GraphQL APIs \
    for time tracking, task analytics and team workload insights.")
set(CPACK_DEBIAN_PACKAGE_DEPENDS "libstdc++6, libprotobuf, libssl, zlib1g")

# ----------------------------------------------------------------
#  Summary
# ----------------------------------------------------------------
message(STATUS "")
message(STATUS "======================================================")
message(STATUS "  ChronoFlow Nexus build summary")
message(STATUS "  Version:               ${PROJECT_VERSION}")
message(STATUS "  Build type:            ${CMAKE_BUILD_TYPE}")
message(STATUS "  Tests enabled:         ${CFN_ENABLE_TESTS}")
message(STATUS "  Benchmarks enabled:    ${CFN_ENABLE_BENCHMARKS}")
message(STATUS "  Sanitizers enabled:    ${CFN_ENABLE_SANITIZER}")
message(STATUS "  Coverage enabled:      ${CFN_ENABLE_COVERAGE}")
message(STATUS "  LTO enabled:           ${CFN_ENABLE_LTO}")
message(STATUS "  PCH enabled:           ${CFN_ENABLE_PCH}")
message(STATUS "======================================================")
message(STATUS "")