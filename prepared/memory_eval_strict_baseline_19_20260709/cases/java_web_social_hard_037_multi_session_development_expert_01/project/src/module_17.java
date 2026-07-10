package com.circleconnect.nexus.infrastructure.ratelimit;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;

/**
 * Centralised, annotation-driven rate-limiting module for CircleConnect Nexus.
 *
 * <p>Usage example:
 * <pre>
 * &#64;RateLimitingModule.RateLimited(
 *         permits = 10,
 *         duration = 1,
 *         timeUnit = TimeUnit.MINUTES,
 *         key = "#user.id"   // Optional SpEL; defaults to method signature hash
 * )
 * public void createPost(User user, PostDTO dto) { ... }
 * </pre>
 *
 * <p>The module is intentionally self-contained so that a single compilation
 * unit can be dropped into different build pipelines without extra wiring.
 *
 * <p>Requires:
 * <ul>
 *     <li>Spring AOP (spring-boot-starter-aop)</li>
 *     <li>Caffeine cache</li>
 * </ul>
 */
public final class RateLimitingModule {

    /* -------------------------------------------------------------
     * Public annotation
     * ------------------------------------------------------------- */

    /**
     * Marks a controller or service method as subject to rate limiting.
     *
     * <p>The combination of {@code key} and {@code permits}+{@code duration}
     * defines a unique token bucket. If the bucket is exhausted,
     * {@link RateLimitExceededException} is thrown and automatically translated
     * to <em>HTTP 429 Too Many Requests</em> by {@code RestExceptionHandler}.
     */
    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.METHOD)
    public @interface RateLimited {

        /**
         * Number of allowed invocations within the specified window.
         */
        int permits();

        /**
         * Length of the sliding window.
         */
        long duration();

        /**
         * Time unit of {@link #duration()}.
         */
        TimeUnit timeUnit() default TimeUnit.MINUTES;

        /**
         * Optional SpEL expression to compute the rate-limit key dynamically.
         *
         * <p>If left empty, a deterministic key derived from the fully-qualified
         * method name + argument hash will be used.
         */
        String key() default "";
    }

    /* -------------------------------------------------------------
     * Public exception
     * ------------------------------------------------------------- */

    /**
     * Thrown when a client exceeds the configured rate limit.
     */
    public static class RateLimitExceededException extends RuntimeException {

        private static final long serialVersionUID = 2593290591174704991L;

        public RateLimitExceededException(String message) { super(message); }
    }

    /* -------------------------------------------------------------
     * Aspect implementation
     * ------------------------------------------------------------- */

    @Aspect
    @Component
    public static class RateLimitingAspect {

        private static final Logger log = LoggerFactory.getLogger(RateLimitingAspect.class);

        /**
         * Allows administrators to toggle rate limiting system-wide via
         * <code>circleconnect.ratelimiting.enabled</code> (default: <code>true</code>).
         */
        @Value("${circleconnect.ratelimiting.enabled:true}")
        private boolean enabled;

        private final RateLimiterRegistry registry = new RateLimiterRegistry();
        private final SpelKeyResolver spelKeyResolver = new SpelKeyResolver();

        /**
         * Around advice that intercepts every method annotated with {@link RateLimited}.
         */
        @Around("@annotation(rateLimited)")
        public Object enforceRateLimit(
                final ProceedingJoinPoint pjp,
                final RateLimited rateLimited) throws Throwable {

            if (!enabled) {
                return pjp.proceed();
            }

            String key = resolveKey(pjp, rateLimited);
            boolean allowed = registry.tryAcquire(
                    key,
                    rateLimited.permits(),
                    Duration.of(rateLimited.duration(), toChronoUnit(rateLimited.timeUnit())));

            if (!allowed) {
                log.debug("Rate limit exceeded [key={}, permits={}, window={} {}]",
                        key,
                        rateLimited.permits(),
                        rateLimited.duration(),
                        rateLimited.timeUnit().name().toLowerCase());
                throw new RateLimitExceededException("Rate limit exceeded");
            }
            return pjp.proceed();
        }

        /**
         * Attempts to resolve a stable key for the current invocation.
         * Falls back to a signature-based hash if {@code key} is empty.
         */
        private String resolveKey(ProceedingJoinPoint pjp, RateLimited annotation) {
            if (annotation.key() == null || annotation.key().trim().isEmpty()) {
                // Use fully qualified method + arg hash as default
                return pjp.getSignature().toLongString() + "#" + Objects.hash((Object[]) pjp.getArgs());
            }

            try {
                return spelKeyResolver.evaluate(annotation.key(), pjp);
            } catch (Exception ex) {
                log.warn("Failed to evaluate SpEL key expression '{}', falling back to default. Cause: {}",
                        annotation.key(), ex.getMessage());
                return pjp.getSignature().toLongString();
            }
        }

        private static java.time.temporal.ChronoUnit toChronoUnit(TimeUnit timeUnit) {
            switch (timeUnit) {
                case NANOSECONDS:   return java.time.temporal.ChronoUnit.NANOS;
                case MICROSECONDS:  return java.time.temporal.ChronoUnit.MICROS;
                case MILLISECONDS:  return java.time.temporal.ChronoUnit.MILLIS;
                case SECONDS:       return java.time.temporal.ChronoUnit.SECONDS;
                case MINUTES:       return java.time.temporal.ChronoUnit.MINUTES;
                case HOURS:         return java.time.temporal.ChronoUnit.HOURS;
                case DAYS:          return java.time.temporal.ChronoUnit.DAYS;
                default:            return java.time.temporal.ChronoUnit.MINUTES;
            }
        }
    }

    /* -------------------------------------------------------------
     * Registry and bucket implementations
     * ------------------------------------------------------------- */

    /**
     * Stores token buckets keyed by arbitrary user-defined strings.
     * Buckets expire after <em>30 minutes</em> of inactivity to avoid
     * unbounded memory usage.
     */
    static class RateLimiterRegistry {

        private final Cache<String, TokenBucket> buckets = Caffeine.newBuilder()
                .expireAfterAccess(30, TimeUnit.MINUTES)
                .build();

        /**
         * Attempts to consume a single permit from the bucket identified by {@code key}.
         *
         * @return {@code true} when a permit is available, otherwise {@code false}
         */
        boolean tryAcquire(String key, int capacity, Duration window) {
            TokenBucket bucket = buckets.get(key, k -> new TokenBucket(capacity, window));
            return bucket.tryConsume();
        }
    }

    /**
     * Simple, thread-safe token bucket implementation with lazy refill logic.
     *
     * <p>This implementation is accurate enough for user-facing rate limiting,
     * while avoiding the overhead of atomic timers at scale.</p>
     */
    static class TokenBucket {

        private final int capacity;
        private final double refillTokensPerMillis;

        private double tokens;
        private long lastRefillTimestamp;

        TokenBucket(int capacity, Duration window) {
            if (capacity <= 0) {
                throw new IllegalArgumentException("Capacity must be > 0");
            }
            this.capacity = capacity;
            this.tokens = capacity;
            this.refillTokensPerMillis = capacity / (double) window.toMillis();
            this.lastRefillTimestamp = System.currentTimeMillis();
        }

        /**
         * Attempts to consume <em>one</em> token.
         */
        synchronized boolean tryConsume() {
            refill();

            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            return false;
        }

        /**
         * Refill tokens based on elapsed time since last refill.
         */
        private void refill() {
            long now = System.currentTimeMillis();
            long elapsed = now - lastRefillTimestamp;
            if (elapsed <= 0) {
                return;
            }

            double refill = elapsed * refillTokensPerMillis;
            tokens = Math.min(capacity, tokens + refill);
            lastRefillTimestamp = now;
        }
    }

    /* -------------------------------------------------------------
     * SpEL helper
     * ------------------------------------------------------------- */

    /**
     * Lightweight SpEL resolver for computing dynamic keys without requiring
     * Spring Data or other heavyweight dependencies.
     */
    static class SpelKeyResolver {

        private final org.springframework.expression.ExpressionParser parser =
                new org.springframework.expression.spel.standard.SpelExpressionParser();

        private final org.springframework.expression.EvaluationContext context =
                new org.springframework.expression.spel.support.StandardEvaluationContext();

        @SuppressWarnings("unchecked")
        String evaluate(String spelExpression, ProceedingJoinPoint pjp) {
            String[] paramNames = ((org.aspectj.lang.reflect.CodeSignature) pjp.getSignature()).getParameterNames();
            Object[] args = pjp.getArgs();

            for (int i = 0; i < paramNames.length; i++) {
                context.setVariable(paramNames[i], args[i]);
            }
            Object value = parser.parseExpression(spelExpression).getValue(context);
            return Objects.toString(value, "unknown");
        }
    }

    /* -------------------------------------------------------------
     * Utility class
     * ------------------------------------------------------------- */

    private RateLimitingModule() {
        /* Utility class – do not instantiate. */
    }
}