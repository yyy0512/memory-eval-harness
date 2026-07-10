#!/usr/bin/env bash
# =============================================================================
#  ChronoFlow Nexus – Unified Build & Run Script
# -----------------------------------------------------------------------------
#  This script is the single entry-point for developers and CI systems to
#  compile, test, and launch the ChronoFlow Nexus microservice.  It supports:
#
#     • Incremental & clean builds (Debug / Release / RelWithDebInfo)
#     • Local development and containerised runtime modes
#     • Graceful shutdown with cleanup hooks
#     • Sanity-checking of critical dependencies (cmake, ninja, docker, …)
#     • Coloured, contextual log output
#
#  Usage:
#     ./run.sh [command] [options]
#
#  Commands:
#     build          – Configure & compile the project
#     test           – Run unit & integration tests
#     run            – Launch the ChronoFlow Nexus binary
#     docker-build   – Build a production Docker image
#     docker-run     – Run the service inside Docker
#     clean          – Remove all build artefacts
#     help           – Print this help message
#
#  Example:
#     ./run.sh build --type=Debug && ./run.sh run --env=development
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Utilities
# -----------------------------------------------------------------------------

readonly RESET="\033[0m"
readonly RED="\033[31m"
readonly GREEN="\033[32m"
readonly YELLOW="\033[33m"
readonly BLUE="\033[34m"

log()     { printf "${BLUE}[ChronoFlow]${RESET} %s\n" "$1"; }
warn()    { printf "${YELLOW}[ChronoFlow] WARN:${RESET} %s\n" "$1"; }
error()   { printf "${RED}[ChronoFlow] ERROR:${RESET} %s\n" "$1" >&2; }
success() { printf "${GREEN}[ChronoFlow]${RESET} %s\n" "$1"; }

# Resolve path of this script even when sourced via symlink
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="${SCRIPT_DIR}/.."
BUILD_DIR="${PROJECT_ROOT}/build"
BINARY_NAME="chronoflow_nexus"
CONFIG_DIR="${PROJECT_ROOT}/configs"
DEFAULT_PORT="8080"

# -----------------------------------------------------------------------------
# Dependency checks
# -----------------------------------------------------------------------------

function require_command() {
  local cmd="$1"
  local pretty="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    error "Missing dependency: ${pretty} (${cmd})"
    exit 127
  fi
}

function ensure_prerequisites() {
  require_command cmake    "CMake"
  require_command ninja    "Ninja"
  require_command g++      "GNU C++ Compiler"
}

# -----------------------------------------------------------------------------
# Clean-up handling
# -----------------------------------------------------------------------------

function cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then
    error "Script terminated with exit code ${code}"
  fi
  trap - EXIT INT TERM
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
# Build Command
# -----------------------------------------------------------------------------

function cmd_build() {
  local build_type="Release"

  for arg in "$@"; do
    case ${arg} in
      --type=*) build_type="${arg#*=}" ;;
      *) error "Unknown option: ${arg}"; exit 2 ;;
    esac
  done

  ensure_prerequisites
  log "Starting CMake ${build_type} build…"

  mkdir -p "${BUILD_DIR}"
  cmake -S "${PROJECT_ROOT}" -B "${BUILD_DIR}" \
        -G Ninja \
        -DCMAKE_BUILD_TYPE="${build_type}" \
        -DCHRONOFLOW_ENABLE_LTO=ON
  cmake --build "${BUILD_DIR}" --target "${BINARY_NAME}" -j "$(nproc)"

  success "Build completed (type=${build_type})"
}

# -----------------------------------------------------------------------------
# Test Command
# -----------------------------------------------------------------------------

function cmd_test() {
  if [[ ! -d "${BUILD_DIR}" ]]; then
    warn "No build directory found. Building in Debug mode first…"
    cmd_build --type=Debug
  fi

  log "Running tests…"
  ( cd "${BUILD_DIR}" && ctest --output-on-failure )
  success "All tests passed"
}

# -----------------------------------------------------------------------------
# Run Command
# -----------------------------------------------------------------------------

function cmd_run() {
  local env="production"
  local port="${DEFAULT_PORT}"
  local config_file=""
  local threads="$(nproc)"

  for arg in "$@"; do
    case ${arg} in
      --env=*)     env="${arg#*=}" ;;
      --port=*)    port="${arg#*=}" ;;
      --config=*)  config_file="${arg#*=}" ;;
      --threads=*) threads="${arg#*=}" ;;
      *) error "Unknown option: ${arg}"; exit 2 ;;
    esac
  done

  if [[ ! -x "${BUILD_DIR}/${BINARY_NAME}" ]]; then
    warn "Binary not found. Building first…"
    cmd_build --type=Release
  fi

  if [[ -z "${config_file}" ]]; then
    config_file="${CONFIG_DIR}/${env}.yml"
  fi
  if [[ ! -f "${config_file}" ]]; then
    error "Configuration file not found: ${config_file}"
    exit 4
  fi

  export CHRONOFLOW_ENV="${env}"
  export CHRONOFLOW_CONFIG="${config_file}"
  export CHRONOFLOW_PORT="${port}"
  export OMP_NUM_THREADS="${threads}"

  log "Launching ChronoFlow Nexus (env=${env}, port=${port}, threads=${threads})"
  "${BUILD_DIR}/${BINARY_NAME}"
}

# -----------------------------------------------------------------------------
# Docker Commands
# -----------------------------------------------------------------------------

function cmd_docker_build() {
  require_command docker "Docker"

  local tag="chronoflow/nexus:latest"

  for arg in "$@"; do
    case ${arg} in
      --tag=*) tag="${arg#*=}" ;;
      *) error "Unknown option: ${arg}"; exit 2 ;;
    esac
  done

  log "Building Docker image (${tag})…"
  docker build -f "${PROJECT_ROOT}/docker/Dockerfile" \
               -t "${tag}" "${PROJECT_ROOT}"
  success "Docker image ${tag} built"
}

function cmd_docker_run() {
  require_command docker "Docker"

  local tag="chronoflow/nexus:latest"
  local port="${DEFAULT_PORT}"

  for arg in "$@"; do
    case ${arg} in
      --tag=*)  tag="${arg#*=}" ;;
      --port=*) port="${arg#*=}" ;;
      *) error "Unknown option: ${arg}"; exit 2 ;;
    esac
  done

  log "Running Docker container (${tag}) on port ${port}"
  docker run --rm -it \
    -e CHRONOFLOW_ENV=production \
    -p "${port}:8080" \
    "${tag}"
}

# -----------------------------------------------------------------------------
# Clean Command
# -----------------------------------------------------------------------------

function cmd_clean() {
  log "Removing build artefacts…"
  rm -rf "${BUILD_DIR}"
  success "Clean completed"
}

# -----------------------------------------------------------------------------
# Help Command
# -----------------------------------------------------------------------------

function cmd_help() {
  grep -E '^#  ' "$0" | sed 's/^#  //'
}

# -----------------------------------------------------------------------------
# Entry-point Router
# -----------------------------------------------------------------------------

function main() {
  local command="${1:-help}"
  shift || true

  case "${command}" in
    build)        cmd_build        "$@" ;;
    test)         cmd_test         "$@" ;;
    run)          cmd_run          "$@" ;;
    docker-build) cmd_docker_build "$@" ;;
    docker-run)   cmd_docker_run   "$@" ;;
    clean)        cmd_clean        "$@" ;;
    help|--help|-h) cmd_help ;;
    *)
      error "Unknown command: ${command}"
      cmd_help
      exit 2
      ;;
  esac
}

main "$@"