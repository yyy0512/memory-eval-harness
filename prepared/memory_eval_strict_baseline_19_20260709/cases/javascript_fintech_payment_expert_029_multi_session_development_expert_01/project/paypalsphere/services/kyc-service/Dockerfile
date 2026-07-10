# syntax=docker/dockerfile:1

###############################################################################
# PayPalsphere – KYC Service Dockerfile
# -----------------------------------------------------------------------------
# • Multi-stage build for small, secure images
# • Non-root runtime user
# • Healthcheck for k8s / Docker Swarm readiness
###############################################################################
ARG NODE_VERSION=20.5.1

###############################################################################
# 1️⃣  Build stage – install dev deps, run tests, compile TypeScript
###############################################################################
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS builder

LABEL org.opencontainers.image.title="paypalsphere/kyc-service"       \
      org.opencontainers.image.description="KYC verification service" \
      org.opencontainers.image.source="https://github.com/paypalsphere/kyc-service" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV APP_HOME=/usr/src/app \
    NODE_ENV=development

WORKDIR $APP_HOME

# Install dependencies (cached layer)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

# Copy source and build
COPY tsconfig*.json ./
COPY src ./src

# Optionally run unit tests before building (fail fast)
# RUN npm test

RUN npm run build

###############################################################################
# 2️⃣  Runtime stage – lightweight, production-only deps
###############################################################################
FROM node:${NODE_VERSION}-slim AS runtime

ENV NODE_ENV=production \
    APP_HOME=/usr/src/app \
    PORT=8080

# Install tini to handle PID 1 correctly
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends tini ca-certificates; \
    rm -rf /var/lib/apt/lists/*

WORKDIR $APP_HOME

# Create an unprivileged user
RUN groupadd -r nodeapp --gid 1001 \
 && useradd -r -g nodeapp --uid 1001 --shell /usr/sbin/nologin nodeapp

# Copy package.json files to install prod deps only
COPY --from=builder $APP_HOME/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled application
COPY --from=builder $APP_HOME/dist ./dist
# Any runtime configs (e.g., OpenAPI specs, policy files)
COPY config ./config

# Tighten permissions
RUN chown -R nodeapp:nodeapp $APP_HOME

USER nodeapp

EXPOSE $PORT

# Simple health check hitting the /health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD node -e "\
  const http=require('http');\
  const options={host:'127.0.0.1',port:process.env.PORT||8080,path:'/health',timeout:5000};\
  const req=http.request(options,res=>process.exit(res.statusCode===200?0:1));\
  req.on('error',()=>process.exit(1));\
  req.end();"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]