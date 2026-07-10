package com.vitalpulse.cloudcare.query.repository;

import com.vitalpulse.cloudcare.commons.exception.DataAccessException;
import com.vitalpulse.cloudcare.commons.pagination.Page;
import com.vitalpulse.cloudcare.query.model.MedicationEvent;
import com.vitalpulse.cloudcare.query.model.PatientSnapshot;
import com.vitalpulse.cloudcare.query.model.VitalSignRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.core.SdkBytes;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.DynamoDbException;
import software.amazon.awssdk.services.dynamodb.model.QueryRequest;
import software.amazon.awssdk.services.dynamodb.model.QueryResponse;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.*;
import java.util.Base64.Decoder;
import java.util.Base64.Encoder;

/**
 * Repository responsible for read‐side access to patient data stored in DynamoDB.
 * <p>
 * This class implements the Query orientation of CQRS: it is <b>read-only</b> and therefore
 * safe to use concurrently across AWS Lambda invocations. All mutating operations
 * are handled by the command service in a separate deployment unit.
 * <p>
 * The class provides transparent cursor-based pagination using DynamoDB’s
 * LastEvaluatedKey mechanism. The cursor is represented as a Base64-encoded
 * binary blob so that callers treat it as an opaque token.
 * <p>
 * Error handling:
 * <ul>
 *   <li>All AWS SDK exceptions are wrapped into {@link DataAccessException} to
 *   avoid leaking infrastructure errors up the stack.</li>
 *   <li>Metrics are logged through SLF4J so that CloudWatch can
 *   automatically ingest them via embedded metric format.</li>
 * </ul>
 */
public class PatientDataRepository {

    private static final Logger LOG = LoggerFactory.getLogger(PatientDataRepository.class);

    /* =======================
     *  DYNAMODB CONFIGURATION
     * ======================= */
    private static final String VITAL_SIGNS_TABLE         = "patient_vital_signs";
    private static final String MEDICATION_EVENTS_TABLE   = "patient_medication_events";
    private static final String PATIENT_SNAPSHOTS_TABLE   = "patient_snapshot";

    /** Partition key name used across all tables (PK = patientId). */
    private static final String PK_COLUMN = "patient_id";
    /** Sort key name used for time-series tables. */
    private static final String SK_COLUMN = "recorded_at";

    private static final Encoder BASE_64_ENCODER = Base64.getUrlEncoder();
    private static final Decoder BASE_64_DECODER = Base64.getUrlDecoder();

    private final DynamoDbClient dynamoDb;

    /**
     * Constructs the repository with a pre-configured {@link DynamoDbClient}.
     * The client is assumed to be managed outside (for instance, through a Spring
     * Bean or Micronaut singleton) so that TCP connections are reused across
     * multiple invocations.
     */
    public PatientDataRepository(final DynamoDbClient dynamoDb) {
        this.dynamoDb = Objects.requireNonNull(dynamoDb, "dynamoDb must not be null");
    }

    /* =========================================================================
     *  PUBLIC API
     * ========================================================================= */

    /**
     * Returns a paged list of {@link VitalSignRecord} for the given patient
     * within an optional time window.
     *
     * @param patientId   patient identifier (UUID4 in most deployments)
     * @param from        inclusive lower bound; may be {@code null} for open-ended
     * @param to          exclusive upper bound; may be {@code null} for open-ended
     * @param pageSize    maximum number of items per page (1–1000)
     * @param pageToken   opaque token indicating where the next page should start;
     *                    {@code null} or empty string for first page
     */
    public Page<VitalSignRecord> fetchVitalSigns(
            final String  patientId,
            final Instant from,
            final Instant to,
            final int     pageSize,
            final String  pageToken) {

        validatePageSize(pageSize);
        Objects.requireNonNull(patientId, "patientId must not be null");

        Map<String, AttributeValue> exclusiveStartKey = decodePageToken(pageToken);

        QueryRequest.Builder requestBuilder = QueryRequest.builder()
                .tableName(VITAL_SIGNS_TABLE)
                .keyConditionExpression(buildDateRangeKeyCondition(from, to))
                .expressionAttributeValues(buildDateRangeAttributeValues(patientId, from, to))
                .expressionAttributeNames(Collections.singletonMap("#ts", SK_COLUMN))
                .limit(pageSize)
                .exclusiveStartKey(exclusiveStartKey)
                .scanIndexForward(true); // ascending order

        QueryResponse response = executeQuery(requestBuilder.build());
        List<VitalSignRecord> items = mapVitalSignItems(response.items());

        return toPage(items, response.lastEvaluatedKey());
    }

