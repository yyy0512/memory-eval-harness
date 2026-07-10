# syntax=docker/dockerfile:1

###############################################################################
# ChromaticCanvas Control Center (web_dashboard) – Production Dockerfile
#
# This multi-stage Dockerfile builds both the backend (Actix-/Axum-powered
# REST service) and the Yew + Tailwind WASM frontend, then stitches them
# together in a secure, minimal runtime image.
#
# Highlights
# ----------
# • Reproducible, cache-friendly Rust compilation via `cargo-chef`
# • Wasm32 target & `trunk` for Yew frontend
# • Non-root runtime user, SSL‐ready, healthcheck endpoint
# • Environment variables for fine-tuned observability
###############################################################################

##############################
#   0) Build arguments       #
##############################
ARG RUST_VERSION=1.74.1
ARG DEBIAN_SUITE=bookworm
ARG APP_USER=chroma
ARG SERVER_PORT=8080

##############################
#   1) Dependency Caching    #
##############################
FROM rust:${RUST_VERSION}-slim-${DEBIAN_SUITE} AS chef
# Install cargo-chef for dependency layer caching.
RUN cargo install cargo-chef
WORKDIR /app

# Copy manifests only (no source) to maximize cache hits.
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY backend/Cargo.toml backend/
COPY frontend/Cargo.toml frontend/
# Generate the lock-file recipe.
RUN cargo chef prepare --recipe-path recipe.json

##############################
#   2) Backend Builder       #
##############################
FROM rust:${RUST_VERSION}-slim-${DEBIAN_SUITE} AS backend-builder

# 2-a) Install build tooling
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        libssl-dev pkg-config clang; \
    rm -rf /var/lib/apt/lists/*

# 2-b) Restore recipe & build deps (cached separately)
WORKDIR /app
COPY --from=chef /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json

# 2-c) Copy actual source & compile
COPY . .
RUN cargo build --release --package chromatic_canvas_cc \
    && strip target/release/chromatic_canvas_cc

##############################
#   3) Frontend Builder      #
##############################
FROM rust:${RUST_VERSION}-slim-${DEBIAN_SUITE} AS frontend-builder

# 3-a) System deps: node (for tailwind), trunk, wasm target
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        curl npm ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# Rust WASM target & trunk
RUN rustup target add wasm32-unknown-unknown && \
    cargo install trunk wasm-bindgen-cli

# 3-b) Tailwind standalone binary (upstream official)
RUN curl -fsSL https://github.com/tailwindlabs/tailwindcss/releases/download/v3.3.5/tailwindcss-linux-x64 \
    -o /usr/local/bin/tailwindcss && chmod +x /usr/local/bin/tailwindcss

WORKDIR /app/frontend
COPY frontend .

# 3-c) Build Yew app (index.html, .wasm, CSS) into `/app/dist`
RUN trunk build --release --public-url /static --dist /app/dist

##############################
#   4) Minimal Runtime       #
##############################
FROM debian:${DEBIAN_SUITE}-slim AS runtime

# 4-a) Install runtime libs only
RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates libssl3 curl; \
    rm -rf /var/lib/apt/lists/*

# 4-b) Create non-root app user
ARG APP_USER
RUN useradd -U -m -s /usr/sbin/nologin ${APP_USER}

# 4-c) Copy backend binary & static assets
COPY --from=backend-builder /app/target/release/chromatic_canvas_cc /usr/local/bin/chromatic_canvas
COPY --from=frontend-builder /app/dist /var/www/chromatic_canvas/static

# 4-d) Permissions hardening
RUN chown -R ${APP_USER}:${APP_USER} /usr/local/bin/chromatic_canvas /var/www/chromatic_canvas \
    && chmod -R 750 /var/www/chromatic_canvas

USER ${APP_USER}
WORKDIR /home/${APP_USER}

##############################
#   5) Runtime Configuration #
##############################

# Expose HTTP(S) ports
ARG SERVER_PORT
EXPOSE ${SERVER_PORT}

# Application-level environment flags
ENV ROCKET_ENV=production \
    RUST_LOG=info,chromatic_canvas=info \
    STATIC_ASSETS_ROOT=/var/www/chromatic_canvas/static \
    SERVER_PORT=${SERVER_PORT}

# Simple liveness probe (expects a `/api/health` JSON endpoint).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD curl -f http://localhost:${SERVER_PORT}/api/health || exit 1

# Entrypoint
ENTRYPOINT ["/usr/local/bin/chromatic_canvas"]