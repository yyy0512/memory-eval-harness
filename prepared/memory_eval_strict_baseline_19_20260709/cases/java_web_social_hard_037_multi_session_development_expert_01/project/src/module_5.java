package com.circleconnect.nexus.middleware;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.util.StringUtils;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.ModelAndView;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Central rate-limiting configuration and supporting classes.
 *
 * <p>This module wires a token-bucket rate limiter into the Spring MVC
 * interceptor chain. Limits are configured via application properties
 * under the {@code circleconnect.rate-limiter.*} namespace.</p>
 *
 * <pre>
 * circleconnect:
 *   rate-limiter:
 *     enabled: true
 *     capacity: 120
 *     refillTokens: 60
 *     refillDuration: 1m
 * </pre>
 *
 * <p>Bucket keys default to authenticated user id; if the user is
 * unauthenticated, the client IP address is used instead.</p>
 */
@Configuration
@EnableScheduling
@EnableConfigurationProperties(module_5.RateLimiterProperties.class)
public class module_5 implements WebMvcConfigurer { // file-name-aligned public class

    private static final Logger LOG = LoggerFactory.getLogger(module_5.class);

    private final RateLimiterInterceptor interceptor;

    @Autowired
    public module_5(RateLimiterInterceptor interceptor) {
        this.interceptor = interceptor;
    }

    @Override
    public void addInterceptors(@NonNull InterceptorRegistry registry) {
        registry.addInterceptor(interceptor)
                .addPathPatterns("/api/**"); // Apply to all REST endpoints
    }

    /**
     * Interceptor that enforces per-key token-bucket rate limits.
     */
    @Configuration
    static class RateLimiterInterceptor implements HandlerInterceptor {

        private static final Logger LOG = LoggerFactory.getLogger(RateLimiterInterceptor.class);

        private final RateLimiterService rateLimiterService;
        private final RateLimiterProperties properties;

        @Autowired
        RateLimiterInterceptor(RateLimiterService rateLimiterService,
                               RateLimiterProperties properties) {
            this.rateLimiterService = rateLimiterService;
            this.properties = properties;
        }

        @Override
        public boolean preHandle(HttpServletRequest request,
                                 @NonNull HttpServletResponse response,
                                 @NonNull Object handler) throws Exception {

            if (!properties.isEnabled()) {
                return true; // short-circuit if limiter disabled
            }

            // Resolve bucket key
            String key = resolveKey(request);
            if (rateLimiterService.tryConsume(key)) {
                return true;
            }

            // Too many requests
            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After",
                    String.valueOf(properties.getRefillDuration().getSeconds()));
            LOG.debug("Rate limit exceeded for key '{}'", key);
            return false;
        }

        @Override
        public void postHandle(@NonNull HttpServletRequest request,
                               @NonNull HttpServletResponse response,
                               @NonNull Object handler,
                               ModelAndView modelAndView) {
            // no-op
        }

        @Override
        public void afterCompletion(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull Object handler,
                                    Exception ex) {
            // no-op
        }

        private String resolveKey(HttpServletRequest request) {
            // Prefer authenticated principal if available
            String principal = request.getUserPrincipal() != null
                    ? request.getUserPrincipal().getName()
                    : null;

            if (StringUtils.hasText(principal)) {
                return principal;
            }

            // Fall back to remote address
            return request.getRemoteAddr();
        }
    }

    /**
     * Service-level abstraction around token-bucket storage.
     */
    @Configuration
    static class RateLimiterService {

        private static final Logger LOG = LoggerFactory.getLogger(RateLimiterService.class);

        private final ConcurrentMap<String, TokenBucket> buckets = new ConcurrentHashMap<>();
        private final RateLimiterProperties properties;

        @Autowired
        RateLimiterService(RateLimiterProperties properties) {
            this.properties = properties;
        }

        /**
         * Attempts to consume a single token from the bucket associated with {@code key}.
         *
         * @return {@code true} if the request is within the rate limit, {@code false} otherwise.
         */
        public boolean tryConsume(String key) {
            TokenBucket bucket = buckets.computeIfAbsent(key, this::newBucket);
            boolean allowed = bucket.tryConsume();
            if (!allowed && LOG.isTraceEnabled()) {
                LOG.trace("Request denied by rate limiter [key={}]", key);
            }
            return allowed;
        }

        private TokenBucket newBucket(String ignored) {
            return new TokenBucket(
                    properties.getCapacity(),
                    properties.getRefillTokens(),
                    properties.getRefillDuration());
        }

        /**
         * Periodic cleanup to prevent unbounded memory use.
         * Removes buckets that haven't been used for twice the refill duration.
         */
        @Scheduled(fixedDelayString = "${circleconnect.rate-limiter.cleanup-delay-ms:600000}")
        public void evictStaleBuckets() {
            Instant expiryCutoff = Instant.now()
                    .minus(properties.getRefillDuration().multipliedBy(2));
            buckets.entrySet().removeIf(entry ->
                    entry.getValue().getLastConsumed().isBefore(expiryCutoff));
        }
    }

    /**
     * Simple, lock-based token-bucket implementation.
     */
    static final class TokenBucket {

        private final long capacity;
        private final long refillTokens;
        private final long refillNanos;
        private long availableTokens;
        private long lastRefillTimestamp;
        private Instant lastConsumed = Instant.now();

        TokenBucket(long capacity, long refillTokens, Duration refillDuration) {
            this.capacity = capacity;
            this.refillTokens = refillTokens;
            this.refillNanos = refillDuration.toNanos();
            this.availableTokens = capacity;
            this.lastRefillTimestamp = System.nanoTime();
        }

        synchronized boolean tryConsume() {
            refill();
            if (availableTokens == 0) {
                return false;
            }
            availableTokens--;
            lastConsumed = Instant.now();
            return true;
        }

        synchronized Instant getLastConsumed() {
            return lastConsumed;
        }

        private void refill() {
            long now = System.nanoTime();
            if (now <= lastRefillTimestamp) {
                return;
            }
            long nanosSinceLast = now - lastRefillTimestamp;
            if (nanosSinceLast >= refillNanos) {
                long cycles = nanosSinceLast / refillNanos;
                long tokensToAdd = cycles * refillTokens;
                availableTokens = Math.min(capacity, availableTokens + tokensToAdd);
                lastRefillTimestamp += cycles * refillNanos;
            }
        }
    }

    /**
     * Externalized configuration holder for the rate limiter.
     */
    @ConfigurationProperties(prefix = "circleconnect.rate-limiter")
    static class RateLimiterProperties {

        /**
         * Whether the rate limiter is enabled.
         */
        private boolean enabled = true;

        /**
         * Maximum number of tokens that can be stored in a bucket.
         */
        private long capacity = 120;

        /**
         * Number of tokens added to the bucket every {@code refillDuration}.
         */
        private long refillTokens = 60;

        /**
         * Duration after which {@code refillTokens} are added.
         */
        private Duration refillDuration = Duration.ofMinutes(1);

        public boolean isEnabled() {
            return enabled;
        }

        public void setEnabled(boolean enabled) {
            this.enabled = enabled;
        }

        public long getCapacity() {
            return capacity;
        }

        public void setCapacity(long capacity) {
            this.capacity = capacity;
        }

        public long getRefillTokens() {
            return refillTokens;
        }

        public void setRefillTokens(long refillTokens) {
            this.refillTokens = refillTokens;
        }

        public Duration getRefillDuration() {
            return refillDuration;
        }

        public void setRefillDuration(Duration refillDuration) {
            this.refillDuration = Objects.requireNonNull(refillDuration);
        }
    }
}