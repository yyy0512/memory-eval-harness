#!/usr/bin/env bash
#
# setup_dev_env.sh
#
# PaletteFlux GraphQL Studio – Development Environment Bootstrapper
#
# This script bootstraps a fully–functional C++ development environment for the
# PaletteFlux GraphQL Studio backend as well as the companion tooling required
# for schema generation, testing, and documentation.  The script is designed to
# be idempotent; it can be run multiple times without harming an existing setup.
#
# Supported host operating systems:
#   • macOS 12+
#   • Ubuntu 20.04 / 22.04
#
# High-level tasks:
#   1. Verify/Install core build utilities (git, cmake, ninja, clang/gcc)
#   2. Bootstrap the package manager (Homebrew / APT) and required libraries
#   3. Initialize & update Git submodules
#   4. Prepare a local Conan profile and resolve C++ dependencies
#   5. Build third-party libraries (if necessary)
#   6. Create Python and Node.js environments for tooling
#   7. Install Git hooks (clang-format, commit-msg linter)
#
# NOTE: The script purposefully avoids using `sudo` without explicit user
# consent to prevent unintended system mutations.
#

set -Eeuo pipefail

################################################################################
# Utility Functions
################################################################################

# ANSI colour escapes
readonly _clr_reset="\033[0m"
readonly _clr_red="\033[31m"
readonly _clr_green="\033[32m"
readonly _clr_yellow="\033[33m"
readonly _clr_blue="\033[34m"
readonly _clr_magenta="\033[35m"

msg()     { printf "${_clr_blue}▶ %s${_clr_reset}\n" "$*"; }
success() { printf "${_clr_green}✔ %s${_clr_reset}\n" "$*"; }
warn()    { printf "${_clr_yellow}⚠ %s${_clr_reset}\n" "$*" >&2; }
err()     { printf "${_clr_red}✖ %s${_clr_reset}\n" "$*" >&2; exit 1; }

trap 'err "Unexpected error on line $LINENO."' ERR

################################################################################
# Environment Detection
################################################################################

OS_NAME=""
PKG_MGR=""
SUDO=""

detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS_NAME="macos"
        PKG_MGR="brew"
    elif [[ -f /etc/lsb-release ]]; then
        . /etc/lsb-release
        if [[ "$DISTRIB_ID" == "Ubuntu" ]]; then
            OS_NAME="ubuntu"
            PKG_MGR="apt-get"
            SUDO="sudo"
        fi
    fi

    [[ -n "$OS_NAME" ]] || err "Unsupported operating system: $OSTYPE"
    msg "Detected operating system: $OS_NAME"
}

################################################################################
# Sanity Checks
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

[[ -f ".git" || -d ".git" ]] || err "Not inside the repository root!"

################################################################################
# Dependency Installation
################################################################################

pkg_install() {
    # $1 ... package names (space-delimited)
    local packages=("$@")
    case "$PKG_MGR" in
        brew)
            if ! command -v brew >/dev/null 2>&1; then
                warn "Homebrew not found. Installing Homebrew..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
                eval "$(/opt/homebrew/bin/brew shellenv)"
            fi
            brew update
            brew install "${packages[@]}"
            ;;
        apt-get)
            $SUDO apt-get update -qq
            $SUDO apt-get install -y "${packages[@]}"
            ;;
        *)
            err "Internal error: unknown package manager '$PKG_MGR'"
            ;;
    esac
}

ensure_cmd() {
    # $1 ... command name
    # $2+ .. package(s) providing the command
    local cmd="$1"; shift
    if ! command -v "$cmd" >/dev/null 2>&1; then
        warn "Missing required command '$cmd'. Attempting to install…"
        pkg_install "$@"
        command -v "$cmd" >/dev/null 2>&1 || err "Failed to install '$cmd'."
        success "Installed '$cmd'."
    fi
}

install_core_dependencies() {
    msg "Verifying core build dependencies…"
    ensure_cmd git git
    ensure_cmd cmake cmake
    ensure_cmd ninja ninja-build
    ensure_cmd python3 python3
    ensure_cmd pip3 python3-pip
    ensure_cmd node nodejs
    ensure_cmd npm npm
    # Compiler: prefer clang, fallback to gcc
    if ! command -v clang++ >/dev/null 2>&1; then
        ensure_cmd g++ g++
    fi
}

################################################################################
# Git Submodules & Hooks
################################################################################

setup_submodules() {
    msg "Syncing git submodules…"
    git submodule sync --quiet
    git submodule update --init --recursive --jobs 4
    success "Git submodules are up to date."
}

setup_git_hooks() {
    msg "Installing git hooks…"
    local hooks_dir="$PROJECT_ROOT/.githooks"
    local git_hooks="$PROJECT_ROOT/.git/hooks"

    mkdir -p "$hooks_dir"
    # Example hook: clang-format on pre-commit
    cat > "$hooks_dir/pre-commit" <<'EOF'
#!/usr/bin/env bash
# Auto-format C++ files before committing

# Staged files
FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(cpp|hpp|cc|hh|c\+\+|h)$')
if [[ -z $FILES ]]; then
    exit 0
fi

if ! command -v clang-format >/dev/null 2>&1; then
    echo "clang-format not found; skipping formatting." >&2
    exit 0
fi

clang-format -i $FILES
git add $FILES
EOF
    chmod +x "$hooks_dir/pre-commit"
    ln -sf "../../.githooks/pre-commit" "$git_hooks/pre-commit"
    success "Git hooks installed."
}

################################################################################
# Conan (C++ Package Manager)
################################################################################

setup_conan() {
    msg "Configuring Conan package manager…"
    python3 -m pip install --user --upgrade "conan>=2.0,<3.0"

    # Ensure ~/.local/bin is on PATH (pip install location)
    export PATH="$HOME/.local/bin:$PATH"

    if ! command -v conan >/dev/null 2>&1; then
        err "Conan installation failed or not on PATH."
    fi

    # Generate default profile if it doesn't exist
    if ! conan profile path default >/dev/null 2>&1; then
        conan profile detect --force
    fi

    # Force C++17 standard & release mode by default
    conan profile update settings.compiler.cppstd=17 default
    conan profile update settings.build_type=Release default

    # Resolve dependencies declared in conanfile
    conan install . --output-folder=build/conan --build=missing

    success "Conan dependencies resolved."
}

################################################################################
# Python Tooling
################################################################################

setup_python_env() {
    msg "Setting up Python tooling…"
    local venv_dir=".venv"

    if [[ ! -d "$venv_dir" ]]; then
        python3 -m venv "$venv_dir"
    fi

    # shellcheck disable=SC1091
    source "$venv_dir/bin/activate"
    pip install --upgrade pip
    pip install -r scripts/requirements.txt
    deactivate
    success "Python environment ready."
}

################################################################################
# Node.js Tooling
################################################################################

setup_node_env() {
    msg "Installing Node.js dependencies…"
    pushd tools/graphql_schema >/dev/null || return
    npm ci
    popd >/dev/null || return
    success "Node.js tooling installed."
}

################################################################################
# Build Third-Party Libraries (optional example)
################################################################################

build_third_party() {
    msg "Building vendored third-party libraries…"
    cmake -S tools/third_party -B build/third_party -GNinja -DCMAKE_BUILD_TYPE=Release
    cmake --build build/third_party
    success "Third-party libraries built."
}

################################################################################
# Main Execution Flow
################################################################################

main() {
    detect_os
    install_core_dependencies
    setup_submodules
    setup_git_hooks
    setup_conan
    setup_python_env
    setup_node_env
    build_third_party

    success "Development environment setup complete. Happy hacking! 🚀"
}

main "$@"