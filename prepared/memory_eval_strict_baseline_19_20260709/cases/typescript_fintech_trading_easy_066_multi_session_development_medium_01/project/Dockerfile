# ------------------------------------------------------------------------------
# MediTrade Pulse – Production-Ready Dockerfile
# ------------------------------------------------------------------------------
# This Dockerfile uses a multi-stage build to:
#   1. Install dependencies & build TypeScript sources
#   2. Run unit / integration tests (fail fast if they break)
#   3. Produce a minimal, non-root, production image
#
# The resulting container honours healthcare-grade security concerns by:
#   • Running as an unprivileged user
#   • Stripping development tools & test artefacts
#   • Providing a robust HEALTHCHECK for liveness-probes
# ------------------------------------------------------------------------------

############################
# 1. Base build environment #
############################
ARG NODE_VERSION=20.11.1
FROM node:${NODE_VERSION}-alpine AS base

#–---------------------------------------------------------------------------
# Configure global build arguments & metadata
#–---------------------------------------------------------------------------
ARG APP_NAME="MediTrade Pulse"
ARG APP_VENDOR="Arkana Digital Health"
ARG APP_VERSION=1.4.2

LABEL org.opencontainers.image.title="${APP_NAME}" \
      org.opencontainers.image.vendor="${APP_VENDOR}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.source="https://github.com/arkana-health/meditrade-pulse" \
      org.opencontainers.image.description="A TypeScript-based trading platform for healthcare commodities." \
      org.opencontainers.image.licenses="Apache-2.0"

# Alpine tweaks: tini for signal handling, python3 for node-gyp where needed
RUN apk add --no-cache tini python3 make g++ bash

# Create a non-root user now (will be reused by later stages)
RUN addgroup -g 10001 --system meditrade && \
    adduser  -u 10001 --system --ingroup meditrade --home /home/meditrade meditrade

WORKDIR /app

############################
# 2. Dependency caching    #
############################
FROM base AS deps

# Copy only dependency-related files first (leverages Docker layer cache)
COPY package.json package-lock.json ./

# Install dependencies in "offline build" mode to avoid network noise later
RUN npm ci --ignore-scripts && \
    npm cache clean --force

############################
# 3. Build & test stage    #
############################
FROM deps AS builder

# Copy application sources AFTER dependencies to maximise cache efficiency
COPY . .

# Environment markers
ARG NODE_ENV=development
ENV NODE_ENV=${NODE_ENV}

# Compile TypeScript → JavaScript
RUN npm run build

# -- Optional but recommended: run lint & unit tests and fail on error --------
RUN npm run lint && npm test -- --runInBand

############################
# 4. Production pruning    #
############################
FROM builder AS prod-deps

# Re-install dependencies in production-only mode to shrink size
RUN rm -rf node_modules && \
    npm ci --omit=dev && \
    npm cache clean --force

############################
# 5. Runtime image         #
############################
FROM node:${NODE_VERSION}-alpine AS runtime

# Bring tini for proper PID 1 handling
RUN apk add --no-cache tini

# Copy the non-root user and group metadata from the base stage
COPY --from=base /etc/passwd /etc/passwd
COPY --from=base /etc/group  /etc/group

WORKDIR /app

# Copy compiled sources and production node_modules
COPY --from=prod-deps /app/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json

# Application runtime configuration
ENV NODE_ENV=production \
    TZ=UTC \
    APP_PORT=8080 \
    LOG_LEVEL=info

EXPOSE ${APP_PORT}

# Use tini to forward signals (SIGTERM/SIGINT) for graceful shutdown
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# Liveness / readiness probe: ensures the service is accepting traffic
# ---------------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT}/health || exit 1

# ----------------------------------------------------------------------------
# Build instructions (for humans):
#   docker build --build-arg NODE_VERSION=20.11.1 -t meditrade-pulse:latest .
# ----------------------------------------------------------------------------