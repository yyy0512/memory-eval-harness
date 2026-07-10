package com.vitalpulse.cloudcare.api.common;

import java.time.Duration;
import java.util.Collections;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Central repository for compile–time constants used across the
 * <b>VitalPulse CloudCare API</b> code-base.
 *
 * <p>The class is intentionally marked {@code final} with a
 * private constructor to prevent instantiation or extension.</p>
 */
public final class Constants {

    /** Prevent instantiation */
    private Constants() {
        throw new AssertionError("Constants class must not be instantiated");
    }

    /* ====================================================================== *
     * General
     * ====================================================================== */

    /** Canonical product name exposed in logs and API metadata */
    public static final String API_NAME = "VitalPulse CloudCare API";

    /** Content type for FHIR R4 JSON payloads */
    public static final String CONTENT_TYPE_FHIR_JSON = "application/fhir+json; charset=UTF-8";

    /** Application-wide correlation header (RFC 9436) */
    public static final String HEADER_CORRELATION_ID = "X-Correlation-Id";

    /* ====================================================================== *
     * Versioning
     * ====================================================================== */
    public static final class Versions {
        public static final String V1       = "v1";
        public static final String V2_BETA  = "v2-beta";

        /** API default version when none is specified by the consumer */
        public static final String DEFAULT  = V1;

        private Versions() {}
    }

    /* ====================================================================== *
     * Pagination
     * ====================================================================== */
    public static final class Pagination {
        /** Default number of resources returned when {@code pageSize} is omitted */
        public static final int DEFAULT_SIZE = 50;

        /** Maximum page size accepted by the platform */
        public static final int MAX_SIZE     = 500;

        /** Query string parameter name for pagination cursor */
        public static final String PARAM_CURSOR   = "cursor";

        /** Query string parameter name for custom requested page size */
        public static final String PARAM_PAGE_SIZE = "pageSize";

        private Pagination() {}
    }

    /* ====================================================================== *
     * Rate limiting
     * ====================================================================== */
    public static final class RateLimit {
        /** Default requests-per-second limit for API keys unless overridden */
        public static final int DEFAULT_RPS   = 50;

        /** Burst capacity enforced by API Gateway usage plans */
        public static final int DEFAULT_BURST = 250;

        /** HTTP header returned when the client is throttled */
        public static final String HEADER_RETRY_AFTER = "Retry-After";

        /** Custom metric name pushed to CloudWatch for throttled invocations */
        public static final String METRIC_THROTTLED   = "CloudCare.Api.Throttled";

        private RateLimit() {}
    }

    /* ====================================================================== *
     * DynamoDB
     * ====================================================================== */
    public static final class DynamoDB {
        /** Patient master record table (PK&nbsp;=&nbsp;patientId, SK&nbsp;=&nbsp;versionId) */
        public static final String TABLE_PATIENT    = "cloudcare_patient";

        /** Live stream of device telemetry (PK&nbsp;=&nbsp;patientId, SK&nbsp;=&nbsp;isoTimestamp) */
        public static final String TABLE_TELEMETRY  = "cloudcare_telemetry";

        /** Medication administration log (PK&nbsp;=&nbsp;patientId, SK&nbsp;=&nbsp;medId) */
        public static final String TABLE_MEDICATION = "cloudcare_medication";

        private DynamoDB() {}
    }

    /* ====================================================================== *
     * Environment variables — provided by Terraform stack
     * ====================================================================== */
    public static final class Env {
        public static final String AWS_REGION        = "AWS_REGION";
        public static final String STAGE             = "STAGE";
        public static final String COGNITO_POOL_ID   = "COGNITO_POOL_ID";
        public static final String COGNITO_CLIENT_ID = "COGNITO_CLIENT_ID";
        public static final String SECRET_ARN        = "CLOUDCARE_SECRET_ARN";

        private Env() {}
    }

    /* ====================================================================== *
     * Validation
     * ====================================================================== */
    public static final class Validation {
        /** RFC 4122 UUID (upper- or lower-case) */
        public static final Pattern UUID_PATTERN = Pattern.compile(
                "^[0-9a-fA-F]{8}\\-[0-9a-fA-F]{4}\\-[1-5][0-9a-fA-F]{3}\\-[89abAB][0-9a-fA-F]{3}\\-[0-9a-fA-F]{12}$");

        /** FHIR-compliant, human-readable ID (alphanumeric up to 64 characters) */
        public static final Pattern FHIR_ID_PATTERN = Pattern.compile("^[A-Za-z0-9\\-\\.]{1,64}$");

        /** ISO-8601 instant used across audit & telemetry data */
        public static final Pattern ISO_INSTANT_PATTERN = Pattern.compile(
                "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?Z$");

        private Validation() {}
    }

    /* ====================================================================== *
     * Cache
     * ====================================================================== */
    public static final class Cache {
        /** Cache key prefix for patient-level resources */
        public static final String KEY_PATIENT = "patient:";

        /** Time-to-live for patient summary cache */
        public static final Duration PATIENT_SUMMARY_TTL = Duration.ofMinutes(5);

        /** TTL for static documentation assets */
        public static final Duration DOCS_TTL = Duration.ofHours(12);

        private Cache() {}
    }

    /* ====================================================================== *
     * API Documentation
     * ====================================================================== */
    public static final class ApiDocs {
        /** Path to bundled Swagger UI static assets */
        public static final String SWAGGER_UI_PATH = "/docs";

        /** Path to exported OpenAPI specification */
        public static final String OPENAPI_YAML    = "/openapi.yaml";

        private ApiDocs() {}
    }

    /* ====================================================================== *
     * Error codes
     * ====================================================================== */

    /**
     * Enumeration of application-specific error codes.
     * <p>Format: {@code CC-<HTTP-STATUS>-<ordinal>}</p>
     */
    public enum ErrorCode {

        VALIDATION_FAILED   ("CC-400-1", 400, "Request validation failed"),
        UNAUTHORIZED        ("CC-401-0", 401, "Unauthorized request"),
        FORBIDDEN           ("CC-403-0", 403, "Access denied"),
        NOT_FOUND           ("CC-404-0", 404, "Resource not found"),
        RATE_LIMIT_EXCEEDED ("CC-429-0", 429, "Rate limit exceeded"),
        INTERNAL_ERROR      ("CC-500-0", 500, "Unexpected server error");

        private final String code;
        private final int    httpStatus;
        private final String defaultMessage;

        ErrorCode(final String code, final int httpStatus, final String defaultMessage) {
            this.code           = code;
            this.httpStatus     = httpStatus;
            this.defaultMessage = defaultMessage;
        }

        public String code() {
            return code;
        }

        public int httpStatus() {
            return httpStatus;
        }

        public String defaultMessage() {
            return defaultMessage;
        }

        /**
         * Convenience method returning an immutable representation suitable for
         * structured logs or <i>problem-json</i> response bodies.
         */
        public Map<String, Object> toMap() {
            return Collections.unmodifiableMap(
                Map.of("code", code, "httpStatus", httpStatus, "message", defaultMessage)
            );
        }
    }
}