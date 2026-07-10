package com.circleconnect.nexus.middleware;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.constraints.Min;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistration;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import java.security.Principal;
import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Module26 – Collection of nested classes related to request-rate limiting.
 * <p>
 *     To keep filename constraints small for this generated example, all classes
 *     are declared as static members of a single public wrapper. Spring’s component
 *     scan is still able to discover them because nested classes can be annotated
 *     with {@code @Component}, {@code @Service}, etc.
 * </p>
 */
@SuppressWarnings("unused")
public class Module26 {

    /* ------------------------------------------------------------------------
     *  Properties
     * --------------------------------------------------------------------- */

    /**
     * Bind-able configuration backing the rate-limiting subsystem.
     * <pre>
     * circleconnect:
     *   rate-limit:
     *     capacity: 100
     *     refill-period: 1m
     *     path-pattern: /api/**
     * </pre>
     */
    @Validated
    @Configuration
    @ConfigurationProperties(prefix = "circleconnect.rate-limit")
    public static class RateLimitProperties {

        /**
         * Maximum number of requests allowed within the {@link #refillPeriod}.
         */
        @Min(1)
        private int capacity = 120;

        /**
         * Window length used to refill the token bucket.
         */
        private Duration refillPeriod = Duration.ofMinutes(1);

        /**
         * Ant-style path pattern where the interceptor will be wired.
         */
        private String pathPattern = "/api/**";

        /* getters / setters */

        public int getCapacity() {
            return capacity;
        }

        public void setCapacity(int capacity) {
            this.capacity = capacity;
        }

        public Duration getRefillPeriod() {
            return refillPeriod;
        }

        public void setRefillPeriod(Duration refillPeriod) {
            this.refillPeriod = refillPeriod;
        }

        public String getPathPattern() {
            return pathPattern;
        }

        public void setPathPattern(String pathPattern) {
            this.pathPattern = pathPattern;
        }
    }

    /* ------------------------------------------------------------------------
     *  Service – Token bucket implementation
     * --------------------------------------------------------------------- */

    /**
     * Thread-safe in-memory token-bucket rate limiter.
     * <p>
     *     In production you would likely replace this with a cluster-wide shared
     *     implementation (e.g., Redis + Lua) but this suffices for a single-node
     *     example.
     * </p>
     */
    @Service
    public static class InMemoryRateLimiterService implements RateLimiterService {

        private final RateLimitProperties props;
        private final ConcurrentMap<String, Bucket> buckets = new ConcurrentHashMap<>();

        public InMemoryRateLimiterService(RateLimitProperties props) {
            this.props = props;
        }

        @Override
        public boolean tryConsume(String key) {
            Bucket bucket = buckets.computeIfAbsent(key, k ->
                    new Bucket(props.getCapacity(), props.getRefillPeriod())
            );
            return bucket.tryConsume();
        }

        @Override
        public long getRemainingTokens(String key) {
            Bucket bucket = buckets.get(key);
            return bucket == null ? props.getCapacity() : bucket.getTokens();
        }

        /* ---------------------- Internal bucket ------------------------- */

        private static final class Bucket {

            private final AtomicInteger tokens;
            private final int capacity;
            private final long refillPeriodMillis;
            private volatile long lastRefillTime;

            private Bucket(int capacity, Duration refillPeriod) {
                this.capacity          = capacity;
                this.tokens            = new AtomicInteger(capacity);
                this.refillPeriodMillis = refillPeriod.toMillis();
                this.lastRefillTime     = System.currentTimeMillis();
            }

            boolean tryConsume() {
                refillIfNeeded();
                int current;
                do {
                    current = tokens.get();
                    if (current == 0) {
                        return false;
                    }
                } while (!tokens.compareAndSet(current, current - 1));
                return true;
            }

            long getTokens() {
                refillIfNeeded();
                return tokens.get();
            }

