#!/usr/bin/env bash
###############################################################################
# PulseSphere Build & Utility Script
#
# This script orchestrates the full lifecycle of the PulseSphere C codebase:
#  • Configuration and compilation using CMake/Ninja
#  • Static analysis (clang-tidy / cppcheck)
#  • Unit-test execution with CTest
#  • Code-coverage generation with gcov & lcov
#  • Sanitizer-enabled debug builds
#  • Dockerized build isolation
#
# Usage:
#   ./build.sh <command> [options]
#
# Commands:
#   configure [debug|release|relwithdebinfo]   Configure CMake build tree
#   build                                      Compile sources
#   rebuild                                    Clean & build
#   clean                                      Remove build artifacts
#   test [regex]                               Run unit-tests (optional regex)
#   tidy                                       Run clang-tidy on the codebase
#   cppcheck                                   Run cppcheck on the codebase
#   coverage                                   Build (with coverage), test & generate report
#   sanitize                                   Build with AddressSanitizer (+UBSan)
#   package                                    Create installable package
#   docker <cmd>                               Execute any command inside the dev container
#
# Requirements:
#   • cmake (>=3.18) + ninja
#   • clang / gcc (C11 compliant)
#   • clang-tidy, cppcheck, lcov (optional, for extra targets)
#
# Environment variables:
#   CC, CXX            Override default C/C++ compilers
#   BUILD_DIR          Build directory (default: ./build)
#   INSTALL_PREFIX     Installation prefix (default: /usr/local)
#
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ROOT_DIR="${SCRIPT_DIR}"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build}"
INSTALL_PREFIX="${INSTALL_PREFIX:-/usr/local}"

CMAKE_GENERATOR="Ninja"

# Colors for pretty output
if [[ -t 1 ]]; then
  RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; NC=$'\e[0m'
else
  RED=''; GRN=''; YLW=''; BLU=''; NC=''
fi

log()  { printf "${BLU}[info]${NC} %s\n" "$*"; }
warn() { printf "${YLW}[warn]${NC} %s\n" "$*"; }
die()  { printf "${RED}[err] %s${NC}\n" "$*" >&2; exit 1; }

ensure_tool() {
  command -v "$1" &>/dev/null || die "Required tool '$1' not found in PATH."
}

cmake_configure() {
  local build_type="$1"; shift
  log "Configuring build (${build_type}) in ${BUILD_DIR}"
  mkdir -p "$BUILD_DIR"
  cmake -S "$ROOT_DIR" -B "$BUILD_DIR" \
    -G "${CMAKE_GENERATOR}" \
    -DCMAKE_BUILD_TYPE="${build_type}" \
    -DCMAKE_INSTALL_PREFIX="${INSTALL_PREFIX}" \
    -DPULSPHERE_ENABLE_SANITIZER=${ENABLE_SANITIZER:-OFF} \
    "$@"
}

cmake_build() {
  log "Building PulseSphere"
  cmake --build "$BUILD_DIR" -- -j"$(nproc)"
}

cmake_test() {
  local regex="${1:-}"
  log "Running unit tests"
  ( cd "$BUILD_DIR" && ctest --output-on-failure --parallel "$(nproc)" ${regex:+-R "$regex"} )
}

cmake_install() {
  log "Installing to ${INSTALL_PREFIX}"
  cmake --install "$BUILD_DIR"
}

run_clang_tidy() {
  ensure_tool "clang-tidy"
  log "Executing clang-tidy analysis"
  ( cd "$BUILD_DIR" && \
    cmake --build . --target clang-tidy -j"$(nproc)" )
}

run_cppcheck() {
  ensure_tool "cppcheck"
  log "Running cppcheck static analysis"
  cppcheck --enable=all --inline-suppr \
           --project="${BUILD_DIR}/compile_commands.json" \
           --suppress=missingIncludeSystem \
           2> "${BUILD_DIR}/cppcheck.txt"
  log "cppcheck results stored at ${BUILD_DIR}/cppcheck.txt"
}

generate_coverage() {
  ensure_tool "lcov"
  log "Building with coverage flags"
  BUILD_CFLAGS="--coverage"
  cmake_configure "Debug" -DCMAKE_C_FLAGS="${BUILD_CFLAGS}" -DCMAKE_CXX_FLAGS="${BUILD_CFLAGS}"
  cmake_build
  cmake_test
  log "Capturing coverage data"
  lcov --directory "$BUILD_DIR" --capture --output-file "$BUILD_DIR/coverage.info"
  genhtml "$BUILD_DIR/coverage.info" --output-directory "$BUILD_DIR/coverage"
  log "Coverage HTML report generated under ${BUILD_DIR}/coverage/index.html"
}

build_sanitized() {
  ENABLE_SANITIZER=ON cmake_configure "Debug"
  cmake_build
}

docker_run() {
  local cmd="$*"
  ensure_tool "docker"
  log "Building dev container image (if necessary)"
  docker build -t pulsesphere/dev -f "$ROOT_DIR/.ci/Dockerfile" "$ROOT_DIR"
  log "Executing inside container: $cmd"
  docker run --rm -it \
    -v "$ROOT_DIR":/work -w /work \
    pulsesphere/dev bash -c "$cmd"
}

clean_build() {
  log "Removing build directory"
  rm -rf "$BUILD_DIR"
}

# -----------------------------------------------------------------------------
# Main CLI parsing
# -----------------------------------------------------------------------------
COMMAND="${1:-}"
shift || true

case "$COMMAND" in
  configure)
    TYPE="${1:-debug}"
    TYPE="${TYPE^^}"                # Uppercase
    case "$TYPE" in
      DEBUG|RELEASE|RELWITHDEBINFO) ;;
      *) die "Unknown build type: ${TYPE}" ;;
    esac
    cmake_configure "$TYPE" "$@"
    ;;
  build)
    cmake_build
    ;;
  rebuild)
    clean_build
    cmake_configure "Debug"
    cmake_build
    ;;
  clean)
    clean_build
    ;;
  test)
    REGEX="${1:-}"
    cmake_test "$REGEX"
    ;;
  tidy)
    run_clang_tidy
    ;;
  cppcheck)
    run_cppcheck
    ;;
  coverage)
    generate_coverage
    ;;
  sanitize)
    build_sanitized
    ;;
  package)
    cmake_configure "Release" -DCPACK_GENERATOR="TGZ"
    cmake_build
    cmake --build "$BUILD_DIR" --target package
    log "Package created in ${BUILD_DIR}"
    ;;
  docker)
    docker_run "$*"
    ;;
  ""|-h|--help|help)
    set +x
    sed -n '2,70p' "${BASH_SOURCE[0]}"
    ;;
  *)
    die "Unknown command: ${COMMAND}"
    ;;
esac

log "Done."
