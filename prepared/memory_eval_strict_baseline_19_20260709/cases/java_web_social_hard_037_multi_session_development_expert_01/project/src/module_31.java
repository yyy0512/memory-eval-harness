```java
package com.circleconnect.nexus.middleware.ratelimit;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

import java.io.IOException;
import java.lang.annotation.*;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Adaptive, in-memory rate-limiting middleware.
 * <p>
 *     – Leverages a token-bucket implementation per user/ip.<br>
 *     – Fully thread-safe; O(1) operations per request.<br>
 *     – Can be toggled on a controller/endpoint via {@link RateLimited}.<br>
 * </p>
 *
 * NOTE: For production clusters, swap the local map with a distributed cache
 * (Redis, Hazelcast, etc.) so that limits are shared across instances.
 */
@Component
public final class RateLimitingInterceptor implements HandlerInterceptor {

    private static final String RATE_LIMIT_REMAINING = "X-RateLimit-Remaining";
    private static final String RATE_LIMIT_RETRY_AFTER = "Retry-After";

    /*
     * In-memory registry of active token buckets.
     * Key format: <type>::<value>  ->  e.g.  user::42, ip::192.168.0.10
     */
    private final Map<String, TokenBucket> registry = new ConcurrentHashMap<>();

    @Override
    public boolean preHandle(
            @NonNull HttpServletRequest request,
            @NonNull HttpServletResponse response,
            @NonNull Object handler) throws Exception {

        // Skip static resources & OPTIONS preflights
        if (!(handler instanceof HandlerMethod hm) ||
            "OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        // Try to find a @RateLimited annotation (method > controller > default)
        RateLimited metadata = resolveRateLimitedMetadata(hm);
        if (metadata == null) {
            return true; // Endpoint is not rate-limited
        }

        // Choose a key (user takes precedence, then IP)
        String bucketKey = computeBucketKey(request, metadata);
        if (bucketKey == null) {
            return true; // No key available → skip rate limiting
        }

        TokenBucket bucket = registry.computeIfAbsent(
                bucketKey,
                k -> TokenBucket.newBuilder()
                                .capacity(metadata.requests())
                                .refillTokens(metadata.requests())
                                .refillPeriodSeconds(metadata.durationSeconds())
                                .build());

        if (bucket.tryConsume()) {
            // Allowed → expose remaining quota
            response.setHeader(RATE_LIMIT_REMAINING, String.valueOf(bucket.getRemainingTokens()));
            return true;
        }

        // Rejected → respond 429 + Retry-After
        long retryAfterSec = bucket.getSecondsUntilRefill();
        renderTooManyRequests(response, retryAfterSec);
        return false;
    }

    /* --------------------------------------------------- PRIVATE HELPERS ---- */

    private static RateLimited resolveRateLimitedMetadata(HandlerMethod hm) {
        // Combines method + controller lookup
        return AnnotatedElementUtils.findMergedAnnotation(hm.getMethod(), RateLimited.class) != null
                ? AnnotatedElementUtils.findMergedAnnotation(hm.getMethod(), RateLimited.class)
                : AnnotatedElementUtils.findMergedAnnotation(hm.getBeanType(), RateLimited.class);
    }

    /**
     * Returns a unique key respecting the {@link RateLimited#perUser()} flag.
     * Falls back to client IP when user info is not available.
     */
    private static String computeBucketKey(HttpServletRequest req, RateLimited metadata) {
        if (metadata.perUser()) {
            String userId = currentUserId();
            if (userId != null) {
                return "user::" + userId;
            }
        }
        String ip = clientIp(req);
        return ip != null ? "ip::" + ip : null;
    }

    private static void renderTooManyRequests(HttpServletResponse resp, long retryAfterSeconds)
            throws IOException {
        resp.setHeader(RATE_LIMIT_RETRY_AFTER, String.valueOf(retryAfterSeconds));
        resp.sendError(HttpStatus.TOO_MANY_REQUESTS.value(),
                       "Rate limit exceeded. Try again in " + retryAfterSeconds + " seconds.");
    }

    private static String currentUserId() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated()) return null;
        Object principal = auth.getPrincipal();
        /*
         *  The exact user id extraction depends on the security setup.
         *  If principal is a custom UserDetails, adapt accordingly.
         */
        if (principal instanceof org.springframework.security.core.userdetails.UserDetails ud) {
            return ud.getUsername();
        }
        return principal.toString();
    }

    private static String clientIp(HttpServletRequest req) {
        // Respect X-Forwarded-For (assuming proxy trust is handled elsewhere)
        String forwarded = Optional.ofNullable(req.getHeader("X-Forwarded-For"))
                                   .map(h -> h.split(",")[0].trim())
                                   .orElse(null);
        return forwarded != null ? forwarded : req.getRemoteAddr();
    }

    /* ===================================================== ANNOTATION ====== */

    /**
     * Annotation to enable rate-limiting on controller classes or specific endpoints.
     *
     * Example:
     * <pre>
     * &#64;RateLimited(requests = 10, durationSeconds = 60) // 10 requests / minute
     * &#64;GetMapping("/api/feed")
     * public Page&lt;PostDto&gt; feed() { ... }
     * </pre>
     */
    @Documented
    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.METHOD, ElementType.TYPE})
    public @interface RateLimited {

        /**
         * Number of allowed requests in the given time window.
         */
        int requests() default 60;

        /**
         * Window length (seconds) for the {@link #requests()} quota.
         */
        int durationSeconds() default 60;

        /**
         * If true, rate limit is applied per authenticated user;
         * otherwise, it falls back to client IP.
         */
        boolean perUser() default true;
    }

    /* ================================================== TOKEN BUCKET ======= */

    /**
     * Lightweight, thread-safe token-bucket implementation.
     */
    private static final class TokenBucket {

        private final int capacity;
        private final int refillTokens;
        private final long refillPeriodMillis;

        private int tokens;
        private long lastRefillTs; // epoch millis

        /* ------------------------------ Builder */

        static Builder newBuilder() { return new Builder(); }

        static final class Builder {
            private Integer capacity;
            private Integer refillTokens;
            private Integer refillPeriodSeconds;

            Builder capacity(int capacity) {
                this.capacity = capacity;
                return this;
            }

            Builder refillTokens(int tokens) {
                this.refillTokens = tokens;
                return this;
            }

            Builder refillPeriodSeconds(int seconds) {
                this.refillPeriodSeconds = seconds;
                return this;
            }

            TokenBucket build() {
                Objects.requireNonNull(capacity, "capacity");
                Objects.requireNonNull(refillTokens, "refillTokens");
                Objects.requireNonNull(refillPeriodSeconds, "refillPeriodSeconds");
                return new TokenBucket(capacity, refillTokens, refillPeriodSeconds);
            }
        }

        /* ------------------------------ Impl */

        private TokenBucket(int capacity, int refillTokens, int refillPeriodSeconds) {
            this.capacity = capacity;
            this.refillTokens = refillTokens;
            this.refillPeriodMillis = Duration.ofSeconds(refillPeriodSeconds).toMillis();
            this.tokens = capacity;
            this.lastRefillTs = System.currentTimeMillis();
        }

        /**
         * Attempts to consume a single token.
         *
         * @return {@code true} iff a token was successfully consumed.
         */
        synchronized boolean tryConsume() {
            refillIfNecessary();
            if (tokens > 0) {
                tokens--;
                return true;
            }
            return false;
        }

        synchronized int getRemainingTokens() {
            refillIfNecessary();
            return tokens;
        }

        synchronized long getSecondsUntilRefill() {
            long now = System.currentTimeMillis();
            long millisToNext = (lastRefillTs + refillPeriodMillis) - now;
            return Math.max(1, millisToNext / 1000);
        }

        /* ------------------------------ Internal */

        private void refillIfNecessary() {
            long now = System.currentTimeMillis();
            if (now - lastRefillTs >= refillPeriodMillis) {
                tokens = Math.min(capacity, tokens + refillTokens);
                lastRefillTs = now;
            }
        }
    }
}
```