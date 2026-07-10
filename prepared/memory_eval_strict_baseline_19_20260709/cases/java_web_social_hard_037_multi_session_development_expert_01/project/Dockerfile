# syntax=docker/dockerfile:1

################################################################################
# CircleConnect Nexus – Production-grade multi-stage Dockerfile
#
# This image compiles the React front-end, packages the Spring-Boot back-end,
# and runs the resulting JAR inside a minimal JRE container – all as a
# non-root user with SSL and health-checks baked in.
################################################################################

###############################
# --------  ARGs  ----------- #
###############################
ARG JDK_VERSION=17
ARG MAVEN_VERSION=3.9.6
ARG NODE_VERSION=20.5.1
ARG APP_HOME=/opt/circleconnect
ARG USER=app
ARG UID=1001
ARG GID=1001

################################################################################
# Stage 1 – Front-end build (React + Vite/Webpack)                              #
################################################################################
FROM node:${NODE_VERSION}-alpine AS ui-builder

LABEL stage="ui-builder"

# Create non-root build user
ARG USER UID GID
RUN addgroup -g ${GID} ${USER} \
 && adduser  -u ${UID} -G ${USER} -h /home/${USER} -D ${USER}

WORKDIR /src/web

# Copy only package-locking files first to leverage Docker layer-cache
COPY frontend/package*.json ./

RUN npm ci --legacy-peer-deps --silent

# Copy remaining UI source and build
COPY frontend .
RUN npm run build

################################################################################
# Stage 2 – Back-end build (Maven + Spring Boot)                                #
################################################################################
FROM maven:${MAVEN_VERSION}-eclipse-temurin-${JDK_VERSION}-alpine AS api-builder

LABEL stage="api-builder"

ARG USER UID GID
RUN addgroup -g ${GID} ${USER} \
 && adduser  -u ${UID} -G ${USER} -h /home/${USER} -D ${USER}

WORKDIR /src/app

# Pre-download Maven dependencies
COPY pom.xml .
COPY mvnw .
COPY .mvn ./.mvn
RUN ./mvnw -B -ntp dependency:go-offline

# Copy application source
COPY src ./src

# Copy built UI (static assets) into Spring Boot resources
COPY --from=ui-builder /src/web/build ./src/main/resources/static

# Build executable JAR (skip tests for Docker build speed)
RUN ./mvnw -B -Pprod -DskipTests clean package

################################################################################
# Stage 3 – Runtime image (JRE + tini + SSL)                                    #
################################################################################
FROM eclipse-temurin:${JDK_VERSION}-jre-alpine

LABEL org.opencontainers.image.title       ="CircleConnect Nexus" \
      org.opencontainers.image.description ="Social networking platform centred on community circles" \
      org.opencontainers.image.vendor      ="CircleConnect" \
      org.opencontainers.image.source      ="https://github.com/circleconnect/nexus" \
      org.opencontainers.image.version     ="1.0.0"

ARG APP_HOME
ARG USER UID GID

# System packages
RUN apk add --no-cache \
        tzdata \
        bash \
        tini \
        openssl

# Create runtime user
RUN addgroup -g ${GID} ${USER} \
 && adduser  -u ${UID} -G ${USER} -h /home/${USER} -D ${USER}

# Application directory layout
ENV JAVA_OPTS="-Xms256m -Xmx512m -XX:+UseG1GC" \
    APP_HOME=${APP_HOME}

WORKDIR ${APP_HOME}

# Copy built artifact
COPY --from=api-builder /src/app/target/*.jar app.jar

########################################################################
# Add entrypoint script:                                               #
#   • Generates a self-signed TLS certificate if none present          #
#   • Executes Java with configurable JVM flags                        #
########################################################################
RUN mkdir -p ${APP_HOME}/bin ${APP_HOME}/certs && \
    cat > ${APP_HOME}/bin/entrypoint.sh <<'EOF'
#!/usr/bin/env sh
set -eu

CERT_DIR="${APP_HOME:-/opt/circleconnect}/certs"
KEYSTORE="${CERT_DIR}/keystore.p12"
STORE_PASS="${KEYSTORE_PASSWORD:-changeit}"

# Generate self-signed certificate when the keystore is missing
if [ ! -f "${KEYSTORE}" ]; then
  echo ">>> Generating self-signed SSL certificate (valid for 1 year)…"
  keytool -genkeypair \
    -alias circleconnect \
    -keyalg RSA \
    -keysize 2048 \
    -storetype PKCS12 \
    -keystore "${KEYSTORE}" \
    -storepass "${STORE_PASS}" \
    -validity 365 \
    -dname "CN=circleconnect.local, OU=Dev, O=CircleConnect, L=Internet, S=NA, C=US"
fi

# Run the service
echo ">>> Starting CircleConnect Nexus"
exec java ${JAVA_OPTS} \
  -Dserver.ssl.key-store="${KEYSTORE}" \
  -Dserver.ssl.key-store-password="${STORE_PASS}" \
  -jar /opt/circleconnect/app.jar
EOF

# Make entrypoint executable & update ownership
RUN chmod +x ${APP_HOME}/bin/entrypoint.sh \
 && chown -R ${USER}:${USER} ${APP_HOME}

USER ${USER}

EXPOSE 8080 8443

# Health-check: relies on Spring Boot Actuator
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s CMD \
  wget --no-verbose --tries=1 --spider http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["/sbin/tini","--", "/opt/circleconnect/bin/entrypoint.sh"]