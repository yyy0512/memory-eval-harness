package com.vitalpulse.cloudcare.query.handler;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.RequestHandler;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vitalpulse.cloudcare.common.exception.AccessDeniedException;
import com.vitalpulse.cloudcare.common.exception.PatientNotFoundException;
import com.vitalpulse.cloudcare.common.exception.RateLimitExceededException;
import com.vitalpulse.cloudcare.common.metrics.MetricsPublisher;
import com.vitalpulse.cloudcare.common.validation.RequestValidator;
import com.vitalpulse.cloudcare.query.model.PaginatedResult;
import com.vitalpulse.cloudcare.query.model.PatientDataRecord;
import com.vitalpulse.cloudcare.query.service.PatientDataQueryService;
import com.vitalpulse.cloudcare.query.service.impl.DynamoDbPatientDataQueryService;
import com.vitalpulse.cloudcare.security.AccessControlService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;

/**
 * AWS Lambda handler responsible for retrieving paginated streams of patient data
 * (vital signs, medication events, orders) from the read-replica datastore.
 *
 * <p>Features implemented:
 * <ul>
 *     <li>SMART on FHIR scope enforcement</li>
 *     <li>Request validation &amp; sanitisation</li>
 *     <li>Rate-limiting at user/tenant granularity</li>
 *     <li>Cursor-based pagination</li>
 *     <li>Centralised error handling &amp; metrics</li>
 * </ul>
 *
 * Expected request (API Gateway HTTP API):
 *   GET /v1/patients/{patientId}/data?cursor={opaque}&pageSize=250
 *
 * Response:
 *   200 OK
 *   {
 *       "patientId": "123",
 *       "items": [ { ...FHIR Observation... }, ... ],
 *       "nextCursor": "opaque"
 *   }
 *
 * Error responses follow RFC 7807 (Problem Details).
 */
