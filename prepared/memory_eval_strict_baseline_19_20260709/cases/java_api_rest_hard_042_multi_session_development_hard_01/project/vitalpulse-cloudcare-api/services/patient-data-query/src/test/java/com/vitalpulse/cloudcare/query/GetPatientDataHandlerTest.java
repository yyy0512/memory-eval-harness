package com.vitalpulse.cloudcare.query;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.when;

import java.time.Instant;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyRequestEvent;
import com.amazonaws.services.lambda.runtime.events.APIGatewayProxyResponseEvent;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.vitalpulse.cloudcare.common.error.ErrorCode;
import com.vitalpulse.cloudcare.common.error.NotFoundException;
import com.vitalpulse.cloudcare.query.handler.GetPatientDataHandler;
import com.vitalpulse.cloudcare.query.model.PatientDataResponse;
import com.vitalpulse.cloudcare.query.service.PatientDataService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * Unit-tests for {@link GetPatientDataHandler}.
 *
 * <p>
 * The handler is responsible for:
 * <ul>
 *     <li>Validating query/path parameters</li>
 *     <li>Invoking {@link PatientDataService}</li>
 *     <li>Marshalling the response to API Gateway format</li>
 *     <li>Mapping known exceptions to proper HTTP status codes</li>
 * </ul>
 *
 * <p>
 * Only the Happy Path and a handful of negative paths are validated here. Contract tests
 * against the deployed Lambda exist in the infra-layer of the repository.
 */
@ExtendWith(MockitoExtension.class)
class GetPatientDataHandlerTest {

    private static final ObjectMapper OBJECT_MAPPER =
            new ObjectMapper().registerModule(new JavaTimeModule());

    @Mock
    private PatientDataService patientDataService;

    private GetPatientDataHandler handler;

    @BeforeEach
    void setUp() {
        handler = new GetPatientDataHandler(patientDataService, OBJECT_MAPPER);
    }

    @Nested
    @DisplayName("Happy Path")
    class HappyPathTests {

        @Test
        @DisplayName("should return 200 with patient payload when service succeeds")
        void shouldReturn200() throws Exception {
            // given
            String patientId = UUID.randomUUID().toString();
            PatientDataResponse payload = PatientDataResponse.builder()
                    .patientId(patientId)
                    .timestamp(Instant.now())
                    .resources(Collections.emptyList())
                    .nextCursor("abc123")
                    .build();

            when(patientDataService.getPatientData(eq(patientId), eq(Optional.of("vitals")),
                    eq(0), eq(50)))
                    .thenReturn(payload);

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withPathParameters(Map.of("patientId", patientId))
                    .withQueryStringParameters(Map.of(
                            "resourceType", "vitals",
                            "offset", "0",
                            "limit", "50"));

            // when
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, null);

            // then
            assertThat(response.getStatusCode()).isEqualTo(200);

            Map<String, Object> bodyMap =
                    OBJECT_MAPPER.readValue(response.getBody(), new TypeReference<>() {
                    });

            assertThat(bodyMap)
                    .containsEntry("patientId", patientId)
                    .containsKey("resources")
                    .containsEntry("nextCursor", "abc123");
        }
    }

    @Nested
    @DisplayName("Validation Errors")
    class ValidationErrorTests {

        @Test
        @DisplayName("should return 400 when patientId is not a well-formed UUID")
        void shouldReturn400ForInvalidPatientId() {
            // given
            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withPathParameters(Map.of("patientId", "not-a-uuid"));

            // when
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, null);

            // then
            assertThat(response.getStatusCode()).isEqualTo(400);
            assertThat(response.getBody()).contains(ErrorCode.VALIDATION_FAILED.name());
        }

        @Test
        @DisplayName("should return 400 when limit is out of bounds (>500)")
        void shouldReturn400ForExcessiveLimit() {
            // given
            String patientId = UUID.randomUUID().toString();
            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withPathParameters(Map.of("patientId", patientId))
                    .withQueryStringParameters(Map.of("limit", "501"));

            // when
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, null);

            // then
            assertThat(response.getStatusCode()).isEqualTo(400);
        }
    }

    @Nested
    @DisplayName("Domain Errors")
    class DomainErrorTests {

        @Test
        @DisplayName("should map NotFoundException to 404")
        void shouldReturn404WhenPatientNotFound() {
            // given
            String patientId = UUID.randomUUID().toString();
            when(patientDataService.getPatientData(eq(patientId), any(), anyInt(), anyInt()))
                    .thenThrow(new NotFoundException(ErrorCode.PATIENT_NOT_FOUND, "No patient"));

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withPathParameters(Map.of("patientId", patientId));

            // when
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, null);

            // then
            assertThat(response.getStatusCode()).isEqualTo(404);
            assertThat(response.getBody()).contains(ErrorCode.PATIENT_NOT_FOUND.name());
        }

        @Test
        @DisplayName("should map unexpected exception to 500")
        void shouldReturn500ForUnhandledException() {
            // given
            String patientId = UUID.randomUUID().toString();
            when(patientDataService.getPatientData(eq(patientId), any(), anyInt(), anyInt()))
                    .thenThrow(new RuntimeException("downstream DB failure"));

            APIGatewayProxyRequestEvent request = new APIGatewayProxyRequestEvent()
                    .withPathParameters(Map.of("patientId", patientId));

            // when
            APIGatewayProxyResponseEvent response = handler.handleRequest(request, null);

            // then
            assertThat(response.getStatusCode()).isEqualTo(500);
            assertThat(response.getBody()).contains("Internal server error");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Helper methods
    // ---------------------------------------------------------------------------------------------

    /**
     * Utility that converts a Map into a JSON string without checked exceptions.
     * This makes assertions less verbose inside individual test cases.
     */
    private static String toJsonSilently(Object object) {
        try {
            return OBJECT_MAPPER.writeValueAsString(object);
        } catch (Exception ex) {
            throw new RuntimeException("Failed to serialise JSON in test", ex);
        }
    }

    /**
     * Convenience builder for a minimal PatientDataResponse instance usable as a stub.
     */
    private static PatientDataResponse samplePatientData(String patientId) {
        return PatientDataResponse.builder()
                .patientId(patientId)
                .timestamp(Instant.now())
                .resources(Collections.emptyList())
                .nextCursor(null)
                .build();
    }
}