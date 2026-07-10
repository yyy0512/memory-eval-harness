# syntax=docker/dockerfile:1.4
#######################################################################
# StreamPulse Nexus – Service: Transcoder
# Dockerfile (multi-stage) – Production-grade container build
#
# This container:
#   • Builds and packages the Node.js-based transcoder micro-service
#   • Installs FFmpeg with commonly-used codecs (libx264, libfdk_aac, etc.)
#   • Runs the service as a non-root user for additional security
#   • Implements health-check, sensible defaults, and build caching
#######################################################################

############################
# — 1. Builder Stage —     #
############################
FROM node:18-bullseye AS builder

# Metadata
LABEL org.opencontainers.image.title="StreamPulse Nexus – Transcoder Service (builder)" \
      org.opencontainers.image.source="https://github.com/streampulse/nexus" \
      org.opencontainers.image.description="Builder image for compiling production JS artifacts and native modules" \
      org.opencontainers.image.licenses="Apache-2.0"

# Prepare work directory
ENV APP_HOME=/srv/app
WORKDIR $APP_HOME

# Install build dependencies for native addons in one layer
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 build-essential git && \
    rm -rf /var/lib/apt/lists/*

# Leverage Docker layer caching for dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# Copy source and build
COPY . .
RUN npm run build

############################
# — 2. Runtime Stage —     #
############################
FROM node:18-bullseye-slim AS runtime

LABEL org.opencontainers.image.title="StreamPulse Nexus – Transcoder Service" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.url="https://streampulse.io" \
      maintainer="infra@streampulse.io"

# Install runtime dependencies (FFmpeg + CA certificates)
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates tini && \
    rm -rf /var/lib/apt/lists/*

# Configure app environment
ENV NODE_ENV=production \
    APP_HOME=/srv/app \
    PORT=8080 \
    # Avoid log timestamps duplication when Docker already timestamps logs
    LOG_PRETTY=true

WORKDIR ${APP_HOME}

# Copy only the built artifacts & production node_modules
COPY --from=builder ${APP_HOME}/dist ./dist
COPY --from=builder ${APP_HOME}/node_modules ./node_modules
COPY --from=builder ${APP_HOME}/package.json ./

# Create non-root user (UID 10001).
RUN addgroup --system --gid 10001 appgroup && \
    adduser  --system --uid 10001 --ingroup appgroup --disabled-password appuser && \
    chown -R appuser:appgroup ${APP_HOME}

USER appuser

# Expose gRPC / REST gateway port
EXPOSE ${PORT}

# Healthcheck – ensure process responds on its metrics endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT,path:'/health'},res=>process.exit(res.statusCode===200?0:1)).on('error',()=>process.exit(1));"

# Use tini as PID1 for proper signal forwarding / zombie reaping
ENTRYPOINT ["/usr/bin/tini", "--"]

# Default command
CMD ["node", "dist/index.js"]