public class GetPatientDataHandler implements
        RequestHandler<APIGatewayProxyRequestEvent, APIGatewayProxyResponseEvent> {

    private static final Logger LOG = LoggerFactory.getLogger(GetPatientDataHandler.class);
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    /* Configuration constants */
    private static final int MAX_PAGE_SIZE = 1000;
    private static final int DEFAULT_PAGE_SIZE = 250;

    /* Dependencies – ideally injected by a DI container (e.g. Dagger) */
    private final PatientDataQueryService queryService;
    private final RequestValidator requestValidator;
    private final AccessControlService accessControlService;
    private final MetricsPublisher metricsPublisher;

    // Default constructor used by AWS Lambda runtime
    public GetPatientDataHandler() {
        this.queryService = new DynamoDbPatientDataQueryService();
        this.requestValidator = new RequestValidator();
        this.accessControlService = new AccessControlService();
        this.metricsPublisher = new MetricsPublisher();
    }

    // Visible for testing
    public GetPatientDataHandler(final PatientDataQueryService queryService,
                                 final RequestValidator requestValidator,
                                 final AccessControlService accessControlService,
                                 final MetricsPublisher metricsPublisher) {
        this.queryService = Objects.requireNonNull(queryService);
        this.requestValidator = Objects.requireNonNull(requestValidator);
        this.accessControlService = Objects.requireNonNull(accessControlService);
        this.metricsPublisher = Objects.requireNonNull(metricsPublisher);
    }

    @Override
    public APIGatewayProxyResponseEvent handleRequest(final APIGatewayProxyRequestEvent request,
                                                      final Context context) {
        final Instant start = Instant.now();
        try {
            /* 1. Basic request sanity check */
            validateHttpMethod(request);

            /* 2. Extract/validate parameters */
            final String patientId = extractPatientId(request);
            final String authHeader = Optional.ofNullable(request.getHeaders())
                                              .map(h -> h.get("Authorization"))
                                              .orElse(null);
            final int pageSize = extractPageSize(request);
            final String cursor = extractCursor(request);

            /* 3. Rate-limit evaluation */
            enforceRateLimit(authHeader, patientId);

            /* 4. Scope & patient-level access control */
            accessControlService.assertReadAccess(authHeader, patientId);

            /* 5. Service call */
            PaginatedResult<PatientDataRecord> result =
                    queryService.getPatientData(patientId, pageSize, cursor);

            /* 6. Success response */
            Map<String, Object> payload = new LinkedHashMap<>(4);
            payload.put("patientId", patientId);
            payload.put("items", result.getItems());
            payload.put("nextCursor", result.getNextCursor());

            metricsPublisher.publishOk("GetPatientData", start);
            return buildResponse(200, payload);

        } catch (IllegalArgumentException e) {
            LOG.warn("Bad request", e);
            metricsPublisher.publishError("GetPatientData", start, 400);
            return buildErrorResponse(400, "invalid_request", e.getMessage());

        } catch (AccessDeniedException e) {
            LOG.warn("Access denied", e);
            metricsPublisher.publishError("GetPatientData", start, 403);
            return buildErrorResponse(403, "access_denied", e.getMessage());

        } catch (PatientNotFoundException e) {
            LOG.debug("Patient not found", e);
            metricsPublisher.publishError("GetPatientData", start, 404);
            return buildErrorResponse(404, "patient_not_found", e.getMessage());

        } catch (RateLimitExceededException e) {
            LOG.info("Rate limit exceeded", e);
            metricsPublisher.publishError("GetPatientData", start, 429);
            return buildErrorResponse(429, "rate_limit_exceeded", e.getMessage());

        } catch (Exception e) {
            LOG.error("Unexpected error", e);
            metricsPublisher.publishError("GetPatientData", start, 500);
            return buildErrorResponse(500, "internal_server_error",
                    "An unexpected error occurred. Reference: " + context.getAwsRequestId());
        }
    }

    /* --------------------------------------------------------------------- */
    /* ------------------------- Helper methods ---------------------------- */
    /* --------------------------------------------------------------------- */

    private void validateHttpMethod(APIGatewayProxyRequestEvent request) {
        if (!"GET".equalsIgnoreCase(request.getHttpMethod())) {
            throw new IllegalArgumentException("Unsupported HTTP method. Expected GET.");
        }
    }

    private String extractPatientId(APIGatewayProxyRequestEvent request) {
        String patientId = Optional.ofNullable(request.getPathParameters())
                                   .map(map -> map.get("patientId"))
                                   .orElse(null);

        requestValidator.requireNonBlank(patientId, "patientId");

        // Additional FHIR Id constraints if needed
        return patientId;
    }

    private int extractPageSize(APIGatewayProxyRequestEvent request) {
        String raw = Optional.ofNullable(request.getQueryStringParameters())
                             .map(q -> q.get("pageSize"))
                             .orElse(null);
        if (raw == null || raw.isBlank()) {
            return DEFAULT_PAGE_SIZE;
        }
        try {
            int size = Integer.parseInt(raw);
            if (size < 1 || size > MAX_PAGE_SIZE) {
                throw new IllegalArgumentException("pageSize must be between 1 and " + MAX_PAGE_SIZE);
            }
            return size;
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("pageSize must be an integer");
        }
    }

    private String extractCursor(APIGatewayProxyRequestEvent request) {
        return Optional.ofNullable(request.getQueryStringParameters())
                       .map(q -> q.get("cursor"))
                       .orElse(null);
    }

    private void enforceRateLimit(String authHeader, String patientId) {
        // Delegates to shared rate-limit util (bucket4j / redis)
        String principal = accessControlService.resolvePrincipal(authHeader);
        boolean allowed = accessControlService.isRequestAllowed(principal, "GetPatientData");
        if (!allowed) {
            throw new RateLimitExceededException("Rate limit exceeded");
        }
    }

    private APIGatewayProxyResponseEvent buildResponse(int statusCode, Object body) {
        try {
            return new APIGatewayProxyResponseEvent()
                    .withStatusCode(statusCode)
                    .withHeaders(defaultHeaders())
                    .withBody(OBJECT_MAPPER.writeValueAsString(body));
        } catch (JsonProcessingException e) {
            // Fallback – should never happen for simple structures
            throw new RuntimeException("Failed to serialise response", e);
        }
    }

    private APIGatewayProxyResponseEvent buildErrorResponse(int statusCode,
                                                            String type,
                                                            String detail) {
        Map<String, Object> problem = new LinkedHashMap<>();
        problem.put("type", type);
        problem.put("detail", detail);
        problem.put("status", statusCode);
        problem.put("timestamp", Instant.now().toString());
        return buildResponse(statusCode, problem);
    }

    private Map<String, String> defaultHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }
}