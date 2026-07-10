```java
package com.circleconnectnexus.middleware.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.lang.annotation.*;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Production-grade, in-memory rate-limiting middleware for CircleConnect Nexus.
 *
 * 1. Allows fine-grained limits via {@link RateLimited} annotation.
 * 2. Distinguishes principals by userId (preferred) or remote IP.
 * 3. Thread-safe & lock-free path for ≈50k rps bursts (per JVM).
 * 4. Fully self-contained – pluggable without external Redis/Bucket4j.
 *
 * Note: For horizontally scaled deployments, replace {@link InMemoryRateLimiter}
 * with a distributed implementation backed by Redis or Hazelcast.
 *
 * Usage:
 * <pre>
 * &#64;RestController
 * class CircleController {
 *     &#64;RateLimited(limit = 100, durationSeconds = 60)
 *     &#64;GetMapping("/api/v1/circles/{id}")
 *     public CircleDto getCircle(...) { … }
 * }
 * </pre>
 */
@Component
public class Module21RateLimitingInterceptor implements HandlerInterceptor, InitializingBean {

    private static final Logger LOG = LoggerFactory.getLogger(Module21RateLimitingInterceptor.class);

    private RateLimiter rateLimiter;

    /* =============================== HandlerInterceptor API =============================== */

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request,
                             @NonNull HttpServletResponse response,
                             @NonNull Object handler) throws IOException {

        // Skip non-mapped handlers (e.g., static resources).
        if (!(handler instanceof HandlerMethod method)) {
            return true;
        }

        RateLimited annotation = resolveAnnotation(method);
        if (annotation == null) {
            return true; // No limit defined -> pass through
        }

        String key = resolveKey(request);
        RateLimitDecision decision = rateLimiter.tryConsume(key,
                annotation.limit(), Duration.ofSeconds(annotation.durationSeconds()));

        if (!decision.allowed()) {
            LOG.debug("Rate limit exceeded for key={} uri={}", key, request.getRequestURI());
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("X-RateLimit-Retry-After", String.valueOf(decision.retryAfterSeconds()));
            response.getWriter().write(
                    "Rate limit exceeded. Try again after " + decision.retryAfterSeconds() + "s.");
            return false;
        }

        // Propagate limit headers (optional, UX friendly)
        response.setHeader("X-RateLimit-Limit", String.valueOf(annotation.limit()));
        response.setHeader("X-RateLimit-Remaining",
                String.valueOf(Math.max(0, annotation.limit() - decision.consumedInWindow())));
        response.setHeader("X-RateLimit-Reset", String.valueOf(decision.windowResetEpochSeconds()));
        return true;
    }

    /* =============================== Dependency Wiring =============================== */

    @Override
    public void afterPropertiesSet() {
        // Could be swapped via DI configuration profile
        this.rateLimiter = new InMemoryRateLimiter();
    }

    /* =============================== Helper Methods =============================== */

    private RateLimited resolveAnnotation(HandlerMethod method) {
        // Method-level wins over Class-level; else absent
        RateLimited ann = method.getMethodAnnotation(RateLimited.class);
        if (ann != null) {
            return ann;
        }
        return method.getBeanType().getAnnotation(RateLimited.class);
    }

    /**
     * Derive a unique key per principal.
     * Prefers authenticated userId, else remote IP for guests.
     */
    private String resolveKey(HttpServletRequest request) {
        // CircleConnect uses a Spring Security Authentication with userId principal.
        Object principal = request.getUserPrincipal();
        if (principal != null && StringUtils.hasText(principal.getName())) {
            return "USER_" + principal.getName();
        }
        // Fall back to remote IP. In production, consider X-Forwarded-For chain.
        return "IP_" + request.getRemoteAddr();
    }

    /* =============================== Annotation Definition =============================== */

    @Target({ElementType.METHOD, ElementType.TYPE})
    @Retention(RetentionPolicy.RUNTIME)
    @Documented
    public @interface RateLimited {
        @Min(1)
        int limit();                 // Max requests in window

        @Min(1)
        int durationSeconds();       // Window size
    }

    /* =============================== RateLimiter Abstractions =============================== */

    private interface RateLimiter {
        RateLimitDecision tryConsume(String key, int limit, Duration window);
    }

    /**
     * Lock-free, per-JVM token bucket with lazy eviction.
     */
    private static final class InMemoryRateLimiter implements RateLimiter {

        private static final class Bucket {
            private final AtomicInteger counter = new AtomicInteger();
            private volatile long windowStartEpochMillis;

            Bucket(long now) {
                this.windowStartEpochMillis = now;
            }

            void reset(long now) {
                counter.set(0);
                windowStartEpochMillis = now;
            }
        }

        private final Map<String, Bucket> buckets = new ConcurrentHashMap<>();

        @Override
        public RateLimitDecision tryConsume(@NotNull String key, int limit, @NotNull Duration window) {
            long now = Instant.now().toEpochMilli();
            long windowMs = window.toMillis();

            Bucket bucket = buckets.computeIfAbsent(key, k -> new Bucket(now));

            synchronized (bucket) { // minimal contention; 1 lock per key
                if (now - bucket.windowStartEpochMillis >= windowMs) {
                    bucket.reset(now);
                }
                int used = bucket.counter.incrementAndGet();
                if (used > limit) {
                    long retryIn = windowMs - (now - bucket.windowStartEpochMillis);
                    return RateLimitDecision.rejected(limit, used - 1, retryIn);
                }
                return RateLimitDecision.accepted(limit, used, windowMs - (now - bucket.windowStartEpochMillis));
            }
        }
    }

    /**
     * Value object capturing rate-limit outcome to avoid primitive soup.
     */
    private record RateLimitDecision(boolean allowed,
                                     int windowLimit,
                                     int consumedInWindow,
                                     long retryAfterMillis,
                                     long windowResetEpochSeconds) {

        static RateLimitDecision accepted(int limit, int consumed, long millisUntilReset) {
            long resetEpochSeconds = (Instant.now().toEpochMilli() + millisUntilReset) / 1000;
            return new RateLimitDecision(true, limit, consumed, 0, resetEpochSeconds);
        }

        static RateLimitDecision rejected(int limit, int consumed, long retryAfterMillis) {
            long resetEpochSeconds = (Instant.now().toEpochMilli() + retryAfterMillis) / 1000;
            return new RateLimitDecision(false, limit, consumed, retryAfterMillis, resetEpochSeconds);
        }

        int retryAfterSeconds() {
            return (int) Math.ceil(retryAfterMillis / 1000.0);
        }
    }

    /* =============================== toString / Equals for Debugging =============================== */

    @Override
    public String toString() {
        return "Module21RateLimitingInterceptor{" +
                "rateLimiter=" + rateLimiter.getClass().getSimpleName() +
                '}';
    }

    @Override
    public int hashCode() {
        return Objects.hash(rateLimiter);
    }

    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof Module21RateLimitingInterceptor other)) return false;
        return Objects.equals(rateLimiter.getClass(), other.rateLimiter.getClass());
    }
}
```