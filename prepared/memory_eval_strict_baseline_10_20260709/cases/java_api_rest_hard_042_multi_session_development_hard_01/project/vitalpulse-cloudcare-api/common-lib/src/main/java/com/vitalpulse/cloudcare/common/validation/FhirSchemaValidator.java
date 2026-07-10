package com.vitalpulse.cloudcare.common.validation;

import com.fasterxml.jackson.core.JsonParseException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.stream.Collectors;

/**
 * Validates incoming FHIR resources against versioned JSON schema definitions.
 * <p>
 * Schemas are expected on the class-path under
 * {@code /schemas/fhir/{version}/{ResourceType}.schema.json}.<br/>
 * Example: {@code /schemas/fhir/r4/Patient.schema.json}
 * <p>
 * The validator is thread-safe and caches parsed schema instances for fast
 * validation in high-throughput environments (e.g., AWS Lambda).
 */
public final class FhirSchemaValidator {

    private static final Logger LOG = LoggerFactory.getLogger(FhirSchemaValidator.class);

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final JsonSchemaFactory SCHEMA_FACTORY =
            JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V201909);

    /* Cache to avoid reparsing the same schema multiple times */
    private final ConcurrentMap<String, JsonSchema> schemaCache = new ConcurrentHashMap<>();

    private final MetricsPublisher metricsPublisher;

    /* Default singleton that uses NO-OP metrics implementation */
    private static final FhirSchemaValidator DEFAULT_INSTANCE =
            new FhirSchemaValidator(MetricsPublisher.noop());

    /**
     * Retrieve the default singleton instance that uses a NO-OP
     * {@link MetricsPublisher}.
     */
    public static FhirSchemaValidator getInstance() {
        return DEFAULT_INSTANCE;
    }

    /**
     * Construct a validator with a custom {@link MetricsPublisher}.
     *
     * @param metricsPublisher destination for custom CloudWatch/Prometheus metrics
     */
    public FhirSchemaValidator(final MetricsPublisher metricsPublisher) {
        this.metricsPublisher = Objects.requireNonNull(metricsPublisher, "metricsPublisher");
    }

    /**
     * Validate a FHIR JSON payload against the corresponding JSON schema.
     *
     * @param fhirVersion  FHIR release version (e.g., {@code r4}, {@code stu3})
     * @param resourceType FHIR resource type (e.g., {@code Patient}, {@code Observation})
     * @param jsonPayload  raw JSON payload
     * @return {@link ValidationResult} containing success flag and any error messages
     */
    public ValidationResult validate(
            final String fhirVersion,
            final String resourceType,
            final String jsonPayload
    ) {
        Objects.requireNonNull(fhirVersion, "fhirVersion");
        Objects.requireNonNull(resourceType, "resourceType");
        Objects.requireNonNull(jsonPayload, "jsonPayload");

        final Instant start = Instant.now();

        try {
            final JsonSchema schema = loadSchema(fhirVersion.trim().toLowerCase(), resourceType.trim());

            final JsonNode payloadNode = parsePayload(jsonPayload);

            final Set<ValidationMessage> messages = schema.validate(payloadNode);
            final boolean success = messages.isEmpty();

            metricsPublisher.publishCountMetric(
                    "FhirSchemaValidation.Success",
                    success ? 1d : 0d
            );

            return new ValidationResult(
                    success,
                    messages.stream()
                            .map(ValidationMessage::getMessage)
                            .collect(Collectors.toUnmodifiableList())
            );

        } catch (SchemaLoadingException | PayloadParsingException ex) {
            LOG.warn("Unable to perform schema validation", ex);
            metricsPublisher.publishCountMetric("FhirSchemaValidation.Failure", 1d);
            return new ValidationResult(false, List.of(ex.getMessage()));
        } finally {
            final Duration elapsed = Duration.between(start, Instant.now());
            metricsPublisher.publishTimeMetric("FhirSchemaValidation.LatencyMs", elapsed.toMillis());
        }
    }

    /* ******************************  Helpers  ******************************** */

    private JsonSchema loadSchema(final String version, final String resourceType) {
        final String cacheKey = version + ":" + resourceType;

        return schemaCache.computeIfAbsent(cacheKey, key -> {
            final String location =
                    String.format("/schemas/fhir/%s/%s.schema.json", version, resourceType);
            try (InputStream is = FhirSchemaValidator.class.getResourceAsStream(location)) {
                if (is == null) {
                    throw new SchemaLoadingException(
                            "FHIR schema not found on classpath: " + location
                    );
                }
                return SCHEMA_FACTORY.getSchema(is);
            } catch (IOException io) {
                throw new SchemaLoadingException(
                        "Error while reading schema: " + location, io
                );
            }
        });
    }

    private JsonNode parsePayload(final String json) {
        try {
            return MAPPER.readTree(json);
        } catch (JsonParseException pex) {
            throw new PayloadParsingException("Invalid JSON payload: " + pex.getOriginalMessage(), pex);
        } catch (IOException io) {
            throw new PayloadParsingException("Unable to parse payload", io);
        }
    }

    /* ******************************  DTOs  ******************************** */

    /**
     * Result object returned by {@link #validate(String, String, String)}.
     *
     * @param success indicates whether the payload conforms to the schema
     * @param errors  immutable list of validation errors (empty when successful)
     */
    public record ValidationResult(boolean success, List<String> errors) {
        public ValidationResult {
            errors = errors == null ? Collections.emptyList() : List.copyOf(errors);
        }
    }

    /* ******************************  Exceptions  ******************************** */

    public static class SchemaLoadingException extends RuntimeException {
        public SchemaLoadingException(final String message) {
            super(message);
        }

        public SchemaLoadingException(final String message, final Throwable cause) {
            super(message, cause);
        }
    }

    public static class PayloadParsingException extends RuntimeException {
        public PayloadParsingException(final String message, final Throwable cause) {
            super(message, cause);
        }
    }

    /* ******************************  Metrics Support  ******************************** */

    /**
     * Lightweight abstraction to decouple validation logic from metrics backend.
     * A NO-OP implementation is provided for callers that do not require metrics.
     */
    @FunctionalInterface
    public interface MetricsPublisher {

        /**
         * Publish a high-level count metric.
         *
         * @param name  metric name (without namespace)
         * @param value metric value (typically 0 or 1)
         */
        void publishCountMetric(String name, double value);

        /**
         * Publish timing metrics in milliseconds.
         *
         * @param name  metric name (without namespace)
         * @param value duration in milliseconds
         */
        default void publishTimeMetric(String name, double value) {
            // Implement in concrete publisher; default NO-OP
        }

        /* ***********************  Factory  ***************************** */

        /**
         * @return a NO-OP publisher that silently discards metrics
         */
        static MetricsPublisher noop() {
            return (name, value) -> {
                // NO-OP
            };
        }
    }
}