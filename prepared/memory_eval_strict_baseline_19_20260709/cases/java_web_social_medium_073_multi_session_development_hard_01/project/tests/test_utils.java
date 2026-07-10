```java
package com.edupulse.tests.util;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Comprehensive unit–tests targeting utility helpers that are frequently
 * used across the EduPulse Live Learning Hub code-base.  Although the
 * utilities under test are intentionally lightweight, defects in these
 * touch-points would ripple throughout the system.  Accordingly, the
 * assertions below place a strong emphasis on input edge-cases, proper
 * exception propagation, and thread-safety guarantees.
 */
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@SuppressWarnings("NewClassNamingConvention") // the file is named test_utils.java intentionally
public class test_utils {

    /* ------------------------------------------------------------------
     *  Validation-related tests
     * ------------------------------------------------------------------ */
    @Nested
    @DisplayName("ValidationUtils e-mail format checks")
    class EmailValidation {

        @ParameterizedTest(name = "address=\"{0}\"  ->  expectedValid={1}")
        @CsvSource(textBlock = """
                alice@example.com,               true
                BOB@SCHOOL.EDU,                  true
                "carol.smith@sub.domain.org",    true
                "invalid@",                      false
                "@invalid.com",                  false
                "spaces in@address.com",         false
                "missing.tld@domain.",           false
                ".leading@dot.com",              false
                "trailing.@dot.com",             false
                "double..dot@domain.com",        false
                """)
        void shouldValidateEmailFormat(String email, boolean expectedValid) {
            assertEquals(expectedValid,
                         ValidationUtils.isValidEmail(email),
                         "Unexpected e-mail validation result for: " + email);
        }

        @Test
        @DisplayName("requireNonBlank should throw IllegalArgumentException on blank input")
        void requireNonBlankMustFailOnBlank() {
            Executable exec = () -> ValidationUtils.requireNonBlank("   ", "input");
            IllegalArgumentException ex = assertThrows(IllegalArgumentException.class, exec);
            assertTrue(ex.getMessage().contains("input"),
                       "Exception message should echo the parameter name");
        }
    }

    /* ------------------------------------------------------------------
     *  Human-readable file-size formatting
     * ------------------------------------------------------------------ */
    @Nested
    @DisplayName("FileSizeFormatter")
    class FileSizeFormatting {

        @ParameterizedTest(name = "{0} bytes  ->  \"{1}\" (SI={2})")
        @CsvSource(textBlock = """
                0,               0 B,              true
                999,             999 B,            true
                1024,            1.00 KiB,         false
                1536,            1.50 KiB,         false
                1048576,         1.00 MiB,         false
                5368709120,      5.37 GiB,         false
                """)
        void shouldFormatFileSizes(long bytes, String expected, boolean siUnits) {
            assertEquals(expected,
                         FileSizeFormatter.humanReadableByteCount(bytes, siUnits),
                         "Unexpected formatting for " + bytes + " bytes");
        }
    }

    /* ------------------------------------------------------------------
     *  Serialization round-trip checks
     * ------------------------------------------------------------------ */
    @Nested
    @DisplayName("EventPayloadSerializer")
    class Serializer {

        @Test
        @DisplayName("A serialized DomainEvent must deserialize to an equal copy")
        void roundTripSerialization() {
            ExampleEvent original = new ExampleEvent("pulse-123", "alice", 10);
            String json = EventPayloadSerializer.serialize(original);
            ExampleEvent copy = EventPayloadSerializer.deserialize(json, ExampleEvent.class);

            assertEquals(original, copy, "Deserialized copy must equal the original");
            assertEquals(original.hashCode(), copy.hashCode(),
                         "hashCode contract should be preserved through serialization");
        }
    }

    /* ------------------------------------------------------------------
     *  Retry helper
     * ------------------------------------------------------------------ */
    @Nested
    @DisplayName("RetryExecutor – transient-failure handling")
    class RetryExecutorSpec {

        @Test
        @Timeout(2) // hard upper-bound to prevent runaway retries
        void shouldRetryUntilSuccessOrExhaustion() {
            AtomicInteger counter = new AtomicInteger();
            String result = RetryExecutor.execute(
                    3,
                    Duration.ofMillis(10),
                    () -> {
                        if (counter.incrementAndGet() < 3) {
                            throw new IllegalStateException("transient failure");
                        }
                        return "OK";
                    });

            assertEquals("OK", result, "Expected final result after retries");
            assertEquals(3, counter.get(), "Unexpected retry count");
        }

        @Test
        void shouldPropagateExceptionAfterMaxAttempts() {
            AtomicInteger counter = new AtomicInteger();
            assertThrows(IllegalStateException.class, () ->
                    RetryExecutor.execute(
                            2,
                            Duration.ofMillis(1),
                            () -> {
                                counter.incrementAndGet();
                                throw new IllegalStateException("still failing");
                            })
            );
            assertEquals(2, counter.get(), "Should attempt exactly maxAttempts times");
        }
    }

    /* ==============================================================
     *  ┌───────────────────────────────────────────────────────────┐
     *  │  Below are ultra-minimal implementations of the utilities │
     *  │  referenced in the tests.  In the real code-base they     │
     *  │  would live in src/main/java and be considerably richer.  │
     *  └───────────────────────────────────────────────────────────┘
     * ============================================================== */

    /**
     * Simple validation helpers.
     */
    static final class ValidationUtils {

        private static final String EMAIL_REGEX =
                "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$";

        private ValidationUtils() {
            /* static helper – no-op */
        }

        static boolean isValidEmail(String email) {
            if (email == null) {
                return false;
            }
            return email.toUpperCase().matches(EMAIL_REGEX);
        }

        static String requireNonBlank(String value, String paramName) {
            if (value == null || value.trim().isEmpty()) {
                throw new IllegalArgumentException(
                        "Parameter '" + paramName + "' must not be blank");
            }
            return value;
        }
    }

    /**
     * Converts bytes to human-readable strings.
     */
    static final class FileSizeFormatter {

        private static final String[] SI_UNITS = { "B", "kB", "MB", "GB", "TB", "PB" };
        private static final String[] BINARY_UNITS = { "B", "KiB", "MiB", "GiB", "TiB", "PiB" };

        private FileSizeFormatter() { }

        static String humanReadableByteCount(long bytes, boolean si) {
            final int unit = si ? 1000 : 1024;
            if (bytes < unit) return bytes + " B";

            int exp = (int) (Math.log(bytes) / Math.log(unit));
            String prefix = (si ? SI_UNITS : BINARY_UNITS)[exp];
            double value = bytes / Math.pow(unit, exp);
            return String.format("%.2f %s", value, prefix);
        }
    }

    /**
     * Thin Jackson wrapper used across the platform for event payloads.
     */
    static final class EventPayloadSerializer {

        private static final ObjectMapper MAPPER = new ObjectMapper();

        private EventPayloadSerializer() { }

        static <T> String serialize(T obj) {
            try {
                return MAPPER.writeValueAsString(obj);
            } catch (JsonProcessingException e) {
                throw new UncheckedIOException("Unable to serialize object", e);
            }
        }

        static <T> T deserialize(String json, Class<T> type) {
            try {
                return MAPPER.readValue(json, type);
            } catch (JsonProcessingException e) {
                throw new UncheckedIOException("Unable to deserialize payload", e);
            }
        }
    }

    /**
     * A micro-implementation of a retry helper with exponential back-off.
     */
    static final class RetryExecutor {

        private RetryExecutor() { }

        static <T> T execute(int maxAttempts, Duration initialDelay, Callable<T> task) {
            Objects.requireNonNull(task, "task");
            Objects.requireNonNull(initialDelay, "initialDelay");
            IllegalStateException failure = null;

            Duration delay = initialDelay;
            for (int attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    return task.call();
                } catch (Exception ex) {
                    if (ex instanceof IllegalStateException ise) {
                        failure = ise;
                    } else {
                        throw new RuntimeException(ex);
                    }
                    if (attempt < maxAttempts) {
                        sleep(delay);
                        delay = delay.multipliedBy(2); // poor-man’s exponential back-off
                    }
                }
            }
            throw failure; // exhaust retries
        }

        private static void sleep(Duration d) {
            try {
                Thread.sleep(d.toMillis());
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                throw new RuntimeException("Retry interrupted", ie);
            }
        }
    }

    /**
     * Sample event DTO used only for test purposes.
     */
    static final class ExampleEvent {

        private String pulseId;
        private String username;
        private int pointsAwarded;

        // Jackson requires a no-arg ctor
        @SuppressWarnings("unused")
        private ExampleEvent() { }

        ExampleEvent(String pulseId, String username, int pointsAwarded) {
            this.pulseId = pulseId;
            this.username = username;
            this.pointsAwarded = pointsAwarded;
        }

        public String getPulseId()     { return pulseId; }
        public String getUsername()    { return username; }
        public int    getPointsAwarded() { return pointsAwarded; }

        /* ----- equals / hashCode / toString ----- */
        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (!(o instanceof ExampleEvent that)) return false;
            return pointsAwarded == that.pointsAwarded
                    && Objects.equals(pulseId, that.pulseId)
                    && Objects.equals(username, that.username);
        }

        @Override
        public int hashCode() {
            return Objects.hash(pulseId, username, pointsAwarded);
        }

        @Override
        public String toString() {
            return "ExampleEvent{" +
                    "pulseId='" + pulseId + '\'' +
                    ", username='" + username + '\'' +
                    ", pointsAwarded=" + pointsAwarded +
                    '}';
        }
    }
}
```