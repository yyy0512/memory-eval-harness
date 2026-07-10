package com.vitalpulse.cloudcare.api.utils;

import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.ValidationMessage;
import org.apache.commons.codec.binary.Base64;
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;

import java.nio.charset.StandardCharsets;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * Utility helper class used across the VitalPulse CloudCare API platform.
 * <p>
 * All methods are stateless and thread-safe. The class is non-instantiable by design.
 */
public final class Utils {

    private static final Logger LOG = LoggerFactory.getLogger(Utils.class);
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .findAndRegisterModules(); // Auto-register JSR-310, Java 8, etc.

    private Utils() {
        throw new UnsupportedOperationException("Utility class may not be instantiated");
    }

    /* =========================================================================
       === Correlation / Trace Utilities
       ========================================================================= */

    /**
     * Generates a cryptographically strong correlation identifier suitable for
     * distributed tracing, log aggregation, and audit tracking.
     *
     * @return A UUID v4 string without braces.
     */
    public static String generateCorrelationId() {
        return UUID.randomUUID().toString();
    }

    /* =========================================================================
       === Environment Variable Helpers
       ========================================================================= */

    /**
     * Returns the value of the given environment variable but throws an exception
     * if the variable is undefined or empty. This is useful for mandatory config.
     *
     * @param name Name of the environment variable.
     * @return The value associated with the variable.
     */
    public static String getRequiredEnv(final String name) {
        String value = System.getenv(name);
        if (StringUtils.isBlank(value)) {
            String msg = "Missing required environment variable: " + name;
            LOG.error(msg);
            throw new IllegalStateException(msg);
        }
        return value;
    }

    /* =========================================================================
       === JSON Serialization / Deserialization
       ========================================================================= */

    /**
     * Serializes an arbitrary Object into its JSON string representation.
     *
     * @param value Object to serialize.
     * @return JSON textual representation.
     */
    public static String toJson(final Object value) {
        try {
            return OBJECT_MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            LOG.error("Unable to serialize object of type {}", value != null ? value.getClass() : null, e);
            throw new IllegalArgumentException("Unable to serialize object to JSON", e);
        }
    }

    /**
     * Deserializes the given JSON into the specified Java type.
     *
     * @param json  Raw JSON text.
     * @param clazz Target type.
     * @param <T>   Generic type parameter.
     * @return Parsed value.
     */
    public static <T> T fromJson(final String json, final Class<T> clazz) {
        try {
            return OBJECT_MAPPER.readValue(json, clazz);
        } catch (JsonProcessingException e) {
            LOG.error("Unable to deserialize JSON to type {}", clazz, e);
            throw new IllegalArgumentException("Unable to deserialize JSON", e);
        }
    }

    /**
     * Parses the string into a Jackson JsonNode tree.
     *
     * @param json JSON text.
     * @return JsonNode root.
     */
    public static JsonNode toJsonNode(final String json) {
        try {
            return OBJECT_MAPPER.readTree(json);
        } catch (JsonProcessingException e) {
            LOG.error("Unable to parse JSON", e);
            throw new IllegalArgumentException("Unable to parse JSON", e);
        }
    }

    /* =========================================================================
       === JSON Schema Validation
       ========================================================================= */

    /**
     * Validates the given JSON payload against the provided {@link JsonSchema}.
     *
     * @param jsonPayload Raw JSON string.
     * @param schema      Precompiled JSON Schema.
     * @throws IllegalArgumentException if validation fails.
     */
    public static void validateJson(final String jsonPayload, final JsonSchema schema) {
        JsonNode node = toJsonNode(jsonPayload);
        Set<ValidationMessage> errors = schema.validate(node);
        if (!errors.isEmpty()) {
            StringBuilder sb = new StringBuilder("JSON validation failed:");
            errors.forEach(err -> sb.append(System.lineSeparator()).append(" • ").append(err.getMessage()));
            String msg = sb.toString();
            LOG.debug(msg);
            throw new IllegalArgumentException(msg);
        }
    }

