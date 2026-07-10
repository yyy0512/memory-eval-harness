```sh
#!/usr/bin/env bash
#===============================================================================
# File:        run_monitor.sh
# Project:     CampusGuard EDU Monitor
# Description: Convenience wrapper used by instructors and CI to build, start,
#              stop, and observe the CampusGuard monitor daemon.  Although the
#              monitor core is written in C, this script provides the glue that
#              integrates the binary with the surrounding runtime environment
#              (log-directory creation, PID-file handling, graceful shutdown,
#              compilation, log rotation, etc.).  It is intentionally POSIX-ish
#              but makes use of a few Bash niceties when available.
#
# Usage:       ./run_monitor.sh <command> [options]
#
# Commands:
#   build                – Compile the monitor and its plug-ins
#   start   [--debug]    – Launch the monitor in the background
#   stop                 – Gracefully shut down the running monitor
#   restart [--debug]    – Shorthand for stop → start
#   status               – Print running status and version info
#   tail-log             – Tail the active log file
#   help                 – Display this help text
#
# Exit Codes:
#   0 — Success
#   1 — Generic or unexpected error
#  64 — Unsupported/unknown command-line option (EX_USAGE)
#  69 — Service currently unavailable (EX_UNAVAILABLE)
#===============================================================================

set -Eeuo pipefail

#---------------------------------- CONSTANTS ----------------------------------#
readonly APP_NAME="campusguard-monitor"
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly BUILD_DIR="${ROOT_DIR}/build"
readonly BIN_PATH="${BUILD_DIR}/${APP_NAME}"
readonly LOG_DIR="/var/log/campusguard"
readonly LOG_FILE="${LOG_DIR}/${APP_NAME}.log"
readonly PID_FILE="/var/run/${APP_NAME}.pid"
readonly DEFAULT_MAKE_TARGET="all"
readonly MAKE_CMD=${MAKE_CMD:-make}

#---------------------------------- UTILITIES ----------------------------------#
log()      { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err()      { log "ERROR: $*" >&2; }
die()      { err "$*"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

require_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        die "This command must be run as root."
    fi
}

ensure_dirs() {
    [[ -d "$LOG_DIR" ]] || install -d -m 0750 -o "$(id -u)" -g "$(id -g)" "$LOG_DIR"
    [[ -d "$BUILD_DIR" ]] || install -d -m 0755 "$BUILD_DIR"
}

rotate_log() {
    local ts
    ts="$(date '+%Y%m%d-%H%M%S')"
    if [[ -f "$LOG_FILE" && -s "$LOG_FILE" ]]; then
        mv "$LOG_FILE" "${LOG_FILE}.${ts}"
        gzip -9 "${LOG_FILE}.${ts}" &
    fi
}

pid_is_running() {
    local pid="$1"
    [[ -z "$pid" ]] && return 1
    kill -0 "$pid" 2>/dev/null
}

get_running_pid() {
    [[ -f "$PID_FILE" ]] && cat "$PID_FILE"
}

verify_runtime_state() {
    local pid
    pid="$(get_running_pid || true)"
    if [[ -n "$pid" ]]; then
        if pid_is_running "$pid"; then
            return 0
        else
            # Stale PID file, remove it
            rm -f -- "$PID_FILE"
        fi
    fi
    return 1
}

#---------------------------------- COMMANDS -----------------------------------#
do_build() {
    log "Building CampusGuard monitor …"
    ensure_dirs
    (
        cd "$ROOT_DIR" || exit 1
        $MAKE_CMD "$DEFAULT_MAKE_TARGET"
    )
    if [[ ! -x "$BIN_PATH" ]]; then
        die "Build completed but binary not found at $BIN_PATH"
    fi
    log "Build succeeded. Binary: $BIN_PATH"
}

do_start() {
    local debug_flag=0
    if [[ ${1:-} == "--debug" ]]; then
        debug_flag=1
        shift
    fi

    verify_runtime_state && die "Monitor is already running (PID=$(get_running_pid))."

    [[ -x "$BIN_PATH" ]] || do_build

    require_root
    ensure_dirs
    rotate_log

    local cmd=("$BIN_PATH")
    (( debug_flag )) && cmd+=("--debug")

    log "Starting ${APP_NAME} …"
    nohup "${cmd[@]}" >>"$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" >"$PID_FILE"

    # Allow the daemon a moment to start and produce its first line of log output
    sleep 1
    if ! pid_is_running "$pid"; then
        die "Failed to launch monitor; see $LOG_FILE."
    fi
    log "Monitor started with PID=$pid. Logs: $LOG_FILE"
}

do_stop() {
    verify_runtime_state || {
        log "Monitor is not running."
        return
    }

    require_root
    local pid
    pid="$(get_running_pid)"
    log "Stopping monitor (PID=$pid) …"
    kill -TERM "$pid" || true

    local grace_seconds=10
    for ((i = 0; i < grace_seconds; ++i)); do
        pid_is_running "$pid" || break
        sleep 1
    done

    if pid_is_running "$pid"; then
        log "Graceful shutdown timed out; forcing termination."
        kill -KILL "$pid" || true
    fi

    rm -f -- "$PID_FILE"
    log "Monitor stopped."
}

do_status() {
    if verify_runtime_state; then
        local pid
        pid="$(get_running_pid)"
        printf '%s is running (PID=%s)\n' "$APP_NAME" "$pid"
    else
        printf '%s is not running\n' "$APP_NAME"
    fi
    if [[ -x "$BIN_PATH" ]]; then
        printf 'Version: %s\n' "$("$BIN_PATH" --version || echo 'unknown')"
    fi
}

do_tail_log() {
    ensure_dirs
    [[ -f "$LOG_FILE" ]] || touch "$LOG_FILE"
    tail -n 100 -F "$LOG_FILE"
}

show_help() {
    sed -n '2,50p' < "$0" | sed -n '/^# Usage:/,/^# Exit Codes:/p' | sed 's/^# \{0,1\}//'
}

#---------------------------------- MAIN ENTRY ---------------------------------#
main() {
    local cmd="${1:-help}"
    shift || true

    case "$cmd" in
        build)      do_build "$@";;
        start)      do_start "$@";;
        stop)       do_stop   ;;
        restart)    do_stop; do_start "$@";;
        status)     do_status ;;
        tail-log)   do_tail_log ;;
        help|--help|-h) show_help ;;
        *)
            err "Unknown command: $cmd"
            show_help
            exit 64
            ;;
    esac
}

main "$@"
```