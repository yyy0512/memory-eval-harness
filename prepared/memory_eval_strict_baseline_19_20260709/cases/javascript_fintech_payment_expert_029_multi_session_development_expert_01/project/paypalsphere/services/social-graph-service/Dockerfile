# ------------------------------------------------------------------------------
# PayPalsphere – Social Graph Service
# Production-grade Dockerfile (multi-stage build, non-root, distroless runtime)
# ------------------------------------------------------------------------------

###############
# 1. Builder  #
###############
FROM node:20-slim AS builder

# Set working directory
WORKDIR /usr/src/app

# Install system dependencies required for native Node add-ons & build tools
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy only the package manifests first for better layer caching
COPY package*.json yarn.lock ./

# Install dependencies with frozen lock-file to guarantee reproducible builds
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    corepack enable && \
    yarn install --frozen-lockfile --production=false

# Copy the rest of the application source
COPY . .

# Run unit tests and linters for early failure (fail build if tests fail)
RUN yarn run lint && yarn run test:ci

# Build the Typescript/ESM bundles
RUN yarn run build

################
# 2. Runtime   #
################
FROM gcr.io/distroless/nodejs20-debian11 AS runtime

# Copy production build artifacts & production node_modules from builder
WORKDIR /app
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/package.json ./package.json

# Environment variables
ENV NODE_ENV=production \
    TZ=UTC \
    # Enable stricter security posture
    NODE_OPTIONS="--enable-source-maps --no-warning-code-caching"

# Non-root user for runtime (UID 10001 is arbitrary but consistent)
USER 10001

# Expose service port
EXPOSE 8080

# Health check – hit lightweight health endpoint; fail fast after 3 * 5s
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD \
  node -e "import('node:http').then(({ request }) => { \
    const req = request({ hostname: 'localhost', port: 8080, path: '/health', timeout: 4000 }, res => { \
      if (res.statusCode !== 200) process.exit(1); \
    }); req.on('error', () => process.exit(1)); req.end(); \
  });"

# Start the service
CMD ["dist/index.js"]