    /**
     * Returns a paged list of {@link MedicationEvent}s for the given patient within
     * an optional time window.
     */
    public Page<MedicationEvent> fetchMedicationEvents(
            final String  patientId,
            final Instant from,
            final Instant to,
            final int     pageSize,
            final String  pageToken) {

        validatePageSize(pageSize);
        Objects.requireNonNull(patientId, "patientId must not be null");

        Map<String, AttributeValue> exclusiveStartKey = decodePageToken(pageToken);

        QueryRequest.Builder requestBuilder = QueryRequest.builder()
                .tableName(MEDICATION_EVENTS_TABLE)
                .keyConditionExpression(buildDateRangeKeyCondition(from, to))
                .expressionAttributeValues(buildDateRangeAttributeValues(patientId, from, to))
                .expressionAttributeNames(Collections.singletonMap("#ts", SK_COLUMN))
                .limit(pageSize)
                .exclusiveStartKey(exclusiveStartKey)
                .scanIndexForward(true);

        QueryResponse response = executeQuery(requestBuilder.build());
        List<MedicationEvent> items = mapMedicationItems(response.items());

        return toPage(items, response.lastEvaluatedKey());
    }

    /**
     * Returns the latest {@link PatientSnapshot} for the given patient or
     * {@link Optional#empty()} if none exist.
     */
    public Optional<PatientSnapshot> fetchLatestSnapshot(final String patientId) {
        Objects.requireNonNull(patientId, "patientId must not be null");

        QueryRequest request = QueryRequest.builder()
                .tableName(PATIENT_SNAPSHOTS_TABLE)
                .keyConditionExpression("#pk = :pk")
                .expressionAttributeNames(Collections.singletonMap("#pk", PK_COLUMN))
                .expressionAttributeValues(Collections.singletonMap(":pk",
                        AttributeValue.builder().s(patientId).build()))
                .scanIndexForward(false) // newest first
                .limit(1)
                .build();

        QueryResponse response = executeQuery(request);
        if (response.count() == 0) {
            return Optional.empty();
        }

        return Optional.of(mapSnapshotItem(response.items().get(0)));
    }

    /* =========================================================================
     *  PRIVATE HELPERS
     * ========================================================================= */

    /**
     * Executes the given query and maps AWS exceptions to {@link DataAccessException}.
     */
    private QueryResponse executeQuery(final QueryRequest request) {
        try {
            QueryResponse response = dynamoDb.query(request);
            LOG.debug("DynamoDB query successful. ConsumedCapacity={}", response.consumedCapacity());
            return response;
        } catch (ConditionalCheckFailedException e) {
            // Should never happen on query but we treat it explicitly
            throw new DataAccessException("Conditional check failed while querying DynamoDB", e);
        } catch (DynamoDbException e) {
            LOG.error("DynamoDB exception when executing query: {}", e.getMessage(), e);
            throw new DataAccessException("Failed to query patient data from DynamoDB", e);
        }
    }

    private String buildDateRangeKeyCondition(final Instant from, final Instant to) {
        // Example:
        //   pk = :pk and #ts BETWEEN :from AND :to
        //   or open-ended if from/to == null
        StringBuilder condition = new StringBuilder("#pk = :pk");

        if (from != null && to != null) {
            condition.append(" AND #ts BETWEEN :from AND :to");
        } else if (from != null) {
            condition.append(" AND #ts >= :from");
        } else if (to != null) {
            condition.append(" AND #ts < :to");
        }
        return condition.toString();
    }

    private Map<String, AttributeValue> buildDateRangeAttributeValues(
            final String patientId,
            final Instant from,
            final Instant to) {

        Map<String, AttributeValue> values = new HashMap<>();
        values.put(":pk", AttributeValue.builder().s(patientId).build());

        if (from != null) {
            values.put(":from", AttributeValue.builder().n(String.valueOf(from.toEpochMilli())).build());
        }
        if (to != null) {
            values.put(":to", AttributeValue.builder().n(String.valueOf(to.toEpochMilli())).build());
        }
        return values;
    }

    private static void validatePageSize(int pageSize) {
        if (pageSize <= 0 || pageSize > 1000) {
            throw new IllegalArgumentException("pageSize must be between 1 and 1000");
        }
    }

