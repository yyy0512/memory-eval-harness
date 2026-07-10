package com.vitalpulse.cloudcare.tests;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for miscellaneous utility helpers that back the VitalPulse CloudCare API.
 * <p>
 * Because utilities are pure functions and do not require heavyweight AWS resources,
 * testing is executed entirely in-memory with deterministic time providers.
 */
class UtilsTest {

    /* ========== RateLimiter ============================================================= */

    @Nested
    @DisplayName("Token-bucket rate-limiter")
    class RateLimiterSpec {

        @Test
        @DisplayName("should throttle when bucket is empty and refill thereafter")
        void shouldThrottleAndRefill() {
            AtomicLong nanoNow = new AtomicLong();                 //   0 ns
            RateLimiter limiter = new RateLimiter(
                    5,                       // capacity
                    5d,                      // refill-rate (tokens / sec)
                    nanoNow::get);           // time-supplier

            // drain entire bucket
            assertTrue(limiter.tryAcquire(5));                     // success
            assertFalse(limiter.tryAcquire(1));                    // bucket empty

            // fast-forward 400ms  -> 2 tokens (approx)
            nanoNow.addAndGet(400_000_000L);
            assertTrue(limiter.tryAcquire(2));                     // enough tokens
            assertFalse(limiter.tryAcquire(4));                    // not enough

            // fast-forward 1s     -> +5 tokens (capped at capacity)
            nanoNow.addAndGet(1_000_000_000L);
            assertTrue(limiter.tryAcquire(5));                     // bucket full again
        }

        @ParameterizedTest
        @CsvSource({
                "1,10,1,true",
                "5,10,6,false",
                "2,4,3,false",
                "3,3,3,true"
        })
        @DisplayName("should evaluate token availability deterministically")
        void deterministicTokenEvaluation(long capacity,
                                          double refillPerSec,
                                          int requested,
                                          boolean expected) {
            AtomicLong nanoNow = new AtomicLong();
            RateLimiter limiter = new RateLimiter(capacity, refillPerSec, nanoNow::get);
            assertEquals(expected, limiter.tryAcquire(requested));
        }
    }

    /* ========== Pagination cursor helpers ============================================== */

    @Nested
    @DisplayName("Cursor-based pagination")
    class CursorSpec {

        @Test
        @DisplayName("encode → decode round-trip must be lossless")
        void roundTrip() {
            String pid = "patient-12345";
            Instant ts = Instant.now();

            String cursor = CursorUtil.encode(pid, ts);
            CursorUtil.DecodedCursor decoded = CursorUtil.decode(cursor);

            assertAll(
                    () -> assertEquals(pid, decoded.patientId()),
                    () -> assertEquals(ts.getEpochSecond(), decoded.timestamp().getEpochSecond())
            );
        }

        @Test
        @DisplayName("decode should fail fast on malformed cursor")
        void shouldRejectMalformedCursor() {
            String garbage = "not-base64";
            assertThrows(IllegalArgumentException.class, () -> CursorUtil.decode(garbage));
        }
    }

    /* ========== Secure request ID generator ============================================ */

    @Nested
    @DisplayName("Request-ID generator")
    class RequestIdGeneratorSpec {

        @Test
        @DisplayName("must produce collision-free, constant-length identifiers")
        void uniqueness() {
            Set<String> ids = new HashSet<>();
            for (int i = 0; i < 1_000; i++) {
                ids.add(RequestIdGenerator.newId());
            }
            assertEquals(1_000, ids.size(), "IDs must be unique");
            assertTrue(ids.stream().allMatch(id -> id.length() == RequestIdGenerator.ID_LENGTH));
        }
    }
}

/* =======================================================================================
 * Below are *production-like* utility helpers that would normally reside in
 * src/main/java. They are co-located here purely to keep the example self-contained.
 * =====================================================================================*/

/**
 * Simple token-bucket rate-limiter with pluggable time source for deterministic testing.
 */
final class RateLimiter {

    /** Functional interface to abstract time retrieval (monotonic nanoTime). */
    @FunctionalInterface
    interface NanoTimeProvider {
        long nanoTime();
    }

    private final long capacity;
    private final double refillRatePerSecond;
    private double availableTokens;
    private long lastRefillNanos;
    private final NanoTimeProvider timeProvider;

    RateLimiter(long capacity, double refillRatePerSecond, NanoTimeProvider timeProvider) {
        if (capacity <= 0 || refillRatePerSecond <= 0.0) {
            throw new IllegalArgumentException("Capacity and refill rate must be positive");
        }
        this.capacity = capacity;
        this.refillRatePerSecond = refillRatePerSecond;
        this.availableTokens = capacity;
        this.timeProvider = timeProvider;
        this.lastRefillNanos = timeProvider.nanoTime();
    }

    /**
     * Attempts to consume {@code tokens}. Returns {@code true} if enough tokens were available,
     * otherwise returns {@code false} and leaves the bucket unchanged.
     */
    synchronized boolean tryAcquire(int tokens) {
        if (tokens <= 0) {
            throw new IllegalArgumentException("Requested tokens must be positive");
        }
        refill();
        if (availableTokens >= tokens) {
            availableTokens -= tokens;
            return true;
        }
        return false;
    }

    /* Refill bucket based on elapsed time since last check. */
    private void refill() {
        long now = timeProvider.nanoTime();
        long elapsedNanos = now - lastRefillNanos;
        if (elapsedNanos <= 0) return;

        double tokensToAdd = (elapsedNanos / 1_000_000_000d) * refillRatePerSecond;
        if (tokensToAdd > 0.0) {
            availableTokens = Math.min(capacity, availableTokens + tokensToAdd);
            lastRefillNanos = now;
        }
    }
}

/**
 * Helper for cursor-based pagination. The encoding format is 
 * Base64( UTF-8( patientId | ":" | epochSecond ) ).
 */
final class CursorUtil {

    private static final String DELIMITER = ":";

    static String encode(String patientId, Instant timestamp) {
        if (patientId == null || timestamp == null) {
            throw new IllegalArgumentException("Arguments must not be null");
        }
        String raw = patientId + DELIMITER + timestamp.getEpochSecond();
        return Base64.getUrlEncoder().withoutPadding()
                     .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    static DecodedCursor decode(String encoded) {
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(encoded);
            String raw = new String(bytes, StandardCharsets.UTF_8);
            String[] parts = raw.split(DELIMITER);
            if (parts.length != 2) throw new IllegalArgumentException("Malformed cursor");

            String patientId = parts[0];
            long epoch = Long.parseLong(parts[1]);
            return new DecodedCursor(patientId, Instant.ofEpochSecond(epoch));
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid cursor: " + encoded, e);
        }
    }

    record DecodedCursor(String patientId, Instant timestamp) {}
}

/**
 * Generates cryptographically secure, URL-safe request identifiers to comply with
 * logging and audit-trail requirements (e.g., HIPAA request correlation).
 */
final class RequestIdGenerator {

    static final int ID_LENGTH = 24; // chars
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();
    private static final char[] ALPHANUM =
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".toCharArray();

    private RequestIdGenerator() {}

    static String newId() {
        char[] buf = new char[ID_LENGTH];
        for (int i = 0; i < ID_LENGTH; i++) {
            buf[i] = ALPHANUM[SECURE_RANDOM.nextInt(ALPHANUM.length)];
        }
        return new String(buf);
    }
}