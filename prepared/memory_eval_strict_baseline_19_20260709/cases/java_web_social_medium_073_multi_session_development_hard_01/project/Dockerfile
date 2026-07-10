# ----------------------------------------------------------------------------
# EduPulse Live Learning Hub (web_social) – Dockerfile
#
# Multi-stage build to create a slim, production-ready container for the
# Spring Boot / Java 17 service that powers the “web_social” bounded context.
#
#   - Stage 1: Build the application with Maven (incl. layer-caching tricks)
#   - Stage 2: Assemble a minimal, non-root runtime image with a JRE
#
# NOTE:
#   • Exposes management via /actuator/health for Docker HEALTHCHECK
#   • Uses a dedicated, non-privileged user (UID 1001) at runtime
#   • Pass-through of build-time metadata for traceability
# ----------------------------------------------------------------------------

########################
# Stage 1 — Maven Build
########################
FROM maven:3.9.6-eclipse-temurin-17 AS builder

# Build-time metadata (can be overridden by CI/CD pipeline)
ARG BUILD_VERSION=0.0.0-SNAPSHOT
ARG BUILD_COMMIT=unknown
ARG BUILD_TIMESTAMP=unknown

# Inject labels for provenance
LABEL org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"

# Set build-time env vars
ENV MAVEN_OPTS="-Dmaven.repo.local=/root/.m2/repository -XX:+UseContainerSupport"

# Create app directory
WORKDIR /app

# Leverage Docker layer caching — first copy dependency descriptors
COPY pom.xml mvnw ./
COPY .mvn .mvn

# Pre-download dependencies (so source changes later don’t invalidate cache)
RUN ./mvnw -B dependency:go-offline

# Copy the rest of the source tree
COPY src ./src

# Build the application (skip tests for faster image builds;
# tests should run in CI before the Docker stage)
RUN ./mvnw -B -Pprod -DskipTests clean package

#############################
# Stage 2 — Runtime Image
#############################
FROM eclipse-temurin:17-jre-alpine AS runtime

# Runtime environment configuration
ARG BUILD_VERSION
ARG BUILD_COMMIT
ARG BUILD_TIMESTAMP

# System settings
ENV TZ=UTC \
    LANG=C.UTF-8 \
    LANGUAGE=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    # Spring / EduPulse defaults (overridable at run-time)
    SPRING_PROFILES_ACTIVE=prod \
    JAVA_OPTS=""

# Create non-root user & group
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 1001

WORKDIR /opt/edupulse

# Copy the packaged application from the builder stage
COPY --from=builder /app/target/edupulse-web_social.jar ./app.jar

# Create a volume for application logs (optional)
VOLUME /opt/edupulse/logs

# File permissions
RUN chown -R appuser:appgroup /opt/edupulse

USER appuser

# Expose application HTTP port
EXPOSE 8080

# Healthcheck to ensure container is ready
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:8080/actuator/health || exit 1

# Global JVM opts can be injected via JAVA_OPTS
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar ./app.jar"]

# Final labels
LABEL maintainer="EduPulse DevOps <devops@edupulse.io>" \
      org.opencontainers.image.title="EduPulse Web Social Service" \
      org.opencontainers.image.description="Real-time social micro-learning service for EduPulse Live Learning Hub." \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}"