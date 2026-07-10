# syntax=docker/dockerfile:1.4

#####################################################################
# Stage 1 — Build the TypeScript sources and gather production deps #
#####################################################################
FROM --platform=$BUILDPLATFORM node:18.16-alpine AS builder

LABEL maintainer="SocialPulse Engineering <eng@socialpulse.io>"
LABEL stage="builder"

#--------------------------------------------------------------------
# Build-time arguments
#--------------------------------------------------------------------
ARG NODE_ENV=production
ARG COMMIT_SHA=dev
ARG VERSION=0.0.0-dev
ARG BUILD_TIME
# NOTE: BUILD_TIME can be supplied by CI: `docker build --build-arg BUILD_TIME=$(date -u +'%Y-%m-%dT%H:%M:%SZ') .`

#--------------------------------------------------------------------
# Global environment configuration
#--------------------------------------------------------------------
ENV NODE_ENV=${NODE_ENV} \
    TZ=UTC \
    # keep npm output short & sweet
    NPM_CONFIG_LOGLEVEL=warn \
    # allow root install inside container without permission errors
    npm_config_user=root

WORKDIR /usr/src/app

#--------------------------------------------------------------------
# Install build tooling for native Node add-ons (bcrypt, grpc, etc.)
#--------------------------------------------------------------------
RUN apk add --no-cache --virtual .gyp python3 make g++

#--------------------------------------------------------------------
# Copy dependency manifests first to leverage Docker layer caching
#--------------------------------------------------------------------
COPY package.json package-lock.json tsconfig.json ./

# Optional: deterministic builds when using pnpm
COPY pnpm-lock.yaml* ./

#--------------------------------------------------------------------
# Install all dependencies (devDependencies required for tsc)
# Mount npm cache for faster subsequent builds on same host
#--------------------------------------------------------------------
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

#--------------------------------------------------------------------
# Copy remaining source code
#--------------------------------------------------------------------
COPY ./src            ./src
COPY ./graphql        ./graphql
COPY ./prisma         ./prisma
COPY ./public         ./public

#--------------------------------------------------------------------
# Generate Prisma client (if repository contains schema)
#--------------------------------------------------------------------
RUN npm run --if-present prisma:generate

#--------------------------------------------------------------------
# Compile TypeScript -> JavaScript
#--------------------------------------------------------------------
RUN npm run build

#--------------------------------------------------------------------
# Remove dev dependencies to shrink final artifact
#--------------------------------------------------------------------
RUN npm prune --omit=dev && \
    # source no longer needed once compiled
    rm -rf ./src ./graphql ./prisma

#####################################################################
# Stage 2 — Create an ultra-slim, non-root runtime image           #
#####################################################################
FROM --platform=$TARGETPLATFORM node:18.16-alpine AS runtime

LABEL maintainer="SocialPulse Engineering <eng@socialpulse.io>"
LABEL org.opencontainers.image.source="https://github.com/socialpulse/api_gateway"
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.opencontainers.image.version=$VERSION
LABEL stage="runtime"

#--------------------------------------------------------------------
# Runtime environment variables
#--------------------------------------------------------------------
ENV NODE_ENV=production \
    PORT=8080 \
    # Disable npm’s update notifier & progress bars for noisy logs
    NO_UPDATE_NOTIFIER=true \
    NPM_CONFIG_PROGRESS=false \
    # Force color in logs for better readability in Kubernetes
    FORCE_COLOR=1

WORKDIR /opt/app

#--------------------------------------------------------------------
# Drop root privileges
#--------------------------------------------------------------------
RUN addgroup --system --gid 1001 gateway && \
    adduser --system --uid 1001 --ingroup gateway gateway

#--------------------------------------------------------------------
# Copy compiled application, production deps & assets from builder
#--------------------------------------------------------------------
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist         ./dist
COPY --from=builder /usr/src/app/public       ./public

#--------------------------------------------------------------------
# Expose REST & GraphQL default port
#--------------------------------------------------------------------
EXPOSE 8080

#--------------------------------------------------------------------
# Health-check (expects Express ⟨/health⟩ or Apollo Server ⟨/health⟩ route)
#--------------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

USER 1001

#--------------------------------------------------------------------
# Launch the gateway
#--------------------------------------------------------------------
CMD ["node", "dist/main.js"]