    /* -------------------------------
     *  Mapping helpers
     * ------------------------------- */
    private List<VitalSignRecord> mapVitalSignItems(List<Map<String, AttributeValue>> dynamoItems) {
        List<VitalSignRecord> records = new ArrayList<>(dynamoItems.size());
        for (Map<String, AttributeValue> item : dynamoItems) {
            records.add(VitalSignRecord.fromItem(item)); // Domain class handles mapping
        }
        return records;
    }

    private List<MedicationEvent> mapMedicationItems(List<Map<String, AttributeValue>> dynamoItems) {
        List<MedicationEvent> events = new ArrayList<>(dynamoItems.size());
        for (Map<String, AttributeValue> item : dynamoItems) {
            events.add(MedicationEvent.fromItem(item));
        }
        return events;
    }

    private PatientSnapshot mapSnapshotItem(Map<String, AttributeValue> item) {
        return PatientSnapshot.fromItem(item);
    }

    /* -------------------------------
     *  Pagination helpers
     * ------------------------------- */
    private <T> Page<T> toPage(List<T> items, Map<String, AttributeValue> lastEvaluatedKey) {
        String nextPageToken = null;
        if (lastEvaluatedKey != null && !lastEvaluatedKey.isEmpty()) {
            nextPageToken = encodePageToken(lastEvaluatedKey);
        }
        return new Page<>(items, nextPageToken);
    }

    private static String encodePageToken(Map<String, AttributeValue> lastKey) {
        byte[] bytes = SdkBytes.fromUtf8String(AttributeValueUtil.toJson(lastKey)).asByteArray();
        return BASE_64_ENCODER.encodeToString(bytes);
    }

    private static Map<String, AttributeValue> decodePageToken(String pageToken) {
        if (pageToken == null || pageToken.isBlank()) {
            return null;
        }
        try {
            byte[] decoded = BASE_64_DECODER.decode(pageToken);
            String json    = new String(decoded, StandardCharsets.UTF_8);
            return AttributeValueUtil.fromJsonMap(json);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Invalid pageToken supplied", e);
        }
    }

    /* =========================================================================
     *  INTERNAL JSON <–> AttributeValue UTILITIES
     *  (These could live in a shared commons-lambda module, but we keep them
     *  here to avoid an extra dependency for this example.)
     * ========================================================================= */
    private static final class AttributeValueUtil {
        /**
         * Serialises a map of AttributeValues to a JSON string. We only need to
         * support String and Number primitives for the LastEvaluatedKey, which
         * keeps the implementation small.
         */
        static String toJson(Map<String, AttributeValue> map) {
            StringBuilder json = new StringBuilder("{");
            Iterator<Map.Entry<String, AttributeValue>> iterator = map.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, AttributeValue> entry = iterator.next();
                json.append("\"").append(entry.getKey()).append("\":");
                AttributeValue av = entry.getValue();
                if (av.s() != null) {
                    json.append("\"").append(av.s()).append("\"");
                } else if (av.n() != null) {
                    json.append(av.n());
                } else {
                    throw new IllegalArgumentException("Unsupported AttributeValue type for pagination token");
                }
                if (iterator.hasNext()) {
                    json.append(",");
                }
            }
            json.append("}");
            return json.toString();
        }

        /**
         * Parses a JSON representation created by {@link #toJson(Map)} back
         * into a map. This is a minimal parser and not a general-purpose JSON reader.
         */
        static Map<String, AttributeValue> fromJsonMap(String json) {
            if (json == null || json.isBlank()) {
                return Collections.emptyMap();
            }
            Map<String, AttributeValue> map = new HashMap<>();
            // Very naive parsing; production code should use Jackson or Gson,
            // but we avoid extra dependencies in this snippet.
            String content = json.trim();
            if (content.startsWith("{")) content = content.substring(1);
            if (content.endsWith("}")) content = content.substring(0, content.length() - 1);

            if (content.isBlank()) return map;

            String[] pairs = content.split(",");
            for (String pair : pairs) {
                String[] kv = pair.split(":", 2);
                if (kv.length != 2) continue;
                String key = kv[0].replace("\"", "").trim();
                String val = kv[1].replace("\"", "").trim();
                // Decide whether value is numeric
                AttributeValue av;
                if (val.matches("^-?\\d+(\\.\\d+)?$")) {
                    av = AttributeValue.builder().n(val).build();
                } else {
                    av = AttributeValue.builder().s(val).build();
                }
                map.put(key, av);
            }
            return map;
        }
    }
}