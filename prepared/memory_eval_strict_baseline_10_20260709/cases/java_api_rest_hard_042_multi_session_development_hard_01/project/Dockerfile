# -------------------------------------------------------------------
# VitalPulse CloudCare API – Production-grade Dockerfile
#
# This multi-stage build produces a minimal, secure container image
# for the VitalPulse CloudCare API (REST/GraphQL).  The build stage
# compiles the Maven project, embeds Git metadata, and runs unit
# tests; the runtime stage runs on a slim Amazon Corretto image with
# hardened settings, non-root execution, and health checks.
# -------------------------------------------------------------------

###############
# Build stage #
###############
FROM maven:3.9.4-amazoncorretto-17 AS builder

# Metadata provided by CI (GitHub Actions / CodeBuild, etc.)
ARG GIT_COMMIT=unknown
ARG BUILD_NUMBER=0
ARG BUILD_TIMESTAMP

LABEL org.opencontainers.image.authors    ="devops@vitalpulse.com" \
      org.opencontainers.image.vendor     ="VitalPulse"            \
      org.opencontainers.image.title      ="CloudCare API"         \
      org.opencontainers.image.revision   ="${GIT_COMMIT}"         \
      org.opencontainers.image.created    ="${BUILD_TIMESTAMP}"    \
      org.opencontainers.image.version    ="${BUILD_NUMBER}"       \
      org.opencontainers.image.source     ="https://github.com/VitalPulse/cloudcare-api" \
      org.opencontainers.image.description="HIPAA-grade REST/GraphQL service for real-time vital streams."

WORKDIR /workspace

# Leverage Maven's dependency caching
COPY pom.xml .
COPY mvnw .
COPY .mvn/ .mvn
RUN mvn -B dependency:resolve dependency:resolve-plugins

# Copy project files & run build
COPY src/ src/
RUN mvn -B -Pprod -DskipITs=true \
    -Dbuild.number=${BUILD_NUMBER} \
    -Dgit.commit=${GIT_COMMIT}     \
    clean verify

################
# Runtime stage #
################
FROM amazoncorretto:17-alpine-jdk

# Use a lightweight shell; bash is not available in alpine by default
SHELL ["/bin/ash", "-eo", "pipefail", "-c"]

# ------------------------------------------------------------------
# RUNTIME SETTINGS
# ------------------------------------------------------------------
ENV TZ="UTC" \
    LANG="en_US.UTF-8" \
    LC_ALL="en_US.UTF-8" \
    JAVA_OPTS="-XX:+UseContainerSupport \
               -XX:+UseG1GC \
               -XX:MaxRAMPercentage=70.0 \
               -XX:+ExitOnOutOfMemoryError \
               -Djava.security.egd=file:/dev/./urandom" \
    SPRING_PROFILES_ACTIVE="prod" \
    SERVER_PORT=8080

# Harden the image: add non-root user, strip unnecessary packages
RUN apk add --no-cache tzdata curl ca-certificates tini \
 && addgroup  -S appgroup \
 && adduser   -S appuser -G appgroup \
 && mkdir -p /app/logs \
 && chown -R appuser:appgroup /app

WORKDIR /app

# Copy fat-jar from builder stage
COPY --from=builder /workspace/target/vitalpulse-cloudcare-api-*.jar ./app.jar

USER appuser

# Expose application and management ports
EXPOSE 8080 8081

# Kubernetes / ECS health probe (Spring Boot Actuator)
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://127.0.0.1:${SERVER_PORT:-8080}/actuator/health || exit 1

# tini ensures graceful signal handling (SIGTERM lifecycle)
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "java ${JAVA_OPTS} -jar app.jar --server.port=${SERVER_PORT}"]