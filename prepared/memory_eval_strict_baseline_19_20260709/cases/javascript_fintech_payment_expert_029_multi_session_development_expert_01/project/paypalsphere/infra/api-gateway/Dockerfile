# syntax=docker/dockerfile:1.4

#######################################################################
# PayPalsphere ‒ API Gateway
#
# Description:
#   Multi-stage Dockerfile that builds and packages the Node.js based
#   API-Gateway for the PayPalsphere social-fintech ecosystem.
#
#   Security-by-Design, minimal attack surface, reproducible builds,
#   deterministic dependency graph, non-root execution, SBOM export,
#   and runtime health checks are all first-class citizens.
#
# Image stages:
#   1. base    – common build tooling & CA certificates
#   2. deps    – npm ci (frozen-lockfile) for dependency caching layer
#   3. build   – TypeScript compile & pruning dev deps
#   4. runtime – final minimal image with only production artefacts
#
# Usage:
#   docker build \
#     --build-arg NODE_ENV=production \
#     --build-arg VCS_REF=$(git rev-parse --short HEAD) \
#     --tag ghcr.io/paypalsphere/api-gateway:$(git rev-parse --short HEAD) \
#     .
#######################################################################

###############
# 1. Base
###############
FROM node:18-bookworm-slim AS base
LABEL maintainer="infra@paypalsphere.io"
LABEL org.opencontainers.image.source="https://github.com/paypalsphere/infra"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# Required build arguments (override on CI/CD)
ARG NODE_ENV=development
ENV NODE_ENV=${NODE_ENV}

# Ensure openssl, CA certificates, and tini (for proper signal handling)
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update \
 && apt-get install -y --no-install-recommends \
        ca-certificates \
        openssl \
        dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

################
# 2. Deps layer
################
FROM base AS deps
# Leverage siloed npm cache for reproducible builds & layer caching
RUN --mount=type=cache,target=/root/.npm,sharing=locked true

# Install dependencies based on lock-file only (deterministic)
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts

################
# 3. Build app
################
FROM deps AS build
# Copy rest of the source code
COPY . .

# Generate Software Bill of Materials (SBOM) for compliance/audit
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npx --yes @cyclonedx/bom@latest \
      --omit dev \
      --mc:serialNumber \
      --output ./dist/bom.xml

# Build TypeScript ➜ JavaScript (if tsconfig exists)
RUN if [ -f tsconfig.json ]; then \
        npm run build ; \
    else \
        echo "tsconfig.json not found, skipping compile step."; \
    fi

# Strip dev dependencies for prod build
RUN npm prune --omit=dev

################
# 4. Runtime
################
FROM node:18-alpine3.18 AS runtime

# Inject tiny init for signal forwarding & zombie reaping
COPY --from=base /usr/bin/dumb-init /usr/local/bin/dumb-init

# Use non-root user for runtime security
USER node

# Workdir under node's home directory
WORKDIR /home/node/app

# Copy only built artefacts & node_modules from build stage
COPY --chown=node:node --from=build /usr/src/app/dist ./dist
COPY --chown=node:node --from=build /usr/src/app/package.json ./package.json
COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist/bom.xml ./bom.xml

# Environment variables (document but DO NOT set secrets here)
ENV PORT=8080 \
    # Service discovery endpoints (override at runtime)
    ACCOUNTS_SERVICE_URL=http://accounts:4000 \
    TRANSACTIONS_SERVICE_URL=http://transactions:4001 \
    KYC_SERVICE_URL=http://kyc:4002

EXPOSE ${PORT}

# Minimal runtime dependencies
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache tini

# Healthcheck (expects /health route implemented in gateway)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

# Default command (use tini for proper signal forwarding)
ENTRYPOINT ["dumb-init", "--"]

CMD [ "node", "dist/main.js" ]

#######################################################################
# End of Dockerfile
#######################################################################