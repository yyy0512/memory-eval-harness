#!/usr/bin/env bash
#
# PaletteFlux Studio – Unified Test Runner
#
# This script bootstraps the C++ test-suite of the PaletteFlux GraphQL Studio
# back-end.  It was designed to be CI/CD-friendly, but can also be used
# interactively by developers.  Key features:
#
#   • One-command build & execution of all unit / integration tests
#   • Optional code-coverage generation (GCC/Clang + lcov/gcovr)
#   • Optional Valgrind / Memcheck run for detecting memory leaks
#   • Automatic colorized output with fall-back for non-TTY environments
#   • Robust error handling and helpful diagnostics for missing tooling
#
# Usage:
#   ./scripts/run_tests.sh [options]
#
# Options:
#   -h | --help          … display usage information
#   -c | --coverage      … build and run tests with coverage instrumentation
#   -v | --valgrind      … run tests under Valgrind (implies Debug build)
#   -j <N>               … compile with N parallel jobs (defaults to #CPUs)
#   --build-type <TYPE>  … Debug | Release | RelWithDebInfo (default: Debug)
#   --reconfigure        … drop previous CMake cache and reconfigure
#
# Examples:
#   ./scripts/run_tests.sh -c               # build w/ coverage and print summary
#   ./scripts/run_tests.sh -v               # valgrind memory check
#   ./scripts/run_tests.sh -j 8 --build-type Release
#
# ------------------------------------------------------------------------------

set -euo pipefail

######################################################################
# Globals
######################################################################
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="${SCRIPT_DIR}/.."
BUILD_DIR="${PROJECT_ROOT}/build"
CMAKE_PRESET="ci"
NUM_JOBS="$(nproc)"
BUILD_TYPE="Debug"
WITH_COVERAGE=false
WITH_VALGRIND=false
RECONFIGURE=false
COLOR_RESET=""
COLOR_RED=""
COLOR_GREEN=""
COLOR_BLUE=""
COLOR_YELLOW=""

######################################################################
# Utility helpers
######################################################################

function supports_color() {
  [[ -t 1 ]] && command -v tput >/dev/null && [[ "$(tput colors)" -ge 8 ]]
}

function init_colors() {
  if supports_color; then
    COLOR_RESET="$(tput sgr0)"
    COLOR_RED="$(tput setaf 1)"
    COLOR_GREEN="$(tput setaf 2)"
    COLOR_BLUE="$(tput setaf 4)"
    COLOR_YELLOW="$(tput setaf 3)"
  fi
}

function info()    { echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET}    $*"; }
function warn()    { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET}    $*"; }
function error()   { echo -e "${COLOR_RED}[ERROR]${COLOR_RESET}   $*" >&2; }
function success() { echo -e "${COLOR_GREEN}[OK]${COLOR_RESET}      $*"; }

function command_exists() {
  command -v "$1" >/dev/null 2>&1
}

function ensure_tool() {
  if ! command_exists "$1"; then
    error "Required tool '$1' not found in PATH."
    exit 1
  fi
}

function usage() {
  grep -E '^\s*#.*(Usage:|Options:|Examples:)' -A 30 "${BASH_SOURCE[0]}" \
    | sed -e 's/^\s*#\s*//' -e '/^$/q'
}

function cleanup() {
  trap - EXIT
  local status=$?
  if [[ "$status" -eq 0 ]]; then
    success "All tasks finished successfully."
  else
    error "Execution failed with exit code $status."
  fi
  exit "$status"
}
trap cleanup EXIT

######################################################################
# Argument parsing
######################################################################
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)        usage; exit 0 ;;
    -c|--coverage)    WITH_COVERAGE=true ;;
    -v|--valgrind)    WITH_VALGRIND=true ;;
    -j)               shift; NUM_JOBS="$1" ;;
    --build-type)     shift; BUILD_TYPE="$1" ;;
    --reconfigure)    RECONFIGURE=true ;;
    *) error "Unknown argument: $1"; usage; exit 1 ;;
  esac
  shift
done

if [[ "${WITH_VALGRIND}" == true ]]; then
  BUILD_TYPE="Debug"
fi

init_colors
info "PaletteFlux Studio – Test Runner"
info "Build type     : ${BUILD_TYPE}"
info "Coverage       : ${WITH_COVERAGE}"
info "Valgrind       : ${WITH_VALGRIND}"
info "Parallel builds: ${NUM_JOBS}"
info "Build dir      : ${BUILD_DIR}"

######################################################################
# Environment validation
######################################################################
ensure_tool cmake
ensure_tool ctest
ensure_tool ninja || warn "Ninja not found; CMake will fall back to default generator."

if [[ "${WITH_COVERAGE}" == true ]]; then
  ensure_tool lcov
  ensure_tool gcov
fi
if [[ "${WITH_VALGRIND}" == true ]]; then
  ensure_tool valgrind
fi

######################################################################
# Build system generation
######################################################################
if [[ "${RECONFIGURE}" == true ]]; then
  info "Removing previous CMake cache ..."
  rm -rf "${BUILD_DIR}"
fi

mkdir -p "${BUILD_DIR}"
pushd "${BUILD_DIR}" >/dev/null

info "Configuring project via CMake …"
cmake -G Ninja \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
  -DPALETTEFLUX_ENABLE_COVERAGE="${WITH_COVERAGE}" \
  -DPALETTEFLUX_ENABLE_TESTS=ON \
  "${PROJECT_ROOT}"

info "Building targets (${NUM_JOBS} jobs) …"
cmake --build . -- -j"${NUM_JOBS}"

######################################################################
# Test execution
######################################################################
CTEST_OPTS=("--output-on-failure")
if [[ "${WITH_VALGRIND}" == true ]]; then
  CTEST_OPTS+=(
    "-T" "memcheck"
    "--schedule-random"
  )
  export CTEST_MEMORYCHECK_COMMAND=$(command -v valgrind)
  export CTEST_MEMORYCHECK_COMMAND_OPTIONS="--leak-check=full --error-exitcode=1 --track-origins=yes"
fi

info "Running unit & integration tests via ctest …"
ctest "${CTEST_OPTS[@]}"

######################################################################
# Coverage collection
######################################################################
if [[ "${WITH_COVERAGE}" == true ]]; then
  info "Generating coverage report …"
  COVERAGE_DIR="coverage"
  lcov --directory . --capture --output-file "${COVERAGE_DIR}/coverage.info"
  lcov --remove "${COVERAGE_DIR}/coverage.info" '/usr/*' \
       --output-file "${COVERAGE_DIR}/coverage.filtered.info"
  genhtml "${COVERAGE_DIR}/coverage.filtered.info" \
          --output-directory "${COVERAGE_DIR}/html" >/dev/null
  success "Coverage report generated at ${BUILD_DIR}/${COVERAGE_DIR}/html/index.html"
fi

popd >/dev/null

# All done!