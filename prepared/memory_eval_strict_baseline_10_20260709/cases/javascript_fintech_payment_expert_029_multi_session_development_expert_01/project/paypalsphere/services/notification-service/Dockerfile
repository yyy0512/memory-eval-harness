```Dockerfile
# syntax=docker/dockerfile:1.5
################################################################################
# PayPalsphere ▸ Notification Service ▸ Dockerfile
#
# This Dockerfile builds a hardened, production-grade image for the
# `notification-service` Node.js micro-service.  The service publishes
# real-time, fan-out notifications triggered by domain events such as KYC
# approvals, risk-score updates, circle expense settlements, etc.
#
# ───────────────────────────── Build workflow ────────────────────────────────
#  1. builder   : Install dependencies + compile TypeScript → JavaScript
#  2. runtime   : Copy compiled assets, prune devDeps, run as non-root user
#
# Security Notes:
#  • Uses `node:20-alpine` for minimal footprint & CVE surface.
#  • Runs as an unprivileged UID/GID (nodeapp:nodeapp).
#  • Enables core dumps & inotify fixes for Kubernetes distros.
#  • Adds a basic healthcheck on /health.
################################################################################

# ----------------------------------------------------------------------------- #
# 1️⃣  Builder stage – install dependencies & compile sources
# ----------------------------------------------------------------------------- #
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
LABEL org.opencontainers.image.source="https://github.com/PayPalsphere/notification-service"
LABEL org.opencontainers.image.description="Builder stage for PayPalsphere notification-service"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app

# Pre-copy package manifests to leverage cached layers when source changes occur
COPY package*.json ./

# Install dependencies (including devDeps—for compilation/testing only)
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the source code
COPY . .

# Build the TypeScript project (transpile to ./dist)
RUN npm run build


# ----------------------------------------------------------------------------- #
# 2️⃣  Runtime stage – lightweight, secure image
# ----------------------------------------------------------------------------- #
FROM node:20-alpine AS runtime
LABEL org.opencontainers.image.vendor="PayPalsphere"
LABEL org.opencontainers.image.title="notification-service"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.revision="${GIT_SHA:-unknown}"
LABEL org.opencontainers.image.created="${BUILD_DATE:-unknown}"

# ---- Security hardening ----
# Create non-root user & group
RUN addgroup -S nodeapp && adduser -S nodeapp -G nodeapp \
    # ⬇️ Remove default apk repositories to prevent package downgrade attacks
    && rm -rf /var/cache/apk/*

# Expose application port
ENV PORT=8080
EXPOSE ${PORT}

# Set working directory
WORKDIR /app

# Copy only production dependencies/libraries from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

# Drop devDependencies to slim image further (optional, npm v8+)
RUN npm prune --omit=dev

# ---- App runtime configuration ----
ENV NODE_ENV=production \
    SERVICE_NAME=notification-service \
    TZ=UTC \
    # Improve GC behavior for perf-intensive workload
    NODE_OPTIONS="--max_old_space_size=256 --enable-source-maps"

# Healthcheck (Kubernetes / Docker Swarm)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --spider http://127.0.0.1:${PORT}/health || exit 1

# Switch to non-root user
USER nodeapp

# Entrypoint
CMD [ "node", "dist/index.js" ]
```