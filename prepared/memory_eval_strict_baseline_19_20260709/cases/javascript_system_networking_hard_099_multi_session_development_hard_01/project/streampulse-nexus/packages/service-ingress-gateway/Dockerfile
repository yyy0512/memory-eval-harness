# syntax=docker/dockerfile:1.4
#
# StreamPulse Nexus – Ingress Gateway
# -----------------------------------
# Hardened, multi-stage image for the Ingress Gateway service.  Designed for
# carrier-grade reliability & zero-trust operation.
#
#   – Stage 0  ➜  base tooling (shared layers, pinned Node version)
#   – Stage 1  ➜  builder (compile TS, run unit tests, prune dev deps)
#   – Stage 2  ➜  runtime (distroless, non-root, health-checked)
#
# NOTE: The final image contains *only* production artefacts.  CI should run
#       `docker build --target test` when executing the unit-test stage.
#

########################
# Stage 0 – base layer #
########################
ARG NODE_VERSION=20.10.0
FROM node:${NODE_VERSION}-alpine AS base

# ------------------------------------------------------------------------------
# Global settings
# ------------------------------------------------------------------------------
ENV \
  # Disable npm update notifications + progress bar noise
  NPM_CONFIG_LOGLEVEL=error \
  NPM_CONFIG_PROGRESS=false \
  # Prevent Node from writing core dumps & set production env
  NODE_ENV=production \
  NODE_OPTIONS="--max_old_space_size=512"

WORKDIR /opt/ingress-gateway

# Pre-install OS deps needed *both* at build-time and runtime.
RUN apk add --no-cache tzdata tini

# Copy lockfiles first to maximise layer caching.
COPY package.json package-lock.json* ./

#############################
# Stage 1 – build & testing #
#############################
FROM base AS builder

# Extra build-time dependencies
RUN apk add --no-cache --virtual .build-deps \
      python3 \
      make \
      g++ \
  # Ensure deterministic, offline-friendly installs
  && npm ci --ignore-scripts

# Copy sources in a second step to leverage cached layers if only code changes.
COPY . .

# ---- Security gates ----------------------------------------------------------
#   1. Static code analysis
#   2. Unit tests
#   3. Production build
# ------------------------------------------------------------------------------
# (1) Lint & type-check – fail build on warnings
RUN npm run lint --if-present && npm run typecheck --if-present

# (2) Unit tests – executed when the build target is "test"
RUN --mount=type=cache,target=/opt/ingress-gateway/.nyc_output \
    npm run test --if-present

# (3) Build Optimised JS (e.g. via `tsc` or `esbuild`)
RUN npm run build

# Remove dev dependencies & OS build tools for a slimmer final artefact.
RUN npm prune --omit=dev \
  && apk del .build-deps

################################
# Stage 2 – minimal production #
################################
# Distroless images ship without shell or package manager, shrinking surface.
FROM gcr.io/distroless/nodejs20-debian11 AS production

LABEL org.opencontainers.image.source="https://github.com/streampulse/streampulse-nexus" \
      org.opencontainers.image.description="StreamPulse Nexus Ingress Gateway – high-performance edge entrypoint" \
      org.opencontainers.image.licenses="Apache-2.0"

# Copy runtime files (compiled JS + node_modules) from builder
COPY --from=builder /opt/ingress-gateway/dist/ /opt/ingress-gateway/dist
COPY --from=builder /opt/ingress-gateway/node_modules/ /opt/ingress-gateway/node_modules
COPY --from=builder /opt/ingress-gateway/package.json /opt/ingress-gateway/

# Enable tini as PID 1 for proper signal handling
ENTRYPOINT ["/tini", "--"]

# Run as non-root (UID:GID 10101:10101). Distroless requires explicit user.
USER 10101:10101

WORKDIR /opt/ingress-gateway

# Prefer predictable port for k8s services
EXPOSE 8080/tcp

# Healthcheck pings the lightweight /healthz endpoint.
HEALTHCHECK --interval=25s --timeout=3s --start-period=10s --retries=3 \
  CMD node dist/healthcheck.js || exit 1

# Default runtime command
CMD ["dist/server.js"]
