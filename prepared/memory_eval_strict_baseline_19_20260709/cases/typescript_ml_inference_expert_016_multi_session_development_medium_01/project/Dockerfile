# -----------------------------------------------------------------------------
# Dockerfile
# InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
# -----------------------------------------------------------------------------
# This multi-stage build produces a minimal, non-root, production-ready
# container image for the TypeScript-based InsightHexaAI service.
#
# Stages:
#   1. deps     : Install and cache node dependencies (incl. dev-deps if desired)
#   2. builder  : Compile TypeScript → JavaScript
#   3. runtime  : Copy compiled output + prod deps into a slim alpine image
# -----------------------------------------------------------------------------

#############################
# 1. Dependencies Layer
#############################
FROM node:18-alpine AS deps

LABEL stage="deps" \
      maintainer="InsightHexaAI DevOps <devops@insighthexa.ai>" \
      org.opencontainers.image.source="https://github.com/InsightHexaAI/ml_inference"

WORKDIR /opt/app

# Install system packages required to build native Node modules.
RUN apk add --no-cache --virtual .build-deps \
        python3 \
        make \
        g++ \
        git

# Only copy manifest files to leverage Docker layer caching.
COPY package.json package-lock.json ./

# Allow opt-in installation of dev dependencies (useful for local testing).
ARG INSTALL_DEV=true
ENV NODE_ENV=production

RUN if [ "$INSTALL_DEV" = "true" ]; then \
        npm ci --legacy-peer-deps ; \
    else \
        npm ci --legacy-peer-deps --omit=dev ; \
    fi

#############################
# 2. Build Layer
#############################
FROM node:18-alpine AS builder

LABEL stage="builder"

WORKDIR /opt/app

# Re-use node_modules from the deps stage for faster builds.
COPY --from=deps /opt/app/node_modules ./node_modules

# Copy the rest of the application source.
COPY tsconfig*.json ./
COPY src ./src
COPY config ./config
COPY prisma ./prisma
COPY scripts ./scripts

# Compile TypeScript sources to the ./dist directory.
RUN npm run build

#############################
# 3. Runtime Layer
#############################
FROM node:18-alpine AS runtime

LABEL maintainer="InsightHexaAI DevOps <devops@insighthexa.ai>" \
      org.opencontainers.image.title="InsightHexaAI - ML Inference" \
      org.opencontainers.image.description="Strategic ML Inference Suite for Enterprise KPIs" \
      org.opencontainers.image.version="1.0.0"

# Install tini for PID 1 & curl for health checks.
RUN apk add --no-cache tini curl

WORKDIR /srv/app
ENV NODE_ENV=production

# Copy production dependencies and compiled code.
COPY --from=deps    /opt/app/node_modules ./node_modules
COPY --from=builder /opt/app/dist        ./dist
COPY config ./config
COPY package.json package-lock.json ./

# Drop privileges to the non-root 'node' user.
RUN chown -R node:node /srv/app
USER node

# Application port
EXPOSE 8080

# Simple healthcheck to verify the service is responding.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Use tini as the init system for proper signal handling & zombie reaping.
ENTRYPOINT ["/sbin/tini", "--"]

# Start the service.
CMD ["node", "dist/main.js"]