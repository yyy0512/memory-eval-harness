# syntax=docker/dockerfile:1.4

#######################################################################
# PayPalsphere – Transactions Service
# Production-grade, multi-stage Dockerfile
#
#   • Installs only production dependencies
#   • Leverages Docker BuildKit cache layers
#   • Runs as a non-root, least-privileged user
#   • Performs basic runtime health checks
#   • Adds build-time metadata for traceability
#######################################################################

########################
# Base image & metadata
########################
FROM node:20-alpine AS base

ARG SERVICE_NAME="transactions-service"
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown
ARG VERSION=unknown

# Labels improve traceability and support SBOM tools
LABEL org.opencontainers.image.source="https://github.com/PayPalsphere/${SERVICE_NAME}" \
      org.opencontainers.image.revision="${BUILD_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="PayPalsphere – ${SERVICE_NAME}" \
      org.opencontainers.image.description="Handles all payment transactions, CQRS write model and event sourcing." \
      maintainer="infra@paypalsphere.io"

# -----------------------------------------------------------------------------
# Global environment defaults
# -----------------------------------------------------------------------------
ENV NODE_ENV=production \
    # Disable npm update notifications
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    # Ensure packages write cache to /tmp, not image layer
    npm_config_cache=/tmp/.npm

# Install tini for better signal handling (avoid zombie processes)
RUN apk add --no-cache tini

# Switch tini as our entrypoint for proper PID 1
ENTRYPOINT ["/sbin/tini", "--"]

########################################
# Builder Stage – install dependencies
########################################
FROM base AS builder

# Install build tools only when needed
RUN apk add --no-cache --virtual .gyp \
        python3 \
        make \
        g++

WORKDIR /usr/src/app

# Leverage package manager caching
COPY package.json package-lock.json* ./

# Use npm ci for deterministic builds
RUN npm ci --omit=dev --ignore-scripts

########################################
# Runtime Stage – copy artifacts only
########################################
FROM base AS runtime

# Create non-root user and group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /usr/src/app

# Copy production node_modules from builder
COPY --chown=appuser:appgroup --from=builder /usr/src/app/node_modules ./node_modules

# Copy source code
COPY --chown=appuser:appgroup ./src ./src
COPY --chown=appuser:appgroup ./*.js ./

# Copy any additional config (OpenAPI, env template, etc.)
COPY --chown=appuser:appgroup ./config ./config

# Ensure node cannot write where it shouldn't
RUN chmod -R 750 /usr/src/app

USER appuser

EXPOSE 8080

# ------------------------
# HEALTHCHECK
# ------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# ------------------------
# CMD
# ------------------------
CMD ["node", "src/index.js"]
