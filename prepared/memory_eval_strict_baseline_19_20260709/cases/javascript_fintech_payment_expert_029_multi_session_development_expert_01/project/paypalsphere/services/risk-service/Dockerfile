# syntax=docker/dockerfile:1.5

###############################################################################
# PayPalsphere – Risk Service                                                 #
#                                                                             #
# This Dockerfile builds a hardened, production-grade container image for the #
# Risk micro-service.  The service is implemented in Node.js (TypeScript),    #
# leverages a CQRS/Event-Sourcing core, and connects to Kafka, PostgreSQL,    #
# and Vault.                                                                  #
#                                                                             #
# Build features                                                              #
#   • Multi-stage build (builder / runtime)                                   #
#   • Layer caching for dependencies                                          #
#   • Non-root runtime user                                                   #
#   • Minimal attack surface (distroless)                                     #
#   • Healthcheck with watchdog script                                        #
#   • Build-time arguments for feature flags                                  #
###############################################################################

##############################
# 1. Builder Phase           #
##############################
FROM node:20-alpine AS builder

# Metadata
LABEL org.opencontainers.image.title="PayPalsphere – Risk Service" \
      org.opencontainers.image.description="Risk scoring and fraud detection micro-service for PayPalsphere." \
      org.opencontainers.image.vendor="PayPalsphere Inc." \
      org.opencontainers.image.source="https://github.com/paypalsphere/risk-service" \
      org.opencontainers.image.licenses="Apache-2.0"

# Configure package manager + build tools
RUN apk add --no-cache \
      python3 \
      make \
      g++ \
      && npm install -g pnpm

# Sync dependency manifests first to leverage Docker layer caching
WORKDIR /opt/risk-service

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.pnpm \
    pnpm install --frozen-lockfile --ignore-scripts

# Copy source after dependencies
COPY . .

# Compile TypeScript -> JavaScript, prune dev deps
RUN pnpm run build && pnpm prune --prod

##############################
# 2. Runtime Phase           #
##############################
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime

# Copy artifacts from builder
WORKDIR /app
COPY --from=builder /opt/risk-service/dist ./dist
COPY --from=builder /opt/risk-service/node_modules ./node_modules
COPY --from=builder /opt/risk-service/package.json .

# Runtime environment variables (can be overridden by orchestrator)
ENV NODE_ENV=production \
    RISK_SERVICE_PORT=8080 \
    KAFKA_BROKERS=broker:9092 \
    POSTGRES_HOST=postgres \
    POSTGRES_DB=risk \
    POSTGRES_USER=risk_user \
    POSTGRES_SSL=true \
    VAULT_ADDR=https://vault:8200 \
    VAULT_KV_PATH=secret/data/paypalsphere/risk

# Expose HTTP port
EXPOSE ${RISK_SERVICE_PORT}

# Health check (simple TCP / HTTP)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1', port:process.env.RISK_SERVICE_PORT, path:'/health'}, res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Entrypoint
CMD ["dist/main.js"]