            private void refillIfNeeded() {
                long now = System.currentTimeMillis();
                long elapsed = now - lastRefillTime;
                if (elapsed >= refillPeriodMillis) {
                    int newTokens = capacity;
                    tokens.set(newTokens);
                    lastRefillTime = now;
                }
            }
        }
    }

    /* ------------------------------------------------------------------------
     *  Service interface
     * --------------------------------------------------------------------- */

    public interface RateLimiterService {
        /**
         * Attempt to consume a single token for the provided key.
         *
         * @param key user or client identifier
         * @return {@code true} if a token was consumed, {@code false} otherwise
         */
        boolean tryConsume(String key);

        /**
         * Remaining tokens in the bucket for the provided key.
         */
        long getRemainingTokens(String key);
    }

    /* ------------------------------------------------------------------------
     *  Exception
     * --------------------------------------------------------------------- */

    /**
     * Exception thrown when the rate limit is exceeded. Controllers may handle
     * this explicitly or rely on a {@link org.springframework.web.bind.annotation.ControllerAdvice}
     * to convert it to a standardized JSON error document.
     */
    public static class RateLimitExceededException extends RuntimeException {
        public RateLimitExceededException(String message) {
            super(message);
        }
    }

    /* ------------------------------------------------------------------------
     *  Interceptor
     * --------------------------------------------------------------------- */

    /**
     * Spring MVC interceptor computing a per-principal or per-IP address rate limit
     * for all REST endpoints matched by the configured path pattern.
     */
    @Component
    @ConditionalOnWebApplication
    public static class RateLimitInterceptor implements HandlerInterceptor {

        private static final Logger log = LoggerFactory.getLogger(RateLimitInterceptor.class);

        private final RateLimiterService limiter;
        private final RateLimitProperties props;

        public RateLimitInterceptor(RateLimiterService limiter,
                                    RateLimitProperties props) {
            this.limiter = limiter;
            this.props   = props;
        }

        @Override
        public boolean preHandle(HttpServletRequest request,
                                 HttpServletResponse response,
                                 Object handler) {

            // Skip non-API handlers or static resources
            if (!(handler instanceof HandlerMethod)) {
                return true;
            }

            String key = resolveRateLimitKey(request);
            boolean allowed = limiter.tryConsume(key);

            long remaining = limiter.getRemainingTokens(key);
            response.setHeader("X-Rate-Limit-Remaining", String.valueOf(remaining));

            if (!allowed) {
                log.debug("Rate limit exceeded for key={} on {} {}", key,
                        request.getMethod(), request.getRequestURI());

                throw new RateLimitExceededException("Too many requests");
            }
            return true;
        }

        private String resolveRateLimitKey(HttpServletRequest request) {
            Principal principal = request.getUserPrincipal();
            if (Objects.nonNull(principal)) {
                return "USER#" + principal.getName();
            }
            String forwardedFor = request.getHeader("X-Forwarded-For");
            if (forwardedFor != null && !forwardedFor.isBlank()) {
                return "IP#" + forwardedFor.split(",")[0].trim();
            }
            return "IP#" + request.getRemoteAddr();
        }
    }

    /* ------------------------------------------------------------------------
     *  MVC registration
     * --------------------------------------------------------------------- */

    /**
     * Registers the {@link RateLimitInterceptor} with Spring MVC.
     */
    @Configuration
    public static class RateLimitConfiguration implements WebMvcConfigurer {

        private final RateLimitInterceptor interceptor;
        private final RateLimitProperties  props;

        public RateLimitConfiguration(RateLimitInterceptor interceptor,
                                      RateLimitProperties props) {
            this.interceptor = interceptor;
            this.props       = props;
        }

        @Override
        public void addInterceptors(org.springframework.web.servlet.config.annotation.InterceptorRegistry registry) {
            InterceptorRegistration registration = registry.addInterceptor(interceptor);

            if (props.getPathPattern() != null && !props.getPathPattern().isBlank()) {
                registration.addPathPatterns(props.getPathPattern());
            }
        }
    }
}