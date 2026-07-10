package com.circleconnect.nexus.middleware;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * module_2
 *
 * <p>Production-grade request–rate-limiting interceptor for the CircleConnect Nexus REST layer.
 * Applies per-principal or per-IP throttling and decorates the HTTP response with the standard
 * {@code X-RateLimit-*} headers. Utilises an in-memory, lock-free counter registry that is
 * inexpensive for low to moderate traffic and can be swapped for Redis/Hazelcast by
 * implementing {@link RateLimitCounterRepository}.</p>
 *
 * <p>Place this interceptor high in the Spring MVC chain to ensure all downstream handlers enjoy
 * the back-pressure guarantees.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 5)
public class module_2 implements HandlerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(module_2.class);

    private final int limit;
    private final Duration window;
    private final RateLimitCounterRepository counters;

    /**
     * Constructs a new interceptor.
     *
     * @param limitPerMinute maximum allowed requests within the rolling window
     * @param secondsWindow  size of the rolling window in seconds
     */
    public module_2(
            @Value("${circle.nexus.ratelimit.limit:100}") int limitPerMinute,
            @Value("${circle.nexus.ratelimit.window.seconds:60}") long secondsWindow) {
        this.limit = limitPerMinute;
        this.window = Duration.ofSeconds(secondsWindow);
        this.counters = new InMemoryRateLimitCounterRepository(window);
        LOG.info("Rate-limiting enabled: {} requests / {}s", limit, window.getSeconds());
    }

    /**
     * Checks whether the caller has remaining quota before the request is dispatched to the
     * controller. If the quota is depleted, a 429 response is generated and the request processing
     * is short-circuited.
     */
    @Override
    public boolean preHandle(HttpServletRequest request,
                             HttpServletResponse response,
                             Object handler) throws IOException {

        String key = resolveRateLimitKey(request);
        RateLimitSnapshot snapshot = counters.hit(key, limit);

        decorateResponseHeaders(response, snapshot);

        if (snapshot.isRejected()) {
            LOG.warn("Rate limit exceeded for key={} (limit={} window={}s)",
                     key, limit, window.getSeconds());
            respondTooManyRequests(response, snapshot);
            return false;
        }

        return true;
    }

    /* -------------------------------------------------------------------- *
     *  Internal helpers                                                     *
     * -------------------------------------------------------------------- */

    private String resolveRateLimitKey(HttpServletRequest request) {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (Objects.nonNull(auth)
                && auth.isAuthenticated()
                && !(auth instanceof AnonymousAuthenticationToken)) {
            // Authenticated principal – bucket per user
            return "USER_" + auth.getName();
        }
        // Fallback to remote IP – covers anonymous traffic
        return "IP_" + request.getRemoteAddr();
    }

    private void decorateResponseHeaders(HttpServletResponse response, RateLimitSnapshot snapshot) {
        response.setHeader("X-RateLimit-Limit", Integer.toString(limit));
        response.setHeader("X-RateLimit-Remaining", Integer.toString(snapshot.getRemaining()));
        response.setHeader("X-RateLimit-Reset", Long.toString(snapshot.getResetEpochSeconds()));
    }

    private void respondTooManyRequests(HttpServletResponse response, RateLimitSnapshot snapshot)
            throws IOException {

        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setHeader(HttpHeaders.CONTENT_TYPE, MediaType.APPLICATION_JSON_VALUE);
        response.getWriter()
                .append("{")
                .append("\"error\":\"rate_limit_exceeded\",")
                .append("\"limit\":").append(Integer.toString(limit)).append(',')
                .append("\"remaining\":0,")
                .append("\"reset\":").append(Long.toString(snapshot.getResetEpochSeconds()))
                .append('}');
        response.flushBuffer();
    }

    /* -------------------------------------------------------------------- *
     *  Support types                                                        *
     * -------------------------------------------------------------------- */

    /**
     * Immutable tuple returning the outcome of a hit attempt.
     */
    private record RateLimitSnapshot(int remaining, long resetEpochSeconds, boolean rejected) {
        boolean isRejected() { return rejected; }
        int getRemaining() { return remaining; }
        long getResetEpochSeconds() { return resetEpochSeconds; }
    }

    /**
     * Repository abstraction – allows easy replacement with a distributed
     * implementation (Redis, Hazelcast, etc.) without touching the interceptor
     * logic or its tests.
     */
    interface RateLimitCounterRepository {

        /**
         * Register a new request from {@code key}. The implementation must be
         * thread-safe. The call should be cheap (O(1)) to ensure interception
         * latency is negligible.
         *
         * @param key        identifying principal or IP bucket
         * @param hardLimit  max requests allowed during the window
         * @return snapshot with the post-hit state
         */
        RateLimitSnapshot hit(String key, int hardLimit);
    }

    /**
     * Simple lock-free, in-memory implementation using {@link ConcurrentHashMap}.
     */
    static final class InMemoryRateLimitCounterRepository implements RateLimitCounterRepository {

        private static final class Counter {
            private final AtomicInteger hits = new AtomicInteger();
            private volatile Instant windowStart = Instant.now();
        }

        private final Duration window;
        private final Map<String, Counter> buckets = new ConcurrentHashMap<>();

        InMemoryRateLimitCounterRepository(Duration window) {
            this.window = window;
        }

        @Override
        public RateLimitSnapshot hit(String key, int hardLimit) {
            Counter counter = buckets.computeIfAbsent(key, k -> new Counter());
            synchronized (counter) { // synchronised per bucket – avoids heavy contention
                Instant now = Instant.now();
                if (Duration.between(counter.windowStart, now).compareTo(window) > 0) {
                    // Start a fresh window
                    counter.hits.set(0);
                    counter.windowStart = now;
                }

                int current = counter.hits.incrementAndGet();
                boolean rejected = current > hardLimit;
                int remaining = Math.max(hardLimit - current, 0);
                long reset = counter.windowStart.plus(window).getEpochSecond();
                return new RateLimitSnapshot(remaining, reset, rejected);
            }
        }
    }
}