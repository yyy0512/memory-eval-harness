# syntax=docker/dockerfile:1.4
#
# PaletteFlux GraphQL Studio – Production Container
# -------------------------------------------------
# This multi-stage Dockerfile compiles the PaletteFlux C++ sources with
# CMake in an isolated build stage and then assembles an ultra-slim
# runtime image.  It enforces best-practices such as non-root execution,
# reproducible layer caching, and health-checking.
#
# Supported build-time ARGs:
#   - BUILD_TYPE  (Debug | Release, default: Release)
#   - WITH_TESTS  (ON | OFF,         default: OFF)
#   - JOBS        (parallel build threads, default: nproc)
#
# Mandatory run-time ENVs (can be overridden at `docker run`):
#   - PALETTEFLUX_HTTP_PORT     (exposed, default: 8080)
#   - PALETTEFLUX_ADMIN_PORT    (exposed, default: 9090)
#   - PALETTEFLUX_CONFIG_FILE   (config path, default: /etc/paletteflux/config.yaml)
# ------------------------------------------------------------------------------

########################
# 1️⃣  Build Stage
########################
FROM ubuntu:22.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG BUILD_TYPE=Release
ARG WITH_TESTS=OFF
ARG JOBS

# ---------------------------------------------------------------------------
# Install build toolchain & runtime libraries required *only* for compilation
# ---------------------------------------------------------------------------
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        ninja-build \
        pkg-config \
        libssl-dev \
        libcurl4-openssl-dev \
        libpq-dev \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Create a dedicated non-privileged user for building
RUN useradd --system --create-home --shell /usr/sbin/nologin builder
USER builder
WORKDIR /home/builder

# Copy source code into the container
# Leverage Docker-layer caching by copying dependency manifests first
COPY --chown=builder:builder CMakeLists.txt .
COPY --chown=builder:builder cmake/ cmake/
COPY --chown=builder:builder src/ src/
COPY --chown=builder:builder include/ include/
COPY --chown=builder:builder third_party/ third_party/

# ---------------------------------------------------------------------------
# Configure & build with CMake
# ---------------------------------------------------------------------------
RUN --mount=type=cache,target=/home/builder/.cache \
    mkdir -p build && cd build && \
    cmake -G Ninja \
          -DCMAKE_BUILD_TYPE=${BUILD_TYPE} \
          -DPALETTEFLUX_BUILD_TESTS=${WITH_TESTS} \
          -DCMAKE_INSTALL_PREFIX=/opt/paletteflux \
          -DPALETTEFLUX_VERSION_SOURCE=git \
          .. && \
    ninja -j ${JOBS:-$(nproc)} && \
    DESTDIR=/tmp/install ninja install

########################
# 2️⃣  Runtime Stage
########################
FROM debian:stable-slim AS runtime

# Minimal runtime dependencies
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends \
        libssl3 \
        libcurl4 \
        libpq5 \
        ca-certificates \
        curl && \
    rm -rf /var/lib/apt/lists/*

# Create runtime application user
RUN useradd --create-home --shell /usr/sbin/nologin paletteflux
USER paletteflux
WORKDIR /home/paletteflux

# Copy binaries and assets from the build stage
COPY --from=builder /tmp/install/opt/paletteflux /opt/paletteflux

# Add a minimal entrypoint to wrap the binary for graceful shutdown
COPY --from=builder /home/builder/src/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Environment defaults (can be overridden at runtime)
ENV PALETTEFLUX_HTTP_PORT=8080 \
    PALETTEFLUX_ADMIN_PORT=9090 \
    PALETTEFLUX_CONFIG_FILE=/etc/paletteflux/config.yaml \
    LD_LIBRARY_PATH=/opt/paletteflux/lib:${LD_LIBRARY_PATH}

# Expose HTTP (public) and gRPC/Admin ports
EXPOSE ${PALETTEFLUX_HTTP_PORT}/tcp \
       ${PALETTEFLUX_ADMIN_PORT}/tcp

# Health-check – queries the lightweight REST health endpoint
HEALTHCHECK --interval=30s --timeout=4s --retries=3 CMD \
  curl -f http://127.0.0.1:${PALETTEFLUX_HTTP_PORT}/healthz || exit 1

# Entrypoint responsible for:
#   - Translating ENV ↔ CLI flags
#   - Dropping capabilities if needed
#   - Forwarding signals (SIGTERM) for graceful shutdown
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default CMD to run the GraphQL/REST service
CMD ["/opt/paletteflux/bin/paletteflux_server"]
