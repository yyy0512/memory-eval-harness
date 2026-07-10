```dockerfile
###############################################################################
# QuestSmith – Productivity RPG Forge
# Dockerfile
#
# This Dockerfile is intended for CI / CD pipelines and local development.
# It performs a multi-stage build that:
#   1. Creates a fully reproducible build environment with all native libs
#      required for Kivy and mobile-specific adapters (location, biometrics,
#      push notifications, etc.).
#   2. Installs Python dependencies in a dedicated virtual environment.
#   3. Copies the QuestSmith source tree and performs unit tests.
#   4. Produces a slim, non-root runtime image containing only what is
#      necessary to execute the application with optimal startup time.
#
# NOTE: The container is *not* meant to ship a GUI; instead, it exposes a
#       headless “simulation” mode for automated test runs. Mobile builds
#       (iOS / Android) are produced via buildozer or Xcode within a separate
#       job that reuses the same builder stage for dependency caching.
###############################################################################

#########################
# 1 – Builder Stage     #
#########################
FROM python:3.11-bookworm AS builder

LABEL maintainer="QuestSmith Team <dev@questsmith.app>" \
      org.opencontainers.image.source="https://github.com/QuestSmith/mobile_game" \
      org.opencontainers.image.description="Builder image for QuestSmith RPG Forge"

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
#   • build-essential          – C/C++ toolchain for wheel compilation
#   • libgl1-mesa-dev          – OpenGL headers for Kivy
#   • libglu1-mesa-dev         – GLU headers
#   • libsdl2-dev              – Required by Kivy for windowing (even in headless)
#   • libmtdev-dev, xclip      – Touch / clipboard backends
#   • libavformat-dev, libavcodec-dev, libavdevice-dev – FFmpeg for video / audio
#   • git, curl                – Source fetching / health checks
# ---------------------------------------------------------------------------
RUN apt-get update -qq && \
    DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends \
        build-essential \
        libgl1-mesa-dev \
        libglu1-mesa-dev \
        libsdl2-dev \
        libmtdev-dev \
        libavformat-dev \
        libavcodec-dev \
        libavdevice-dev \
        xclip \
        git \
        curl \
        ca-certificates && \
    # Clean up APT cache to keep the image lean.
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Virtual environment & Python dependencies
# ---------------------------------------------------------------------------
ENV VENV_PATH="/opt/venv"
RUN python -m venv ${VENV_PATH}
ENV PATH="${VENV_PATH}/bin:${PATH}"

# Copy only the dependency manifests to leverage Docker layer caching
WORKDIR /build
COPY pyproject.toml poetry.lock ./

# Use Poetry for deterministic dependency resolution
RUN pip install --no-cache-dir poetry==1.8.2 && \
    poetry config virtualenvs.create false && \
    poetry install --no-interaction --only main

# ---------------------------------------------------------------------------
# Copy application source
# ---------------------------------------------------------------------------
COPY . /build

# ---------------------------------------------------------------------------
# Run unit tests
# ---------------------------------------------------------------------------
# Failing tests will fail the Docker build, protecting main branch integrity.
RUN poetry run pytest -q

#########################
# 2 – Runtime Stage     #
#########################
FROM python:3.11-slim-bookworm AS runtime

LABEL maintainer="QuestSmith Team <dev@questsmith.app>"

# ---------------------------------------------------------------------------
# Python virtual environment (copied from builder to keep layers minimal)
# ---------------------------------------------------------------------------
ENV VENV_PATH="/opt/venv"
COPY --from=builder ${VENV_PATH} ${VENV_PATH}
ENV PATH="${VENV_PATH}/bin:${PATH}"

# ---------------------------------------------------------------------------
# Non-root user for security
# ---------------------------------------------------------------------------
ENV APP_USER=questsmith
RUN addgroup --system ${APP_USER} && \
    adduser  --system --ingroup ${APP_USER} --home /home/${APP_USER} ${APP_USER}
USER ${APP_USER}

# ---------------------------------------------------------------------------
# Application setup
# ---------------------------------------------------------------------------
WORKDIR /app
COPY --chown=${APP_USER}:${APP_USER} ./src /app/src
COPY --chown=${APP_USER}:${APP_USER} ./assets /app/assets
COPY --chown=${APP_USER}:${APP_USER} ./entrypoint.py /app/

# Runtime variables
ENV QUESTSMITH_ENV=production \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    # Default to “simulation” mode to avoid requiring a display server
    QUESTSMITH_HEADLESS=1 \
    # Sentry DSN for crash reporting (overridden in CI/CD secrets)
    SENTRY_DSN=""

# ---------------------------------------------------------------------------
# Healthcheck: ensure the Python interpreter can import the main package.
# ---------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import importlib, sys; sys.exit(0 if importlib.util.find_spec('questsmith') else 1)"

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
ENTRYPOINT ["python", "/app/entrypoint.py"]
CMD ["--help"]
```