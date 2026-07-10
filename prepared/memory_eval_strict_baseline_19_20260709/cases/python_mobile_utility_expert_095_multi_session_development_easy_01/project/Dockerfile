# ------------------------------------------------------------------------------
# PrismPocket – Dockerfile
#
# This Dockerfile produces two images:
#   1. A “builder” stage that installs all Python dependencies with Poetry
#      and compiles native extensions.
#   2. A small, secure runtime stage that copies the virtual-env from the
#      builder image and starts the application under a non-root user.
#
# The resulting image can:
#   • Run unit / integration tests (docker compose run --rm api pytest)
#   • Serve the realtime analytics + sync API (gunicorn/uvicorn)
#   • Perform headless buildozer Android packaging if required
# ------------------------------------------------------------------------------

########################
# 1. Builder stage
########################
FROM python:3.11-slim-bookworm AS builder

# --------------------------------------------------------------------
# Essential OS packages & build tools
# --------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential          \
        gcc                      \
        git                      \
        curl                     \
        libjpeg-dev              \
        libssl-dev               \
        libffi-dev               \
        libbz2-dev               \
        liblzma-dev              \
        zlib1g-dev               \
        libpq-dev                \
        # Mobile build plumbing
        openjdk-17-jdk-headless  \
        unzip                    \
    && rm -rf /var/lib/apt/lists/*

# --------------------------------------------------------------------
# Python environment configuration
# --------------------------------------------------------------------
ENV PIP_NO_CACHE_DIR=off \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PYTHONDONTWRITEBYTECODE=1 \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1 \
    POETRY_VERSION=1.7.1

# Install Poetry for dependency management
RUN curl -sSL https://install.python-poetry.org | python3 - \
    && ln -s /root/.local/bin/poetry /usr/local/bin/poetry

# Create workdir & copy only dependency metadata first
WORKDIR /app
COPY pyproject.toml poetry.lock* ./

# Install dependencies
RUN poetry install --no-root --only main,prod

# Copy the rest of the source code
COPY ./src ./src
COPY ./migrations ./migrations
COPY ./scripts ./scripts

# Run test suite (fail image build if tests fail)
# Comment out to speed up CI if unit tests run earlier.
# RUN poetry run pytest -q

########################
# 2. Runtime stage
########################
FROM python:3.11-alpine3.19 AS runtime

# Add essential runtime packages
RUN apk add --no-cache \
        libjpeg-turbo \
        libstdc++      \
        libbz2         \
        libffi         \
        libpq          \
        ca-certificates

# Copy virtualenv from builder
COPY --from=builder /app/.venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Non-root user for security
RUN addgroup -S prism && adduser -S prism -G prism
USER prism

WORKDIR /app

# Copy application code *minus* test artifacts
COPY --from=builder /app/src ./src
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY pyproject.toml ./pyproject.toml

# Default environment variables (override at runtime)
ENV PRISM_ENV=production \
    PYTHONUNBUFFERED=1 \
    LOG_LEVEL=INFO \
    PORT=8080

# Expose port for API / websocket streams
EXPOSE ${PORT}

# Healthcheck: simple TCP check + HTTP ping fallback
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD \
    wget -qO- http://localhost:${PORT}/health || exit 1

# Entrypoint uses tini to reap zombies and forward signals
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

# Start PrismPocket backend (real-time sync + analytics API)
# Gunicorn worker class can be switched to "uvicorn.workers.UvicornWorker"
# for async behaviour if required.
CMD ["gunicorn", "src.prismpocket.api:app", \
     "--worker-class", "uvicorn.workers.UvicornWorker", \
     "--bind", "0.0.0.0:8080", \
     "--workers", "4", \
     "--log-level", "info"]

# ----------------------------------------------------------------------
# To build:   docker build -t prismpocket:latest .
# To run:     docker run -it --rm -p 8080:8080 prismpocket:latest
# ----------------------------------------------------------------------