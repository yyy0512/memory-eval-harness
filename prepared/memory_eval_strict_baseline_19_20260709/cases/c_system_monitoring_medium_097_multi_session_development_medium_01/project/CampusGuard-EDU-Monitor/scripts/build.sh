```bash
#!/usr/bin/env bash
#
# CampusGuard EDU Monitor — build.sh
#
# A production-quality build orchestrator for the CampusGuard EDU Monitor
# (system_monitoring) project.  The script compiles the entire C codebase,
# executes unit/integration tests, runs static analysis, and optionally
# installs the resulting binaries.  It is intentionally self-contained, as
# students may use it on lab machines without full build frameworks.
#
# Supported targets:
#   ./scripts/build.sh [command] [options]
#
# Commands:
#   help              Show this help.
#   configure         Generate out-of-tree build directory with CMake.
#   build             Build the project.  (default = Debug)
#   test              Run test-suite after building (requires build).
#   analyze           Run static analysis (clang-tidy / cppcheck).
#   clean             Remove build artifacts.
#   distclean         Remove build directory entirely.
#   install           Install binaries (requires root or writable prefix).
#
# Useful options (applies to 'configure' & 'build'):
#   -t, --type [Debug|Release|RelWithDebInfo]  Build type (default: Debug).
#   -j, --jobs N                               Parallel build jobs.
#   -p, --prefix PATH                          Installation prefix.
#   -h, --help                                 Display help.
#
# Example:
#   ./scripts/build.sh configure -t Release -p /usr/local
#   ./scripts/build.sh build -j 8
#   ./scripts/build.sh test
#
set -euo pipefail

################################################################################
# Globals & defaults
################################################################################
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${PROJECT_ROOT}/build"
BUILD_TYPE="Debug"
JOBS="$(nproc || echo 2)"
PREFIX="/usr/local"
CMAKE_GENERATOR="Unix Makefiles"
SCRIPT_NAME="$(basename "${0}")"

################################################################################
# Logging helpers
################################################################################
log()   { echo -e "\033[1;32m[INFO]\033[0m  $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m  $*" >&2; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

################################################################################
# usage prints help text
################################################################################
usage() {
    grep -E '^#( |$)' "${BASH_SOURCE[0]}" | cut -c4-
    exit 0
}

################################################################################
# command_exists checks whether a command exists in PATH
################################################################################
command_exists() {
    command -v "$1" &>/dev/null
}

################################################################################
# parse_common_flags parses generic CLI flags
################################################################################
parse_common_flags() {
    local OPTS TEMP
    # shellcheck disable=SC2015
    TEMP=$(getopt -o t:j:p:h --long type:,jobs:,prefix:,help -n "${SCRIPT_NAME}" -- "$@") ||
        error "Failed to parse arguments."
    eval set -- "${TEMP}"
    while true; do
        case "$1" in
            -t|--type)   BUILD_TYPE="$2"; shift 2 ;;
            -j|--jobs)   JOBS="$2";       shift 2 ;;
            -p|--prefix) PREFIX="$2";     shift 2 ;;
            -h|--help)   usage ;;
            --) shift; break ;;
            *)  break ;;
        esac
    done
    # Validate build type
    case "${BUILD_TYPE}" in
        Debug|Release|RelWithDebInfo) ;;
        *) error "Unknown build type: ${BUILD_TYPE}" ;;
    esac
}

################################################################################
# ensure_dependencies verifies the required build tooling is installed
################################################################################
ensure_dependencies() {
    local missing=()
    for cmd in cmake gcc make; do
        command_exists "${cmd}" || missing+=("${cmd}")
    done
    # Optional tools for analysis/test
    if [[ "${COMMAND}" == "analyze" ]]; then
        for cmd in clang-tidy cppcheck; do
            command_exists "${cmd}" || warn "${cmd} not found (analysis will be partial)."
        done
    fi
    if [[ "${COMMAND}" == "test" ]] && ! command_exists ctest; then
        missing+=("ctest")
    fi

    if (( ${#missing[@]} )); then
        error "Missing required tools: ${missing[*]}"
    fi
}

################################################################################
# configure_project generates the CMake build directory
################################################################################
configure_project() {
    parse_common_flags "$@"
    ensure_dependencies
    log "Configuring project (${BUILD_TYPE}) in ${BUILD_DIR}"
    mkdir -p "${BUILD_DIR}"
    pushd "${BUILD_DIR}" >/dev/null
        cmake -G "${CMAKE_GENERATOR}" \
              -DCMAKE_BUILD_TYPE="${BUILD_TYPE}" \
              -DCMAKE_INSTALL_PREFIX="${PREFIX}" \
              "${PROJECT_ROOT}"
    popd >/dev/null
    log "Configuration complete."
}

################################################################################
# build_project compiles sources using the existing build directory
################################################################################
build_project() {
    parse_common_flags "$@"
    ensure_dependencies
    if [[ ! -f "${BUILD_DIR}/build.ninja" && ! -f "${BUILD_DIR}/Makefile" ]]; then
        warn "Build directory is missing; running configure first."
        configure_project
    fi
    log "Building project with ${JOBS} parallel job(s)."
    pushd "${BUILD_DIR}" >/dev/null
        cmake --build . -- -j"${JOBS}"
    popd >/dev/null
    log "Build finished successfully."
}

################################################################################
# run_tests executes ctest in the build directory
################################################################################
run_tests() {
    ensure_dependencies
    if [[ ! -d "${BUILD_DIR}" ]]; then
        error "Build directory not found. Run '${SCRIPT_NAME} build' first."
    fi
    log "Running unit/integration tests…"
    pushd "${BUILD_DIR}" >/dev/null
        ctest --output-on-failure
    popd >/dev/null
}

################################################################################
# run_static_analysis uses clang-tidy & cppcheck to detect issues
################################################################################
run_static_analysis() {
    ensure_dependencies
    log "Running static analysis…"

    local tidy_cmd=()
    if command_exists clang-tidy; then
        tidy_cmd=(clang-tidy)
    elif command_exists run-clang-tidy; then
        tidy_cmd=(run-clang-tidy)
    else
        warn "clang-tidy not available; skipping."
    fi

    # Use compile_commands.json for clang-tidy
    if [[ -n "${tidy_cmd[*]}" ]] && [[ -f "${BUILD_DIR}/compile_commands.json" ]]; then
        "${tidy_cmd[@]}" -p "${BUILD_DIR}" -quiet
    fi

    if command_exists cppcheck; then
        cppcheck --enable=all --inconclusive --std=c11 --suppress=missingIncludeSystem \
                 --project="${BUILD_DIR}/compile_commands.json" \
                 | tee "${BUILD_DIR}/cppcheck.log"
    fi

    log "Static analysis complete."
}

################################################################################
# clean_project performs a 'make clean'
################################################################################
clean_project() {
    log "Cleaning build artifacts…"
    if [[ -d "${BUILD_DIR}" ]]; then
        pushd "${BUILD_DIR}" >/dev/null
            cmake --build . --target clean || true
        popd >/dev/null
    fi
    log "Clean complete."
}

################################################################################
# distclean_project removes the entire build directory
################################################################################
distclean_project() {
    log "Removing build directory (${BUILD_DIR})."
    rm -rf "${BUILD_DIR}"
    log "Distclean complete."
}

################################################################################
# install_project installs built artifacts to PREFIX
################################################################################
install_project() {
    parse_common_flags "$@"
    ensure_dependencies
    if [[ ! -d "${BUILD_DIR}" ]]; then
        error "Build directory not found. Run '${SCRIPT_NAME} build' first."
    fi
    log "Installing to ${PREFIX}… (may require sudo)"
    pushd "${BUILD_DIR}" >/dev/null
        cmake --install .
    popd >/dev/null
    log "Installation complete."
}

################################################################################
# Main dispatch
################################################################################
COMMAND="${1:-help}"
shift || true

case "${COMMAND}" in
    help|-h|--help)       usage ;;
    configure)            configure_project "$@" ;;
    build)                build_project "$@" ;;
    test)                 run_tests "$@" ;;
    analyze)              run_static_analysis "$@" ;;
    clean)                clean_project ;;
    distclean)            distclean_project ;;
    install)              install_project "$@" ;;
    *)
        usage
        ;;
esac
```