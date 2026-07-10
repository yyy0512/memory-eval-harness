```java
package com.circleconnect.nexus.web.middleware;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.util.unit.DataSize;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * AdaptiveRateLimiterFilter is an {@link OncePerRequestFilter} that throttles inbound HTTP requests
 * using a token-bucket strategy. The filter is *adaptive* because it applies different
 * policies based on authentication state, request path pattern, and last observed user behaviour.
 *
 * <p> The implementation is intentionally self-contained (i.e., no external Redis dependency),
 * yet pluggable via the {@link RateLimiterService} interface which can be swapped out
 * for a distributed implementation in production. </p>
 *
 * <p>Typical usage (auto-registered by component scanning):</p>
 * <pre>
 *  ⏱  Unauthenticated: 15 requests / 60s
 *  🔐  Authenticated  : 120 requests / 60s
 *  📡  Web-Socket      : exempt
 * </pre>
 *
 * Exceeded limits yield HTTP 429 with a JSON error payload.
 *
 * @author  CircleConnect Nexus
 */
@Component
public class AdaptiveRateLimiterFilter extends OncePerRequestFilter implements InitializingBean {

    private static final String ATTR_RATE_LIMIT_HIT = "ccn.rate.limit.hit";
    private final RateLimiterService limiterService;
    private final ObjectMapper objectMapper;
    private final MeterRegistry meterRegistry;

    private Counter rejectedCounter;
    private Counter allowedCounter;

    @Value("${circleconnect.rate-limit.unauth.requests:15}")
    private int unauthRequestsPerWindow;

    @Value("${circleconnect.rate-limit.auth.requests:120}")
    private int authRequestsPerWindow;

    @Value("${circleconnect.rate-limit.window.seconds:60}")
    private int windowSeconds;

    @Autowired
    public AdaptiveRateLimiterFilter(RateLimiterService limiterService,
                                     ObjectMapper objectMapper,
                                     MeterRegistry meterRegistry) {
        this.limiterService = Objects.requireNonNull(limiterService);
        this.objectMapper = Objects.requireNonNull(objectMapper);
        this.meterRegistry = Objects.requireNonNull(meterRegistry);
    }

    @Override
    public void afterPropertiesSet() {
        this.rejectedCounter = meterRegistry.counter("ccn_rate_limit_rejected_total");
        this.allowedCounter = meterRegistry.counter("ccn_rate_limit_allowed_total");
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        // Upgrade requests to WebSocket or server-sent events are exempt
        return "websocket".equalsIgnoreCase(request.getHeader("Upgrade"));
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain filterChain)
            throws ServletException, IOException {

        final String identifier = resolveBucketKey(request);
        final boolean authenticated = request.getUserPrincipal() != null;

        RateLimitPolicy policy = new RateLimitPolicy(
                authenticated ? authRequestsPerWindow : unauthRequestsPerWindow,
                Duration.ofSeconds(windowSeconds)
        );

        if (limiterService.tryConsume(identifier, policy)) {
            allowedCounter.increment();
            request.setAttribute(ATTR_RATE_LIMIT_HIT, Boolean.TRUE);
            filterChain.doFilter(request, response);
            return;
        }

        // blocked
        rejectedCounter.increment();
        writeTooManyRequests(response, policy);
    }

    private String resolveBucketKey(HttpServletRequest request) {
        // Prefer user principal if authenticated, otherwise remote IP
        if (request.getUserPrincipal() != null) {
            return "u:" + request.getUserPrincipal().getName();
        }
        String ip = Optional.ofNullable(request.getHeader("X-Forwarded-For"))
                            .map(h -> h.split(",")[0])
                            .orElseGet(request::getRemoteAddr);
        return "ip:" + ip;
    }

    private void writeTooManyRequests(HttpServletResponse response, RateLimitPolicy policy)
            throws IOException {

        response.setStatus(HttpServletResponse.SC_TOO_MANY_REQUESTS);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Retry-After", String.valueOf(policy.window().getSeconds()));

        Map<String, Object> body = Map.of(
                "status", 429,
                "error", "Too Many Requests",
                "detail", "API rate limit exceeded. Try again later."
        );
        objectMapper.writeValue(response.getWriter(), body);
    }

    /* --------------------------------------------------------------------- */
    /* ---------------  Internal & default service implementation ---------- */
    /* --------------------------------------------------------------------- */

    /**
     * Service interface that abstracts rate-limit persistence.
     */
    public interface RateLimiterService {
        /**
         * Attempts to consume one token from the bucket identified by key.
         *
         * @param key    subject key (user id, IP, etc.)
         * @param policy window + quota definition
         * @return {@code true} if request is allowed, {@code false} otherwise
         */
        boolean tryConsume(String key, RateLimitPolicy policy);
    }

    /**
     * Default in-memory, thread-safe implementation used when no alternative bean is provided.
     * <p>
     * Notes:
     *  • Memory footprint is bounded by eviction (time-window) logic.<br>
     *  • Suitable for single-instance deployments and local testing only.
     * </p>
     */
    @Component
    public static class InMemoryRateLimiterService implements RateLimiterService {

        /**
         * Bucket holds remaining tokens and next reset time (epoch ms).
         */
        private static final class Bucket {
            private final AtomicLong tokens;
            private volatile long resetAtMillis;

            private Bucket(long initial, long resetAtMillis) {
                this.tokens = new AtomicLong(initial);
                this.resetAtMillis = resetAtMillis;
            }
        }

        private final ConcurrentHashMap<String, Bucket> buckets = new ConcurrentHashMap<>();

        @Override
        public boolean tryConsume(String key, RateLimitPolicy policy) {
            long now = System.currentTimeMillis();
            Bucket bucket = buckets.compute(key, (k, old) -> {
                if (old == null || now >= old.resetAtMillis) {
                    // start new window
                    return new Bucket(policy.limit(), now + policy.window().toMillis());
                }
                return old;
            });

            // Attempt to decrement
            long remaining = bucket.tokens.updateAndGet(curr -> curr > 0 ? curr - 1 : curr);
            return remaining >= 0;
        }

        /**
         * Periodically cleans up stale buckets to mitigate memory growth.
         */
        @Scheduled(fixedDelayString = "${circleconnect.rate-limit.gc.interval:60000}")
        public void evictStaleBuckets() {
            long now = System.currentTimeMillis();
            buckets.entrySet().removeIf(e -> now >= e.getValue().resetAtMillis);
        }
    }

    /**
     * Immutable policy definition.
     *
     * @param limit  number of tokens per window
     * @param window window duration
     */
    public record RateLimitPolicy(long limit, Duration window) {

        public RateLimitPolicy {
            if (limit < 1) {
                throw new IllegalArgumentException("limit must be ≥ 1");
            }
            if (window == null || window.isNegative() || window.isZero()) {
                throw new IllegalArgumentException("window must be > 0");
            }
        }
    }
}
```