    /* =========================================================================
       === DynamoDB Pagination Token Encoding / Decoding
       ========================================================================= */

    /**
     * Encodes the DynamoDB {@code LastEvaluatedKey} into a Base64-encoded string
     * that can be safely exposed as a pagination cursor to API consumers.
     *
     * @param lastEvaluatedKey Key map returned by DynamoDB.
     * @return Encoded cursor or {@code null} if key is null/empty.
     */
    public static String encodePaginationToken(final Map<String, AttributeValue> lastEvaluatedKey) {
        if (lastEvaluatedKey == null || lastEvaluatedKey.isEmpty()) {
            return null;
        }
        String json = toJson(lastEvaluatedKey);
        return Base64.encodeBase64URLSafeString(json.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Decodes the Base64 pagination cursor back into a DynamoDB key map.
     *
     * @param token Encoded pagination token.
     * @return Parsed map or {@code null} if token is blank.
     */
    @SuppressWarnings("unchecked")
    public static Map<String, AttributeValue> decodePaginationToken(final String token) {
        if (StringUtils.isBlank(token)) {
            return null;
        }
        byte[] decoded = Base64.decodeBase64(token);
        String json = new String(decoded, StandardCharsets.UTF_8);
        // DynamoDB AttributeValue map is serialized as attributes with {S:"...", N:"...", ...}
        // The SDK will handle deserialization correctly via OBJECT_MAPPER
        return fromJson(json, Map.class);
    }

    /* =========================================================================
       === Date / Time Parsing
       ========================================================================= */

    /**
     * Parses an ISO-8601 string into a {@link ZonedDateTime}.
     *
     * @param isoString ISO formatted date-time.
     * @return Parsed {@link ZonedDateTime}.
     */
    public static ZonedDateTime parseIsoDate(final String isoString) {
        return ZonedDateTime.parse(isoString, DateTimeFormatter.ISO_DATE_TIME);
    }

    /* =========================================================================
       === API Gateway Response Construction
       ========================================================================= */

    private static final Map<String, String> DEFAULT_HEADERS = Map.of(
            "Content-Type", "application/json",
            "Access-Control-Allow-Origin", "*", // CORS
            "X-Content-Type-Options", "nosniff"
    );

    /**
     * Creates a fully-formed {@link APIGatewayProxyResponseEvent} containing a
     * JSON-serialized body, standard headers, and the supplied status code.
     *
     * @param statusCode HTTP status code.
     * @param body       Body object to serialize as JSON.
     * @return Configured response event.
     */
    public static APIGatewayProxyResponseEvent buildResponse(final int statusCode, final Object body) {
        APIGatewayProxyResponseEvent response = new APIGatewayProxyResponseEvent()
                .withStatusCode(statusCode)
                .withHeaders(new HashMap<>(DEFAULT_HEADERS));

        if (body != null) {
            response.setBody(toJson(body));
        } else {
            response.setBody("");
        }
        return response;
    }

    /**
     * Convenience helper that builds an error response conforming to
     * RFC-7807 (Problem Details for HTTP APIs).
     *
     * @param statusCode HTTP status code.
     * @param type       URI identifying the error type.
     * @param title      Short summary of the error.
     * @param detail     Detailed developer-focused description.
     * @param instance   URI that identifies the specific occurrence.
     * @return API Gateway response event.
     */
    public static APIGatewayProxyResponseEvent buildProblemResponse(
            final int statusCode,
            final String type,
            final String title,
            final String detail,
            final String instance) {

        Map<String, Object> problem = new LinkedHashMap<>();
        problem.put("type", type);
        problem.put("title", title);
        problem.put("detail", detail);
        problem.put("status", statusCode);
        problem.put("instance", instance);
        problem.put("timestamp", ZonedDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME));

        return buildResponse(statusCode, problem);
    }
}