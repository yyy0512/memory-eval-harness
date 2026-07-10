package com.vitalpulse.cloudcare.api_rest.tests;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.vitalpulse.cloudcare.api_rest.common.RateLimiter;
import com.vitalpulse.cloudcare.api_rest.common.TokenBucketRateLimiter;
import com.vitalpulse.cloudcare.api_rest.validation.FhirJsonValidator;
import com.vitalpulse.cloudcare.api_rest.web.ErrorHandler;
import com.vitalpulse.cloudcare.api_rest.web.dto.ErrorResponse;
import org.junit.jupiter.api.*;
import org.mockito.Mockito;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

/**
 * High-level integration/contract tests for critical cross-cutting concerns such as
 *  – Rate limiting
 *  – FHIR JSON request validation
 *  – Error-handling serialization
 *
 * The goal is to protect public, compliance-relevant behaviour from accidental regressions.
 */
@TestMethodOrder(MethodOrderer.DisplayName.class)
class CloudCarePlatformContractTest {

    /* --------------------------------------------------------------------- *
     *  Rate-Limiter Contract                                                *
     * --------------------------------------------------------------------- */

    @Nested
    @DisplayName("1️⃣  TokenBucketRateLimiter")
    class RateLimiterTests {

        private static final int MAX_REQUESTS_PER_SECOND = 5;
        private RateLimiter rateLimiter;

        @BeforeEach
        void setUp() {
            // TokenBucketRateLimiter is the production implementation backed by a thread-safe token bucket.
            rateLimiter = new TokenBucketRateLimiter(MAX_REQUESTS_PER_SECOND, Duration.ofSeconds(1));
        }

        @Test
        @DisplayName("1.1 ‑ Allows up to N requests per second for a single key")
        void shouldPermitUpToBurstCapacity() {
            String key = "patient-stream-abc123";
            for (int i = 0; i < MAX_REQUESTS_PER_SECOND; i++) {
                assertTrue(rateLimiter.tryAcquire(key), "token " + i + " should have been granted");
            }
            // The (N+1)th request in the same window must be rejected
            assertFalse(rateLimiter.tryAcquire(key), "exceeding burst capacity should be rejected");
        }

        @Test
        @DisplayName("1.2 ‑ Refills tokens after window elapses")
        void shouldRefillAfterWindow() throws InterruptedException {
            String key = "device-telemetry-xyz789";
            for (int i = 0; i < MAX_REQUESTS_PER_SECOND; i++) {
                assertTrue(rateLimiter.tryAcquire(key));
            }
            assertFalse(rateLimiter.tryAcquire(key)); // depleted

            // Wait for at least one full window for tokens to refill
            Thread.sleep(1_050);

            assertTrue(rateLimiter.tryAcquire(key), "token bucket should have refilled after 1 second");
        }

        @Test
        @DisplayName("1.3 ‑ Is thread-safe under heavy contention")
        void shouldBehaveCorrectlyUnderConcurrency() throws InterruptedException {
            String key = "shared-endpoint-key";
            int threadCount = 25;
            ExecutorService executor = Executors.newFixedThreadPool(threadCount);
            CountDownLatch latch = new CountDownLatch(threadCount);

            List<Boolean> outcomes = new CopyOnWriteArrayList<>();
            for (int i = 0; i < threadCount; i++) {
                executor.submit(() -> {
                    outcomes.add(rateLimiter.tryAcquire(key));
                    latch.countDown();
                });
            }
            latch.await();
            executor.shutdownNow();

            long permitsGranted = outcomes.stream().filter(b -> b).count();
            assertEquals(MAX_REQUESTS_PER_SECOND, permitsGranted,
                    "exactly " + MAX_REQUESTS_PER_SECOND + " permits should be granted in the window");
        }
    }

    /* --------------------------------------------------------------------- *
     *  FHIR JSON Request Validator                                          *
     * --------------------------------------------------------------------- */

    @Nested
    @DisplayName("2️⃣  FhirJsonValidator")
    class RequestValidationTests {

        private FhirJsonValidator validator;
        private ObjectMapper mapper;

        @BeforeEach
        void init() {
            validator = new FhirJsonValidator();  // production schema-based validator
            mapper    = new ObjectMapper();
        }

        @Test
        @DisplayName("2.1 ‑ Accepts a minimal, valid Patient resource")
        void shouldValidateValidPatientResource() throws IOException {
            String patientJson = """
                {
                  "resourceType": "Patient",
                  "id": "example",
                  "name": [ { "use": "official", "family": "Doe", "given": ["John"] } ],
                  "gender": "male",
                  "birthDate": "1974-12-25"
                }
                """;

            JsonNode node = mapper.readTree(patientJson);
            assertDoesNotThrow(() -> validator.validate("Patient", node));
        }

        @Test
        @DisplayName("2.2 ‑ Rejects resource that violates schema constraints")
        void shouldRejectInvalidPatientResource() throws IOException {
            String invalidPatientJson = """
                {
                  "resourceType": "Patient",
                  "id": "bad-example",
                  "birthDate": "not-a-date"
                }
                """;

            JsonNode node = mapper.readTree(invalidPatientJson);
            Exception ex = assertThrows(IllegalArgumentException.class,
                    () -> validator.validate("Patient", node));

            assertTrue(ex.getMessage().contains("birthDate"), "error message should mention failing attribute");
        }
    }

    /* --------------------------------------------------------------------- *
     *  Error-Handling Serialization                                         *
     * --------------------------------------------------------------------- */

    @Nested
    @DisplayName("3️⃣  ErrorHandler")
    class ErrorHandlerTests {

        private ErrorHandler errorHandler;

        @BeforeEach
        void init() {
            errorHandler = new ErrorHandler();
        }

        @Test
        @DisplayName("3.1 ‑ Translates IllegalArgumentException to 400 Bad Request")
        void shouldTranslateIllegalArg() {
            IllegalArgumentException ex = new IllegalArgumentException("unit test invalid parameter");
            ErrorResponse response = errorHandler.toErrorResponse(ex);

            assertEquals(400, response.statusCode());
            assertEquals("Bad Request", response.reasonPhrase());
            assertTrue(response.message().contains("invalid parameter"));
        }

        @Test
        @DisplayName("3.2 ‑ Translates generic Exception to 500 Internal Server Error")
        void shouldTranslateGenericException() {
            Exception ex = new RuntimeException("unexpected failure");
            ErrorResponse response = errorHandler.toErrorResponse(ex);

            assertEquals(500, response.statusCode());
            assertEquals("Internal Server Error", response.reasonPhrase());
            assertTrue(response.message().contains("unexpected failure"));
        }

        @Test
        @DisplayName("3.3 ‑ Uses validation errors to create RFC 7807 problem+json bodies")
        void shouldCreateProblemJsonForValidationErrors() {
            // Use Mockito to simulate a validation exception that carries multiple field errors
            IllegalArgumentException validationEx = Mockito.mock(IllegalArgumentException.class);
            when(validationEx.getMessage()).thenReturn("`name` must not be null; `age` must be positive");

            ErrorResponse response = errorHandler.toErrorResponse(validationEx);

            assertEquals("application/problem+json", response.contentType());
            assertTrue(response.message().contains("name"));
            assertTrue(response.message().contains("age"));
        }
    }
}