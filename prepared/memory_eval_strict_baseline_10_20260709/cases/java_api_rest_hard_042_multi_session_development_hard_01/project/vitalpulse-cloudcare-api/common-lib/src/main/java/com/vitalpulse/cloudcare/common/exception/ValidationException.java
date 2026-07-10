package com.vitalpulse.cloudcare.common.exception;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;

import javax.validation.ConstraintViolation;
import java.io.Serial;
import java.io.Serializable;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Signals that the incoming request did not pass validation.
 * <p>
 * The exception captures:
 * <ul>
 *     <li>A machine-readable error code</li>
 *     <li>A correlation ID that allows downstream services to stitch logs together</li>
 *     <li>A timestamp for auditability</li>
 *     <li>A collection of fine-grained field violations</li>
 * </ul>
 * <p>
 * The exception implements {@link Serializable} to ensure that frameworks such as AWS Lambda (which may
 * serialize exceptions across class loaders) can safely marshall instances.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ValidationException extends RuntimeException implements Serializable {

    @Serial
    private static final long serialVersionUID = 5697882394711587046L;

    private static final ObjectMapper DEFAULT_MAPPER = new ObjectMapper();

    /**
     * A stable, machine-readable error code that clients can rely on for branching logic.
     */
    private final String errorCode;

    /**
     * The moment the exception was thrown (UTC).
     */
    private final Instant timestamp;

    /**
     * Unique identifier propagated through the request chain for observability.
     */
    private final UUID correlationId;

    /**
     * Collection of (field, message, invalidValue) triples describing validation failures.
     */
    private final List<FieldViolation> violations;

    /**
     * Creates a new ValidationException with a friendly message and details.
     *
     * @param message       Human-readable error message.
     * @param errorCode     Stable error code (ex: <b>FHIR_SCHEMA_VIOLATION</b>).
     * @param correlationId Correlation identifier; generate one if {@code null}.
     * @param violations    Collection of field-level validation errors.
     */
    public ValidationException(
            final String message,
            final String errorCode,
            final UUID correlationId,
            final List<FieldViolation> violations
    ) {
        super(message);
        this.errorCode    = errorCode == null ? "VALIDATION_ERROR" : errorCode;
        this.correlationId = correlationId == null ? UUID.randomUUID() : correlationId;
        this.timestamp    = Instant.now();
        this.violations   = violations == null ? Collections.emptyList() : List.copyOf(violations);
    }

    /**
     * Convenience constructor used by javax.validation flows.
     *
     * @param violations JSR-380 constraint violations coming from a validator.
     */
    public ValidationException(final Set<ConstraintViolation<?>> violations) {
        this("Request failed validation",
             "VALIDATION_ERROR",
             null,
             violations == null ? Collections.emptyList()
                                : violations.stream()
                                            .map(FieldViolation::of)
                                            .collect(Collectors.toList())
        );
    }

    public String getErrorCode() {
        return errorCode;
    }

    public Instant getTimestamp() {
        return timestamp;
    }

    public UUID getCorrelationId() {
        return correlationId;
    }

    public List<FieldViolation> getViolations() {
        return violations;
    }

    /**
     * Serializes the exception into a JSON string that can be used as the body of a HTTP 400 response.
     *
     * @return JSON representation of the error; if serialization fails, a minimal string is returned.
     */
    public String toJson() {
        try {
            return DEFAULT_MAPPER.writeValueAsString(this);
        } catch (JsonProcessingException e) {
            // Fallback – last resort since we are already in an exceptional flow.
            return "{\"error\":\"" + getMessage() + "\"}";
        }
    }

    @Override
    public String toString() {
        return "ValidationException{" +
               "errorCode='" + errorCode + '\'' +
               ", timestamp=" + timestamp +
               ", correlationId=" + correlationId +
               ", violations=" + violations +
               ", message=" + getMessage() +
               '}';
    }

    /* ╔════════════════════════════════════════════════════════════════════╗
       ║                             HELPERS                                ║
       ╚════════════════════════════════════════════════════════════════════╝ */

    /**
     * DO NOT expose this class outside the exception — it is an implementation detail.
     * Clients should only rely on the stable JSON representation.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class FieldViolation implements Serializable {

        @Serial
        private static final long serialVersionUID = -3818804935343637710L;

        /**
         * JSON path or GraphQL path pointing to the offending field (example: <b>patient[0].birthDate</b>)
         */
        private final String field;

        /**
         * Human-readable reason explaining why the value is invalid.
         */
        private final String message;

        /**
         * The actual value received; omitted if {@code null}.
         */
        private final Object rejectedValue;

        private FieldViolation(final String field, final String message, final Object rejectedValue) {
            this.field         = field;
            this.message       = message;
            this.rejectedValue = rejectedValue;
        }

        public static FieldViolation of(final ConstraintViolation<?> violation) {
            return new FieldViolation(
                    violation.getPropertyPath().toString(),
                    violation.getMessage(),
                    violation.getInvalidValue()
            );
        }

        public static FieldViolation of(final String field,
                                        final String message,
                                        final Object rejectedValue) {
            return new FieldViolation(field, message, rejectedValue);
        }

        public String getField() {
            return field;
        }

        public String getMessage() {
            return message;
        }

        public Object getRejectedValue() {
            return rejectedValue;
        }

        @Override
        public String toString() {
            return "FieldViolation{" +
                   "field='" + field + '\'' +
                   ", message='" + message + '\'' +
                   ", rejectedValue=" + rejectedValue +
                   '}';
        }
    }
}