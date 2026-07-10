package com.vitalpulse.cloudcare.common.exception;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Thrown when a requested domain resource cannot be found by the underlying data store.
 *
 * <p>This exception is enriched with contextual metadata such as the resource type, unique
 * identifier, a machine–readable error code, and a correlation identifier that can be used to
 * trace the request across distributed log streams (e.g., CloudWatch, X-Ray).</p>
 *
 * <p>Example usage:
 * <pre>{@code
 * userRepository.findById(userId)
 *     .orElseThrow(() -> ResourceNotFoundException.forId("User", userId));
 * }</pre>
 *
 * <p>The exception is designed to be serialized directly to JSON by frameworks such as Jackson
 * when bubbling up through an API Gateway or Spring WebMVC controller. A convenience
 * {@link #toProblemDetail()} function is included to convert the exception to a RFC-7807
 * "Problem Details" shape.</p>
 */
public class ResourceNotFoundException extends RuntimeException {

    private static final long serialVersionUID = 7217587010923931909L;

    /**
     * Per-resource error code set. New error conditions (e.g., soft-deleted, archived) may extend
     * this enumeration in the future.
     */
    public enum ErrorCode {
        RESOURCE_NOT_FOUND("CC-404-001", "Requested resource was not found");

        private final String code;
        private final String defaultMessage;

        ErrorCode(String code, String defaultMessage) {
            this.code = code;
            this.defaultMessage = defaultMessage;
        }

        public String getCode() {
            return code;
        }

        public String getDefaultMessage() {
            return defaultMessage;
        }
    }

    /* ---------- Immutable Exception State --------------------------------------------------- */

    private final String resourceType;
    private final String resourceId;
    private final ErrorCode errorCode;
    private final String correlationId;
    private final Instant timestamp;

    /* ---------- Constructors ---------------------------------------------------------------- */

    private ResourceNotFoundException(Builder builder) {
        super(builder.buildMessage());
        this.resourceType  = builder.resourceType;
        this.resourceId    = builder.resourceId;
        this.errorCode     = builder.errorCode;
        this.correlationId = builder.correlationId;
        this.timestamp     = builder.timestamp;
    }

    /* ---------- Factory Methods ------------------------------------------------------------- */

    /**
     * Convenience factory for a missing resource identified solely by a string identifier.
     *
     * @param resourceType human-readable domain model name, e.g. "Patient" or "MedicationOrder"
     * @param resourceId   domain identifier, may be UUID, numeric ID, etc.
     * @return fully-built {@link ResourceNotFoundException}
     */
    public static ResourceNotFoundException forId(String resourceType, String resourceId) {
        return builder(resourceType, resourceId).build();
    }

    /**
     * Returns a new {@link Builder} pre-populated with sensible defaults.
     */
    public static Builder builder(String resourceType, String resourceId) {
        return new Builder(resourceType, resourceId);
    }

    /* ---------- Accessors ------------------------------------------------------------------- */

    public String getResourceType() {
        return resourceType;
    }

    public String getResourceId() {
        return resourceId;
    }

    public ErrorCode getErrorCode() {
        return errorCode;
    }

    /**
     * Returns an opaque identifier that can be logged by all collaborating services to enable
     * end-to-end request tracing.
     */
    public String getCorrelationId() {
        return correlationId;
    }

    /**
     * Time the exception was instantiated, expressed as an {@link Instant} (UTC).
     */
    public Instant getTimestamp() {
        return timestamp;
    }

    /* ---------- Problem-Detail (RFC-7807) Serialization ------------------------------------- */

    /**
     * Converts this exception into a <a href="https://www.rfc-editor.org/rfc/rfc7807">RFC-7807</a>
     * problem detail representation.
     *
     * <p>The resulting map is intentionally kept minimal so it can be serialized by JSON
     * serializers without additional configuration.</p>
     */
    public Map<String, Object> toProblemDetail() {
        Map<String, Object> detail = new LinkedHashMap<>(8);
        detail.put("type", "https://cloudcare.vitalpulse.com/problems/resource-not-found");
        detail.put("title", "Resource Not Found");
        detail.put("status", 404);
        detail.put("detail", getMessage());
        detail.put("resourceType", resourceType);
        detail.put("resourceId", resourceId);
        detail.put("errorCode", errorCode.getCode());
        detail.put("correlationId", correlationId);
        detail.put("timestamp", timestamp.toString());
        return Collections.unmodifiableMap(detail);
    }

    /* ---------- Builder --------------------------------------------------------------------- */

    public static final class Builder {
        private final String resourceType;
        private final String resourceId;
        private ErrorCode errorCode    = ErrorCode.RESOURCE_NOT_FOUND;
        private String correlationId   = UUID.randomUUID().toString();
        private Instant timestamp      = Instant.now();

        private Builder(String resourceType, String resourceId) {
            this.resourceType = Objects.requireNonNull(resourceType, "resourceType");
            this.resourceId   = Objects.requireNonNull(resourceId, "resourceId");
        }

        public Builder errorCode(ErrorCode errorCode) {
            this.errorCode = Objects.requireNonNull(errorCode, "errorCode");
            return this;
        }

        /**
         * Override the auto-generated correlation identifier.
         */
        public Builder correlationId(String correlationId) {
            this.correlationId = Objects.requireNonNull(correlationId, "correlationId");
            return this;
        }

        /**
         * Override the default timestamp (now in UTC).
         */
        public Builder timestamp(Instant timestamp) {
            this.timestamp = Objects.requireNonNull(timestamp, "timestamp");
            return this;
        }

        private String buildMessage() {
            return String.format("%s '%s' not found (errorCode=%s, correlationId=%s)",
                    resourceType, resourceId, errorCode.getCode(), correlationId);
        }

        public ResourceNotFoundException build() {
            return new ResourceNotFoundException(this);
        }
    }
}