# syntax=docker/dockerfile:1.5

###############################################################################
# PayPalsphere – Accounts Service                                             #
#                                                                             #
# This Dockerfile builds a secure, production-ready container image for the   #
# Accounts micro-service.                                                     #
#   • Multi-stage build keeps runtime image small.                            #
#   • Non-root execution for defence-in-depth.                                #
#   • Deterministic dependency install via pnpm + lock-file.                  #
#   • Health-check endpoint wiring for orchestrators (K8s, Nomad, etc.).      #
###############################################################################

########################
# 1. Builder Stage     #
########################
FROM --platform=$BUILDPLATFORM node:20-alpine3.19 AS builder

# ---------- Build-time args ----------
ARG NODE_ENV=production
ARG PNPM_VERSION=8.15.5

# ---------- Env vars ----------
ENV NODE_ENV=${NODE_ENV} \
    APP_HOME=/usr/src/app

# ---------- Directory setup ----------
WORKDIR $APP_HOME

# ---------- Dependency tooling (pnpm) ----------
RUN --mount=type=cache,target=/root/.local/share/pnpm \
    corepack enable && \
    corepack prepare pnpm@$PNPM_VERSION --activate

# ---------- Install dependencies ----------
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm \
    pnpm install --frozen-lockfile --prod

# ---------- Copy & build source ----------
COPY . .
# If the service is written in TS, compile it; otherwise, no-op.
RUN --mount=type=cache,target=/root/.local/share/pnpm \
    if [ -f tsconfig.json ]; then \
        pnpm exec tsc -p tsconfig.json; \
    fi


########################
# 2. Runtime Stage     #
########################
FROM node:20-slim AS runtime

# ---------- Runtime args ----------
ARG NODE_ENV=production
ARG APP_USER=ppservice
ARG APP_UID=10001
ARG APP_GID=10001

# ---------- Env vars ----------
ENV NODE_ENV=${NODE_ENV} \
    APP_HOME=/usr/src/app \
    PORT=8080

# ---------- System user ----------
RUN groupadd -g $APP_GID $APP_USER \
 && useradd  -u $APP_UID -g $APP_GID -s /usr/sbin/nologin $APP_USER \
 && mkdir -p $APP_HOME

WORKDIR $APP_HOME

# ---------- Copy artefacts ----------
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist          ./dist
COPY --from=builder /usr/src/app/package.json  ./

# ---------- Permissions ----------
RUN chown -R $APP_UID:$APP_GID $APP_HOME

USER $APP_USER

# ---------- Healthcheck ----------
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get({host:'127.0.0.1',port:process.env.PORT,path:'/health'},res=>{res.statusCode===200?process.exit(0):process.exit(1)}).on('error',()=>process.exit(1));"

# ---------- Ports ----------
EXPOSE $PORT

# ---------- OCI labels ----------
LABEL org.opencontainers.image.title="PayPalsphere Accounts Service" \
      org.opencontainers.image.description="Handles user account lifecycle, authentication metadata & security profiles." \
      org.opencontainers.image.url="https://github.com/paypalsphere/accounts-service" \
      org.opencontainers.image.authors="PayPalsphere Engineering <engineering@paypalsphere.com>" \
      org.opencontainers.image.licenses="Apache-2.0"

# ---------- Entrypoint ----------
CMD ["node", "dist/index.js"]