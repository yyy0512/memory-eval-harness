package com.vitalpulse.cloudcare.query.handler;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.LambdaLogger;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.amazonaws.xray.AWSXRay;
import com.amazonaws.xray.entities.Subsegment;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.google.common.base.Strings;
import com.google.common.util.concurrent.RateLimiter;
import com.vitalpulse.cloudcare.query.model.PagedVitals;
import com.vitalpulse.cloudcare.query.repository.PatientVitalRepository;
import com.vitalpulse.cloudcare.query.repository.impl.DynamoDbPatientVitalRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * AWS Lambda handler that retrieves paginated patient vital records.
 * <p>
 *     Endpoint:  GET /v1/patients/{patientId}/vitals
 *     Query params:
 *          limit  – optional, defaults to 50
 *          cursor – optional, for forward pagination
 * </p>
 *
 * Error codes:
 *  400 – validation error
 *  404 – patient not found
 *  429 – rate limit exceeded
 *  500 – internal server error
 */
public class GetPatientVitalsHandler implements RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Logger LOG = LoggerFactory.getLogger(GetPatientVitalsHandler.class);
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);

    // Allow 20 req / sec per Lambda instance (additional API-GW limits may apply)
    private static final RateLimiter RATE_LIMITER = RateLimiter.create(20.0);

    // UUID regex, supports hyphen-less variant as some devices omit dashes
    private static final Pattern PATIENT_ID_PATTERN =
            Pattern.compile("^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{8}\\-[0-9a-fA-F]{4}\\-[0-9a-fA-F]{4}\\-[0-9a-fA-F]{4}\\-[0-9a-fA-F]{12}$");

    private final PatientVitalRepository repository;

    public GetPatientVitalsHandler() {
        // In production, use DI (e.g., Dagger) to swap implementations & facilitate testing
        this.repository = new DynamoDbPatientVitalRepository();
    }

    /* VisibleForTesting */ GetPatientVitalsHandler(PatientVitalRepository repository) {
        this.repository = repository;
    }

    @Override
    public APIGatewayProxyResponseEvent handleRequest(APIGatewayProxyRequestEvent event, Context context) {
        LambdaLogger lambdaLogger = context.getLogger();

        if (!RATE_LIMITER.tryAcquire()) {
            return respond(429, new ErrorResponse("RATE_LIMIT_EXCEEDED", "Too many requests – slow down"));
        }

        String patientId = extractPatientId(event.getPathParameters());
        Optional<ValidationError> validationError = validatePatientId(patientId);

        if (validationError.isPresent()) {
            return respond(400, new ErrorResponse("VALIDATION_ERROR", validationError.get().message()));
        }

        int limit = parseLimit(event.getQueryStringParameters());
        String cursor = parseCursor(event.getQueryStringParameters());

        Subsegment subsegment = AWSXRay.beginSubsegment("GetPatientVitals");
        try {
            subsegment.putAnnotation("patientId", patientId);
            subsegment.putMetadata("limit", limit);
            if (cursor != null) {
                subsegment.putMetadata("cursor", cursor);
            }

            Instant start = Instant.now();
            PagedVitals pagedVitals = repository.findVitalsByPatientId(patientId, limit, cursor);
            subsegment.putMetadata("loadDurationMs",
                                   java.time.Duration.between(start, Instant.now()).toMillis());

            if (pagedVitals.getVitals().isEmpty()) {
                return respond(404, new ErrorResponse("NOT_FOUND", "No vitals found for patient"));
            }
            return respond(200, pagedVitals);
        } catch (IllegalArgumentException iae) {
            LOG.warn("Validation failure: {}", iae.getMessage());
            lambdaLogger.log("Validation failure: " + iae.getMessage());
            return respond(400, new ErrorResponse("VALIDATION_ERROR", iae.getMessage()));
        } catch (Exception ex) {
            LOG.error("Unhandled error while processing request", ex);
            lambdaLogger.log("Unhandled error: " + ex.getMessage());
            return respond(500, new ErrorResponse("INTERNAL_SERVER_ERROR", "Unexpected error occurred"));
        } finally {
            AWSXRay.endSubsegment();
        }
    }

    // -------------------- Helpers -------------------------------------------------------------

    private String extractPatientId(Map<String, String> pathParams) {
        if (pathParams == null) {
            return null;
        }
        return pathParams.get("patientId");
    }

    private Optional<ValidationError> validatePatientId(String patientId) {
        if (Strings.isNullOrEmpty(patientId)) {
            return Optional.of(new ValidationError("patientId must be provided"));
        }
        if (!PATIENT_ID_PATTERN.matcher(patientId).matches()) {
            return Optional.of(new ValidationError("patientId must be a valid UUID"));
        }
        return Optional.empty();
    }

    private int parseLimit(Map<String, String> queryParams) {
        if (queryParams == null || queryParams.get("limit") == null) {
            return 50; // default
        }
        try {
            int limit = Integer.parseInt(queryParams.get("limit"));
            if (limit <= 0 || limit > 250) {
                throw new IllegalArgumentException("limit must be between 1 and 250");
            }
            return limit;
        } catch (NumberFormatException nfe) {
            throw new IllegalArgumentException("limit must be an integer", nfe);
        }
    }

    private String parseCursor(Map<String, String> queryParams) {
        if (queryParams == null) {
            return null;
        }
        return queryParams.get("cursor");
    }

    private APIGatewayProxyResponseEvent respond(int statusCode, Object body) {
        try {
            return new APIGatewayProxyResponseEvent()
                    .withStatusCode(statusCode)
                    .withHeaders(Map.of(
                            "Content-Type", "application/json",
                            "Cache-Control", "no-store",
                            "X-Request-Timestamp", Instant.now().toString()))
                    .withBody(MAPPER.writeValueAsString(body));
        } catch (JsonProcessingException e) {
            // Fallback – this should never happen with simple DTOs
            LOG.error("JSON serialization failed", e);
            return new APIGatewayProxyResponseEvent()
                    .withStatusCode(500)
                    .withBody("{\"error\":\"Serialization failure\"}");
        }
    }

    // -------------------- DTOs ---------------------------------------------------------------

    private record ErrorResponse(String code, String message) {}

    private record ValidationError(String message) {}
}