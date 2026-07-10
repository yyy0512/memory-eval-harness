# syntax=docker/dockerfile:1.4
###############################################################################
# StreamPulse Nexus – service-media-orchestrator                              #
#                                                                             #
# Multi-stage Dockerfile that produces a minimal, production-ready image for  #
# the Media Orchestrator service.                                             #
#                                                                             #
# Key features                                                               #
#  - Builder stage installs full deps & compiles TypeScript → JS.             #
#  - Runtime stage copies compiled artifacts & prod deps only.                #
#  - Non-root execution for container hardening.                              #
#  - Built-in HEALTHCHECK for Kubernetes / Docker Swarm probes.               #
#  - Optional Snyk / Trivy security scan targets.                             #
###############################################################################

############################
# 1. Builder stage         #
############################
FROM node:20-alpine AS builder

# Fail fast + log what’s happening
ENV \
  NODE_ENV=development \
  NPM_CONFIG_LOGLEVEL=warn \
  # Ensure consistent, reproducible builds
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  # Yarn v2+ would need different settings; keeping npm for simplicity
  CI=true

WORKDIR /usr/src/app

# Install build toolchain utilities
RUN apk add --no-cache --virtual .build-deps \
    git \
    bash \
    python3 \
    make \
    g++ \
    && echo "Build dependencies installed."

# Copy dependency manifests first to leverage Docker cache layer
COPY package*.json ./

# Install all dependencies, including devDeps for building
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

# Copy the rest of the project files
COPY . .

# Type-checking & transpilation
RUN npm run build && \
    npm prune --omit=dev

############################
# 2. Runtime stage         #
############################
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/streampulse/streampulse-nexus" \
      org.opencontainers.image.description="StreamPulse Nexus - Media Orchestrator Service" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.title="service-media-orchestrator" \
      org.opencontainers.image.version="1.0.0"

# Environment variables
ENV NODE_ENV=production \
    APP_PORT=8080 \
    TZ=UTC \
    # Toggle runtime debug logs (overridden at runtime via `-e`)
    DEBUG_LEVEL=info

WORKDIR /usr/src/app

# Copy production node_modules and compiled output from builder
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package*.json ./

###############################################################################
# Security hardening                                                          #
###############################################################################
# Add non-root, least-privilege user
RUN addgroup -S nexus && adduser -S nexus -G nexus && \
    # Remove unnecessary packages to keep attack surface minimal
    apk del --no-network --purge && \
    rm -rf /var/cache/apk/*

USER nexus

# Expose application port
EXPOSE ${APP_PORT}

###############################################################################
# Health & Observability                                                      #
###############################################################################
# Healthcheck endpoint (expects Express route /healthz returning 200)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${APP_PORT}/healthz || exit 1

###############################################################################
# Entrypoint                                                                  #
###############################################################################
# Using tini for signal handling & zombie reaping
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/index.js"]

###############################################################################
# 3. (Optional) Security scanning stage                                       #
###############################################################################
# Trigger with: `docker build --target scan -t orchestrator-scan .`
FROM aquasec/trivy:latest AS scan
COPY --from=runtime / /
# Skip exit code so CI can parse results separately
RUN trivy fs --exit-code 0 --severity MEDIUM,HIGH,CRITICAL /