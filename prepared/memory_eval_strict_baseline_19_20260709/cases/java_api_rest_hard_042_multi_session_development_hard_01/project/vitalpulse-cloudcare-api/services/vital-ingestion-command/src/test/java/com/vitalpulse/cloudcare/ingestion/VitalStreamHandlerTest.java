package com.vitalpulse.cloudcare.ingestion;

import com.amazonaws.services.lambda.runtime.Context;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.vitalpulse.cloudcare.ingestion.handler.VitalStreamHandler;
import com.vitalpulse.cloudcare.ingestion.model.VitalRecord;
import com.vitalpulse.cloudcare.ingestion.repository.VitalRecordRepository;
import com.vitalpulse.cloudcare.ingestion.service.RateLimiterService;
import com.vitalpulse.cloudcare.ingestion.validation.VitalRecordValidator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.AdditionalAnswers;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link VitalStreamHandler}.
 *
 * <p>
 * The handler ingests vital-sign telemetry (heart rate, blood pressure, SpO₂, etc.) posted by an
 * authorized medical device.  It performs:
 *
 * <ul>
 *     <li>Body + header validation (FHIR JSON schema, OAuth2 scopes, size limits).</li>
 *     <li>Rate limiting per device (token-bucket algorithm in Redis).</li>
 *     <li>Persistence to DynamoDB via {@link VitalRecordRepository}.</li>
 *     <li>Audit + error responses with a traceable correlation-id.</li>
 * </ul>
 */
@ExtendWith(MockitoExtension.class)
class VitalStreamHandlerTest {

    @Mock
    private VitalRecordValidator validator;

    @Mock
    private VitalRecordRepository repository;

    @Mock
    private RateLimiterService rateLimiter;

    @Mock
    private Context ctx;

    /**
     * Handler under test – instantiated with dependency
     * injection to allow fine-grained behaviour stubbing.
     */
    @InjectMocks
    private VitalStreamHandler handler;

    private static final String DEVICE_ID = "device-12345";
    private static final String PATIENT_ID = "patient-67890";

    @BeforeEach
    void setUp() {
        when(ctx.getAwsRequestId()).thenReturn("req-" + UUID.randomUUID());
    }

    @Nested
    @DisplayName("Happy path")
    class HappyPath {

        @Test
        @DisplayName("Should persist record and return HTTP 201 when payload is valid")
        void testSuccessfulIngestionReturns201() {
            // arrange
            APIGatewayProxyRequestEvent request = createRequest(generateValidBody());

            // validator returns deserialized entity
            VitalRecord expectedRecord = buildRecord();
            when(validator.validateAndTransform(anyString(), anyMap()))
                    .thenReturn(expectedRecord);

            // bucket has room
            when(rateLimiter.tryConsume(anyString())).thenReturn(true);

            // repository returns generated id
            when(repository.save(any(VitalRecord.class)))
                    .thenAnswer(AdditionalAnswers.returnsFirstArg());

            // act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, ctx);

            // assert
            assertEquals(201, response.getStatusCode());
            assertTrue(response.getHeaders().containsKey("Location"));
            assertTrue(response.getHeaders().get("Content-Type").contains("application/json"));

            // verify persisted record
            ArgumentCaptor<VitalRecord> captor = ArgumentCaptor.forClass(VitalRecord.class);
            verify(repository).save(captor.capture());
            assertEquals(expectedRecord.getPatientId(), captor.getValue().getPatientId());
            assertEquals(expectedRecord.getDeviceId(), captor.getValue().getDeviceId());
        }
    }

    @Nested
    @DisplayName("Validation failures")
    class ValidationFailures {

        @Test
        @DisplayName("Should return HTTP 400 when validation fails")
        void testValidationFailureReturns400() {
            // arrange
            APIGatewayProxyRequestEvent request = createRequest("{ malformed-json ");

            when(validator.validateAndTransform(anyString(), anyMap()))
                    .thenThrow(new IllegalArgumentException("FHIR schema violation"));

            // act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, ctx);

            // assert
            assertEquals(400, response.getStatusCode());
            assertTrue(response.getBody().contains("FHIR schema"));
            verify(repository, never()).save(any());
        }
    }

    @Nested
    @DisplayName("Rate limiting")
    class RateLimit {

        @Test
        @DisplayName("Should return HTTP 429 when device exceeds throughput quota")
        void testRateLimitExceededReturns429() {
            // arrange
            APIGatewayProxyRequestEvent request = createRequest(generateValidBody());

            when(validator.validateAndTransform(anyString(), anyMap()))
                    .thenReturn(buildRecord());

            when(rateLimiter.tryConsume(anyString())).thenReturn(false);

            // act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, ctx);

            // assert
            assertEquals(429, response.getStatusCode());
            assertTrue(response.getBody().contains("rate limit"));
            verify(repository, never()).save(any());
        }
    }

    @Nested
    @DisplayName("Repository errors")
    class RepositoryErrors {

        @Test
        @DisplayName("Should return HTTP 500 with correlation-id when persistence fails")
        void testRepositoryFailureReturns500() {
            // arrange
            APIGatewayProxyRequestEvent request = createRequest(generateValidBody());

            when(validator.validateAndTransform(anyString(), anyMap()))
                    .thenReturn(buildRecord());

            when(rateLimiter.tryConsume(anyString())).thenReturn(true);

            when(repository.save(any()))
                    .thenThrow(new RuntimeException("DynamoDB unreachable"));

            // act
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, ctx);

            // assert
            assertEquals(500, response.getStatusCode());
            assertTrue(response.getHeaders().containsKey("X-Correlation-Id"));
            verify(repository).save(any());
        }
    }

    // ---------------------------------------------------------------------
    // Helper methods
    // ---------------------------------------------------------------------

    /**
     * Builds a representative FHIR R4 vital-sign record.
     */
    private VitalRecord buildRecord() {
        return VitalRecord.builder()
                .recordId(UUID.randomUUID().toString())
                .deviceId(DEVICE_ID)
                .patientId(PATIENT_ID)
                .timestamp(Instant.now())
                .type("heart-rate")
                .unit("beats/min")
                .value(78.3)
                .build();
    }

    /**
     * Serialised JSON body matching the format the validator expects.
     */
    private String generateValidBody() {
        return "{\n" +
               "  \"patientId\": \"" + PATIENT_ID + "\",\n" +
               "  \"deviceId\": \"" + DEVICE_ID + "\",\n" +
               "  \"timestamp\": \"" + Instant.now() + "\",\n" +
               "  \"type\": \"heart-rate\",\n" +
               "  \"value\": 78.3,\n" +
               "  \"unit\": \"beats/min\"\n" +
               "}";
    }

    /**
     * Constructs an {@link APIGatewayProxyRequestEvent} with essential HTTP headers
     * commonly sent by IoT devices using mTLS + OAuth2.
     */
    private APIGatewayProxyRequestEvent createRequest(String body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", "application/json");
        headers.put("Authorization", "Bearer some.jwt.token");
        headers.put("X-Device-Id", DEVICE_ID);

        return new APIGatewayProxyRequestEvent()
                .withHeaders(headers)
                .withBody(body)
                .withHttpMethod("POST")
                .withPath("/v1/patients/" + PATIENT_ID + "/vitals");
    }
}