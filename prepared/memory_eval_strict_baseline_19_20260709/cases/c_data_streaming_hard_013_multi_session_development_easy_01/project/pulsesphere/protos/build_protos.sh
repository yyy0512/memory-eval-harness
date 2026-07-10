```bash
#!/usr/bin/env bash
#
#  PulseSphere – Real-Time Social Pulse Streaming Platform
#  -------------------------------------------------------
#  build_protos.sh
#
#  Purpose   : Compile all *.proto schemas into C artefacts that can be
#              consumed by the PulseSphere services.  The script performs
#              extensive validation (toolchain presence / version checks),
#              supports incremental rebuilds, parallel compilation, and a
#              clean target.
#
#  Copyright : © 2024 PulseSphere
#  License   : MIT — see LICENSE file for details.
#

set -euo pipefail

################################################################################
# Constants & Default Configuration
################################################################################

readonly SCRIPT_NAME="$(basename "$0")"
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
readonly DEFAULT_PROTO_DIR="${ROOT_DIR}"
readonly DEFAULT_OUT_DIR="${ROOT_DIR}/../generated"
readonly MIN_PROTOBUF_VERSION="3.20.0"
readonly MIN_PROTOC_C_VERSION="1.4.1"
readonly DEFAULT_JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu || echo 2)"

# Colour-coded logging (disable if not a tty)
if [[ -t 2 ]]; then
  readonly C_RED=$'\e[31m';   readonly C_GRN=$'\e[32m'
  readonly C_YEL=$'\e[33m';   readonly C_BLU=$'\e[34m'
  readonly C_RST=$'\e[0m'
else
  readonly C_RED=''; readonly C_GRN=''; readonly C_YEL=''
  readonly C_BLU=''; readonly C_RST=''
fi

################################################################################
# Helper Utilities
################################################################################

log()      { printf '%s%s%s: %s\n'  "${C_BLU}" "${SCRIPT_NAME}" "${C_RST}" "$*"; }
success()  { printf '%s✔%s %s\n'    "${C_GRN}" "${C_RST}" "$*"; }
warn()     { printf '%s⚠%s %s\n'    "${C_YEL}" "${C_RST}" "$*" >&2; }
fatal()    { printf '%s✖%s %s\n'    "${C_RED}" "${C_RST}" "$*" >&2; exit 1; }

semver_ge() {
  # shellcheck disable=SC2053
  [[ "$1" == "$2" ||  "$1" == $(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1) ]]
}

################################################################################
# Command-line Argument Parsing
################################################################################

PRINT_HELP=false
CLEAN=false
PROTO_DIR="$DEFAULT_PROTO_DIR"
OUT_DIR="$DEFAULT_OUT_DIR"
JOBS="$DEFAULT_JOBS"
GEN_DESCRIPTOR=false
DESCRIPTOR_OUT="$OUT_DIR/descriptors.pb"
PLUGIN_NAME="c"                            # protoc-gen-c (libprotobuf-c)
CUSTOM_PLUGIN_PATH=""

while (( $# )); do
  case "$1" in
    -h|--help)                PRINT_HELP=true;;
    -c|--clean)               CLEAN=true;;
    -p|--proto-dir)           PROTO_DIR="$2"; shift;;
    -o|--out-dir)             OUT_DIR="$2"; shift;;
    -j|--jobs)                JOBS="$2"; shift;;
    --plugin)                 PLUGIN_NAME="$2"; shift;;
    --plugin-path)            CUSTOM_PLUGIN_PATH="$2"; shift;;
    --descriptor-set)         GEN_DESCRIPTOR=true;;
    --) shift; break;;
    *) fatal "Unknown argument: $1";;
  esac
  shift
done

if $PRINT_HELP; then
  cat <<EOF
Usage: $SCRIPT_NAME [options]

Options:
  -h, --help             Show this help and exit
  -c, --clean            Remove generated artefacts then exit
  -p, --proto-dir <dir>  Directory containing .proto files  [default: $DEFAULT_PROTO_DIR]
  -o, --out-dir   <dir>  Output directory for generated C  [default: $DEFAULT_OUT_DIR]
  -j, --jobs      <n>    Parallel compilation jobs         [default: $DEFAULT_JOBS]
      --plugin    <n>    Codegen plugin: c | nanopb        [default: c]
      --plugin-path <p>  Override plugin executable path
      --descriptor-set   Additionally emit descriptor set (descriptors.pb)
EOF
  exit 0
fi

################################################################################
# Pre-flight Validation & Environment Setup
################################################################################

[[ -d "$PROTO_DIR" ]] || fatal "Proto directory '$PROTO_DIR' does not exist"
mkdir -p "$OUT_DIR"

# Locate protoc
if ! command -v protoc >/dev/null 2>&1; then
  fatal "'protoc' not found in \$PATH – please install Protocol Buffers compiler"
fi

PROTOC_VER="$(protoc --version | awk '{print $2}')"
if ! semver_ge "$PROTOC_VER" "$MIN_PROTOBUF_VERSION"; then
  fatal "protoc >= $MIN_PROTOBUF_VERSION required (found $PROTOC_VER)"
fi

# Resolve plugin
PLUGIN_EXEC=""
case "$PLUGIN_NAME" in
  c)
    if [[ -n "$CUSTOM_PLUGIN_PATH" ]]; then
      PLUGIN_EXEC="$CUSTOM_PLUGIN_PATH"
    else
      PLUGIN_EXEC="$(command -v protoc-gen-c || true)"
    fi
    [[ -x "$PLUGIN_EXEC" ]] || fatal "protoc-gen-c not found; install 'protobuf-c' package or use --plugin-path"
    PLUGIN_VER="$("$PLUGIN_EXEC" --version | awk '{print $2}')"
    if ! semver_ge "$PLUGIN_VER" "$MIN_PROTOC_C_VERSION"; then
      fatal "protoc-gen-c >= $MIN_PROTOC_C_VERSION required (found $PLUGIN_VER)"
    fi
    PLUGIN_OUT_OPT="--c_out=$OUT_DIR"
    ;;
  nanopb)
    if [[ -n "$CUSTOM_PLUGIN_PATH" ]]; then
      PLUGIN_EXEC="$CUSTOM_PLUGIN_PATH"
    else
      PLUGIN_EXEC="$(command -v nanopb_generator.py || true)"
    fi
    [[ -x "$PLUGIN_EXEC" ]] || fatal "nanopb generator not found; install nanopb or use --plugin-path"
    # generator uses Python; we call protoc with plugin path
    PLUGIN_OUT_OPT="--plugin=protoc-gen-nanopb=$PLUGIN_EXEC --nanopb_out=$OUT_DIR"
    ;;
  *)
    fatal "Unsupported plugin '$PLUGIN_NAME'"
esac

log "✔ Environment validated – protoc $PROTOC_VER, plugin '$PLUGIN_NAME'"

################################################################################
# Clean Target
################################################################################

if $CLEAN; then
  if [[ -d "$OUT_DIR" ]]; then
    log "Cleaning generated artefacts from $OUT_DIR"
    rm -rf "${OUT_DIR:?}/"*
  fi
  success "Clean complete"
  exit 0
fi

################################################################################
# Compilation Functions
################################################################################

compile_proto() {
  local proto="$1"
  local relpath="${proto#$PROTO_DIR/}"
  local proto_dir
  proto_dir="$(dirname "$relpath")"

  mkdir -p "$OUT_DIR/$proto_dir"

  # Determine whether to rebuild (timestamp check)
  local target_c="$OUT_DIR/${relpath%.*}.pb-c.c"
  local target_h="$OUT_DIR/${relpath%.*}.pb-c.h"
  if [[ -f "$target_c" && "$target_c" -nt "$proto" ]]; then
    return 0  # Up-to-date
  fi

  log "Compiling $relpath"
  protoc \
    -I"$PROTO_DIR" \
    $PLUGIN_OUT_OPT \
    "$proto"
}

export -f compile_proto
export PROTO_DIR OUT_DIR PLUGIN_OUT_OPT log

################################################################################
# Gather and Build
################################################################################

mapfile -t PROTO_FILES < <(find "$PROTO_DIR" -name '*.proto' -print0 | xargs -0 -n1 echo | sort)

if [[ "${#PROTO_FILES[@]}" -eq 0 ]]; then
  warn "No .proto files found in $PROTO_DIR"
  exit 0
fi

log "Found ${#PROTO_FILES[@]} schema files – compiling with $JOBS job(s)"
printf '%s\n' "${PROTO_FILES[@]}" | xargs -n1 -P"$JOBS" -I{} bash -c 'compile_proto "$@"' _ {}

success "Protocol Buffers compilation finished"

################################################################################
# Descriptor Set Generation (optional)
################################################################################

if $GEN_DESCRIPTOR; then
  log "Generating descriptor set at $DESCRIPTOR_OUT"
  protoc \
    -I"$PROTO_DIR" \
    --include_imports \
    --descriptor_set_out="$DESCRIPTOR_OUT" \
    "${PROTO_FILES[@]}"
  success "Descriptor set written"
fi

################################################################################
# Summary
################################################################################

log "All tasks complete – artefacts located in $(realpath "$OUT_DIR")"

exit 0
```