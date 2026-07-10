```dockerfile
# ────────────────────────────────────────────────────────────────────────────────
# PayPalsphere – Settlement Service
#
# Multi-stage, security-hardened Dockerfile that compiles the TypeScript source,
# runs unit/integration tests, then ships a slim, non-root production image.
#
# Hardened according to:
#   • Docker Bench for Security best-practices
#   • CIS Docker v1.4.0 recommendations
#   • Node.js production guidelines
# ────────────────────────────────────────────────────────────────────────────────

# -------- Base -----------------------------------------------------------------
# syntax=docker/dockerfile:1.4
FROM node:20.11-alpine3.19 AS base

# Set secure defaults
ENV NODE_ENV=production \
    APP_HOME=/opt/paypalsphere/settlement-service \
    # Force Node to listen on the same port internally & externally
    PORT=8080

WORKDIR ${APP_HOME}

# Install tini as PID 1 to handle signals/reaping zombie processes
RUN apk add --no-cache tini

# -------- Dependencies Layer ---------------------------------------------------
FROM base AS deps

# Pre-copy dependency manifests to leverage Docker caching
COPY package.json package-lock.json ./

# Install *only* production dependencies here
RUN --mount=type=cache,target=/home/node/.npm \
    npm ci --ignore-scripts --omit dev

# -------- Build Layer ----------------------------------------------------------
FROM base AS build

# Copy full project to build image
COPY . .

# Install all dependencies (including dev) required for build/test
RUN --mount=type=cache,target=/home/node/.npm \
    npm ci --include dev

# Run linter and unit tests; fail build if they do not pass
RUN npm run lint && npm test -- --ci --coverage

# Compile TypeScript → JavaScript
RUN npm run build

# -------- Runtime Layer --------------------------------------------------------
FROM base AS runtime

# Create an unprivileged user/group with a known UID/GID so that volume mounts
# on Kubernetes/OpenShift have deterministic ownership
RUN addgroup -S paypalsphere && adduser -S paypalsphere -G paypalsphere

# Copy production dependencies
COPY --from=deps ${APP_HOME}/node_modules ./node_modules
# Copy built application (only dist, config, & essential docs)
COPY --from=build  ${APP_HOME}/dist         ./dist
COPY --from=build  ${APP_HOME}/package.json ./
COPY --from=build  ${APP_HOME}/configs      ./configs
COPY --from=build  ${APP_HOME}/migrations   ./migrations

# Ensure correct ownership
RUN chown -R paypalsphere:paypalsphere ${APP_HOME}

USER paypalsphere

# Expose the application port
EXPOSE ${PORT}

# Add a lightweight healthcheck that pings the service’s health endpoint.
# The healthcheck is interpreted by Docker/K8s to restart failing containers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/healthz || exit 1

# Use tini as init system to reap zombies and handle signals
ENTRYPOINT ["/sbin/tini", "--"]

# Default command (may be overridden by docker run or Kubernetes YAML)
CMD ["node", "dist/index.js"]

# -------- Metadata -------------------------------------------------------------
LABEL org.opencontainers.image.title="PayPalsphere – Settlement Service" \
      org.opencontainers.image.description="Microservice responsible for orchestrating multi-party settlement flows, managing ledgers, and emitting CQRS events for downstream services." \
      org.opencontainers.image.authors="PayPalsphere Engineering <engineering@paypalsphere.io>" \
      org.opencontainers.image.source="https://github.com/paypalsphere/settlement-service" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="docker.io/library/node:20-alpine" \
      org.paypalsphere.bounded-context="Settlement" \
      org.paypalsphere.security="field-level-encryption,role-based-policies"
```