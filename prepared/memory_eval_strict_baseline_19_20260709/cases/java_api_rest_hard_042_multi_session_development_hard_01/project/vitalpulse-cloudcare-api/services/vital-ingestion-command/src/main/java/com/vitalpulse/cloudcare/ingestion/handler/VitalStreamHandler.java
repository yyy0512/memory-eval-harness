```java
package com.vitalpulse.cloudcare.ingestion.handler;

import com.amazonaws.services.dynamodbv2.document.DynamoDB;
import com.amazonaws.services.dynamodbv2.document.Table;
import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * AWS Lambda handler responsible for ingesting real-time vital-sign streams coming
 * from FDA-approved devices. Implements basic request validation, token-bucket
 * rate-limiting, and delegates the persistence logic to {@link VitalIngestionService}.
 *
 * <p>Expected input (simplified JSON):
 * {
 *   "patientId" : "12345",
 *   "deviceId"  : "ecg-g7",
 *   "eventTs"   : 1688311897000,
 *   "vitals"    : [
 *       { "type" : "HR", "unit": "bpm", "value": 75, "ts" : 1688311897000 },
 *       { "type" : "SpO2", "unit": "%",  "value": 98, "ts" : 1688311897000 }
 *   ]
 * }
 *
 * <p>The function returns standard API-Gateway responses (200/400/429/500).
 */
public class VitalStreamHandler implements
        RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Logger log = LoggerFactory.getLogger(VitalStreamHandler.class);

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /* 200 – Accepted (async processing), 400 – validation, 429 – throttled, 500 – server error */
    private static final int HTTP_ACCEPTED               = 202;
    private static final int HTTP_BAD_REQUEST            = 400;
    private static final int HTTP_TOO_MANY_REQUESTS      = 429;
    private static final int HTTP_INTERNAL_SERVER_ERROR  = 500;

    /*  ─────────────────────  Dependencies  ───────────────────── */
    private final VitalIngestionService ingestionService;
    private final TokenBucketRateLimiter rateLimiter;
    private final FhirValidator validator;

    /*  ─────────────────────  Constructors  ───────────────────── */
    public VitalStreamHandler() {
        this(new VitalIngestionService(),                        // default service impl
             new TokenBucketRateLimiter(                         // 10 req per 5 seconds / patient
                     10, TimeUnit.SECONDS.toMillis(5)),
             new FhirValidator());
    }

    /* for unit-tests */
    VitalStreamHandler(VitalIngestionService service,
                       TokenBucketRateLimiter limiter,
                       FhirValidator validator) {
        this.ingestionService = Objects.requireNonNull(service);
        this.rateLimiter      = Objects.requireNonNull(limiter);
        this.validator        = Objects.requireNonNull(validator);
    }

    /*  ─────────────────────  Lambda entry point  ───────────────────── */
    @Override
    public APIGatewayProxyResponseEvent handleRequest(APIGatewayProxyRequestEvent request,
                                                      Context context) {

        final String requestId = context.getAwsRequestId();
        log.debug("Lambda invoked, requestId={}", requestId);

        try {
            // 1. Parse JSON body
            VitalStreamEvent event = MAPPER.readValue(request.getBody(), VitalStreamEvent.class);
            log.debug("Parsed vital-stream event for patient={}, device={}, vitals={}",
                    event.getPatientId(), event.getDeviceId(), event.getVitals().size());

            // 2. Basic schema / FHIR validation
            validator.validate(event);

            // 3. Apply rate-limiting per {patientId, deviceId}
            String tokenKey = event.getPatientId() + ':' + event.getDeviceId();
            if (!rateLimiter.tryConsume(tokenKey)) {
                log.warn("Throttling vital-stream; key={}, requestId={}", tokenKey, requestId);
                return buildResponse(HTTP_TOO_MANY_REQUESTS,
                        ErrorResponse.of("RATE_LIMIT_EXCEEDED",
                                "Too many vital-stream events submitted. Please slow down."));
            }

            // 4. Business processing
            ingestionService.processVitalStream(event);

            // 5. Acknowledge asynchronously (202 Accepted)
            return buildResponse(HTTP_ACCEPTED,
                    Collections.singletonMap("status", "accepted"));

        } catch (ValidationException ve) {
            log.error("Validation failed, requestId={}: {}", requestId, ve.getMessage());
            return buildResponse(HTTP_BAD_REQUEST,
                    ErrorResponse.of("VALIDATION_ERROR", ve.getMessage()));
        } catch (JsonProcessingException jpe) {
            log.error("JSON parse error, requestId={}: {}", requestId, jpe.getMessage());
            return buildResponse(HTTP_BAD_REQUEST,
                    ErrorResponse.of("MALFORMED_JSON", "Unable to parse request body."));
        } catch (Exception ex) {
            log.error("Unhandled exception, requestId={}", requestId, ex);
            return buildResponse(HTTP_INTERNAL_SERVER_ERROR,
                    ErrorResponse.of("SERVER_ERROR",
                            "Unexpected error occurred; please retry later."));
        }
    }

    /*  ─────────────────────  Helpers  ───────────────────── */

    private static APIGatewayProxyResponseEvent buildResponse(int statusCode, Object payload) {
        try {
            return new APIGatewayProxyResponseEvent()
                    .withStatusCode(statusCode)
                    .withHeaders(Collections.singletonMap("Content-Type", "application/json"))
                    .withBody(MAPPER.writeValueAsString(payload));
        } catch (JsonProcessingException e) {
            // This should never happen; fallback to plain-text response
            return new APIGatewayProxyResponseEvent()
                    .withStatusCode(HTTP_INTERNAL_SERVER_ERROR)
                    .withBody("{\"error\":\"Unable to serialize response\"}");
        }
    }

    /*  ─────────────────────  Nested DTOs / Services / Utils  ───────────────────── */

    /**
     * Vital-stream envelope.
     */
    public static class VitalStreamEvent {
        private final String patientId;
        private final String deviceId;
        private final long eventTs;
        private final List<Vital> vitals;

        @JsonCreator
        public VitalStreamEvent(
                @JsonProperty(value = "patientId", required = true) String patientId,
                @JsonProperty(value = "deviceId",  required = true) String deviceId,
                @JsonProperty(value = "eventTs",   required = true) long eventTs,
                @JsonProperty(value = "vitals",    required = true) List<Vital> vitals) {
            this.patientId = patientId;
            this.deviceId  = deviceId;
            this.eventTs   = eventTs;
            this.vitals    = vitals == null ? Collections.emptyList() : vitals;
        }

        public String getPatientId() { return patientId; }
        public String getDeviceId()  { return deviceId; }
        public long   getEventTs()   { return eventTs; }
        public List<Vital> getVitals() { return vitals; }
    }

    /**
     * Single vital measurement.
     */
    public static class Vital {
        private final String type;
        private final String unit;
        private final double value;
        private final long ts;

        @JsonCreator
        public Vital(
                @JsonProperty(value = "type",  required = true) String type,
                @JsonProperty(value = "unit",  required = true) String unit,
                @JsonProperty(value = "value", required = true) double value,
                @JsonProperty(value = "ts",    required = true) long ts) {
            this.type  = type;
            this.unit  = unit;
            this.value = value;
            this.ts    = ts;
        }

        public String getType()  { return type; }
        public String getUnit()  { return unit; }
        public double getValue() { return value; }
        public long   getTs()    { return ts; }
    }

    /**
     * Basic FHIR Observation validator. In production, this would call
     * the official HL7 FHIR Java libraries, but here we only enforce minimal checks.
     */
    static class FhirValidator {

        void validate(VitalStreamEvent evt) throws ValidationException {
            if (evt.getPatientId() == null || evt.getPatientId().isBlank()) {
                throw new ValidationException("patientId must not be empty.");
            }
            if (evt.getDeviceId() == null || evt.getDeviceId().isBlank()) {
                throw new ValidationException("deviceId must not be empty.");
            }
            if (evt.getVitals().isEmpty()) {
                throw new ValidationException("At least one vital measurement is required.");
            }
            for (Vital v : evt.getVitals()) {
                if (v.getType() == null || v.getType().isBlank()) {
                    throw new ValidationException("Vital type must not be empty.");
                }
                if (v.getTs() <= 0 || v.getTs() > Instant.now().toEpochMilli() + 5_000) {
                    throw new ValidationException("Invalid vital timestamp: " + v.getTs());
                }
            }
        }
    }

    /**
     * Simple in-memory token-bucket rate-limiter keyed by arbitrary string.
     * NOTE: This implementation is NOT distributed and therefore only suitable
     * for single-Lambda containers. In production, use Redis, DynamoDB, or API-Gateway
     * native throttling instead.
     */
    static class TokenBucketRateLimiter {

        private final long capacity;
        private final long refillIntervalMs;
        private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

        TokenBucketRateLimiter(long capacity, long refillIntervalMs) {
            this.capacity          = capacity;
            this.refillIntervalMs  = refillIntervalMs;
        }

        boolean tryConsume(String key) {
            Bucket b = buckets.computeIfAbsent(key, k -> new Bucket(capacity, refillIntervalMs));
            return b.tryConsume();
        }

        private static class Bucket {
            private long tokens;
            private long lastRefill;
            private final long capacity;
            private final long interval;

            Bucket(long capacity, long interval) {
                this.capacity = capacity;
                this.interval = interval;
                this.tokens   = capacity;
                this.lastRefill = System.currentTimeMillis();
            }

            synchronized boolean tryConsume() {
                refill();
                if (tokens == 0) return false;
                tokens--;
                return true;
            }

            private void refill() {
                long now = System.currentTimeMillis();
                if (now - lastRefill >= interval) {
                    tokens = capacity;
                    lastRefill = now;
                }
            }
        }
    }

    /**
     * Service responsible for persisting the vital-stream event and emitting
     * domain events. In a real project, this would use the Repository + Mapper
     * pattern and integrate with DynamoDB. The implementation is simplified.
     */
    static class VitalIngestionService {

        private static final Logger serviceLog = LoggerFactory.getLogger(VitalIngestionService.class);

        // Illustrative DynamoDB table name (injected via env in real code)
        private static final String VITALS_TABLE = System.getenv()
                .getOrDefault("VITALS_TABLE", "cloudcare-vitals");

        private final DynamoDB dynamoDB;

        VitalIngestionService() {
            /* In production, read AWS credentials from the Lambda execution role. */
            this.dynamoDB = DynamoDBSingleton.getInstance();
        }

        void processVitalStream(VitalStreamEvent event) {
            /* Persist each vital reading separately to support time-series queries. */
            Table table = dynamoDB.getTable(VITALS_TABLE);

            event.getVitals().forEach(v -> {
                // Only log in this mock; replacing with real PutItem in production.
                serviceLog.info("Persisting vital: patient={}, type={}, value={}, ts={}",
                        event.getPatientId(), v.getType(), v.getValue(), v.getTs());
                // table.putItem(...);
            });

            /* Emit event for CQRS read-side population or other subscribers. */
            serviceLog.debug("Publishing ingestion event to SNS/ EventBridge (omitted).");
        }
    }

    /**
     * Centralized error response payload.
     */
    public static class ErrorResponse {
        private final String code;
        private final String message;

        private ErrorResponse(String code, String message) {
            this.code    = code;
            this.message = message;
        }

        public static ErrorResponse of(String code, String message) {
            return new ErrorResponse(code, message);
        }

        public String getCode()    { return code; }
        public String getMessage() { return message; }
    }

    /*  ─────────────────────  Custom exceptions  ───────────────────── */

    static class ValidationException extends Exception {
        ValidationException(String msg) { super(msg); }
    }

    /*  ─────────────────────  Lightweight DynamoDB Singleton  ───────────────────── */

    /**
     * Lazily initializes DynamoDB client once per Lambda container.
     */
    static final class DynamoDBSingleton {
        private static volatile DynamoDB instance;

        static DynamoDB getInstance() {
            if (instance == null) {
                synchronized (DynamoDBSingleton.class) {
                    if (instance == null) {
                        instance = new DynamoDB(
                                com.amazonaws.services.dynamodbv2.AmazonDynamoDBClientBuilder
                                        .standard()
                                        .build());
                    }
                }
            }
            return instance;
        }
    }
}
```