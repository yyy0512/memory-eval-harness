package com.circleconnect.nexus.infrastructure.ratelimit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.lang.annotation.*;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Production-grade, pluggable request-rate-limiting module for CircleConnect Nexus.
 * <p>
 * The module exposes:
 *  – {@link RateLimited}   – declarative annotation for controllers / endpoints
 *  – {@link RateLimitingInterceptor} – Spring MVC interceptor enforcing the limits
 *  – {@link RateLimitingConfiguration} – auto-configuration & wiring
 *  – {@link RateLimitExceededException} / {@link RateLimitExceededHandler} – error handling
 *
 * Two storage back-ends are supported seamlessly:
 *  – Redis (preferred for horizontal scalability)
 *  – In-memory fallback (dev / test environments)
 *
 * Thread-safe, resilient, and covered by extensive logging for the admin
 * observability panel.
 */
public final class RateLimitingModule {

    /* **********************************************************************
     *                               API
     * *********************************************************************/

    /**
     * Annotation to declare rate limiting constraints.
     * Can be applied at method level or controller (class) level.
     * Method-level annotation overrides controller-level values.
     */
    @Documented
    @Retention(RetentionPolicy.RUNTIME)
    @Target({ElementType.METHOD, ElementType.TYPE})
    public @interface RateLimited {

        /**
         * Maximum number of requests allowed in the window.
         */
        int maxRequests() default 100;

        /**
         * Size of the window. A value of 1 with {@code unit = TimeUnit.MINUTES}
         * defines a classic "requests per minute" policy, etc.
         */
        long window() default 1;

        /**
         * Time unit for {@link #window()}.
         */
        TimeUnit unit() default TimeUnit.MINUTES;
    }

    /**
     * Thrown when a client exceeds the rate limit.
     */
    public static class RateLimitExceededException extends RuntimeException {
        private final long retryAfterSeconds;

        public RateLimitExceededException(long retryAfterSeconds) {
            super("API rate limit exceeded. Retry after " + retryAfterSeconds + " seconds");
            this.retryAfterSeconds = retryAfterSeconds;
        }

        public long getRetryAfterSeconds() {
            return retryAfterSeconds;
        }
    }

    /* **********************************************************************
     *                         Core Interceptor
     * *********************************************************************/

    /**
     * Interceptor that enforces {@link RateLimited} constraints by using Redis
     * if available, falling back to in-process memory otherwise.
     */
    public static class RateLimitingInterceptor implements HandlerInterceptor {

        private static final Logger log = LoggerFactory.getLogger(RateLimitingInterceptor.class);

        private static final String REDIS_KEY_PREFIX = "ccn:ratelim:";

        private final Optional<StringRedisTemplate> redisTemplate;

        /**
         * Fallback store: key → (count, expiryEpochSeconds)
         */
        private final ConcurrentHashMap<String, Window> inMemoryStore = new ConcurrentHashMap<>();

        public RateLimitingInterceptor(ObjectProvider<StringRedisTemplate> redisTemplateProvider) {
            this.redisTemplate = Optional.ofNullable(redisTemplateProvider.getIfAvailable());
            if (this.redisTemplate.isPresent()) {
                log.info("RateLimitingInterceptor configured to use Redis back-end");
            } else {
                log.warn("Redis unavailable – falling back to IN-MEMORY rate-limit store (non-cluster-safe!)");
            }
        }

        @Override
        public boolean preHandle(HttpServletRequest request,
                                 @NonNull HttpServletResponse response,
                                 @NonNull Object handler) throws Exception {

            // No annotation – no rate limiting.
            RateLimited policy = resolvePolicy(handler);
            if (policy == null) {
                return true;
            }

            String key = buildKey(request);
            long max = policy.maxRequests();
            long windowSeconds = policy.unit().toSeconds(policy.window());

            long currentCount;
            long ttl;

            if (redisTemplate.isPresent()) {
                currentCount = incrementInRedis(key, windowSeconds);
                ttl = redisTemplate.get().getExpire(REDIS_KEY_PREFIX + key);
            } else {
                currentCount = incrementInMemory(key, windowSeconds);
                ttl = computeInMemoryTtl(key);
            }

            if (currentCount > max) {
                log.debug("Rate limit exceeded for key={} (count={}/{})", key, currentCount, max);
                throw new RateLimitExceededException(ttl);
            }

            return true;
        }

        /* ****************** Redis implementation ********************* */

        private long incrementInRedis(String key, long windowSeconds) {
            String namespaced = REDIS_KEY_PREFIX + key;
            StringRedisTemplate rt = redisTemplate.get();
            Long count = rt.opsForValue().increment(namespaced);
            if (count != null && count == 1L) {
                // first hit → set expiry
                rt.expire(namespaced, Duration.ofSeconds(windowSeconds));
            }
            return count == null ? 0 : count;
        }

        /* ****************** In-memory implementation ***************** */

        private long incrementInMemory(String key, long windowSeconds) {
            long now = Instant.now().getEpochSecond();
            Window window = inMemoryStore.compute(key, (k, existing) -> {
                if (existing == null || now >= existing.expiryEpochSeconds) {
                    return new Window(1, now + windowSeconds);
                }
                existing.count++;
                return existing;
            });
            return window.count;
        }

        private long computeInMemoryTtl(String key) {
            Window w = inMemoryStore.get(key);
            return w == null ? 0 : Math.max(0, w.expiryEpochSeconds - Instant.now().getEpochSecond());
        }

        private static final class Window {
            long count;
            long expiryEpochSeconds;

            Window(long count, long expiryEpochSeconds) {
                this.count = count;
                this.expiryEpochSeconds = expiryEpochSeconds;
            }
        }

        /* ******************** Utility methods ************************ */

        /**
         * Builds a unique rate-limit key for the current caller.
         * Prefers authenticated user ID; falls back to remote IP.
         */
        private String buildKey(HttpServletRequest request) {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth != null && auth.isAuthenticated() && StringUtils.hasText(auth.getName())) {
                return "u:" + auth.getName();
            }
            String ip = extractClientIp(request);
            return "ip:" + ip;
        }

        private String extractClientIp(HttpServletRequest request) {
            String header = request.getHeader("X-Forwarded-For");
            if (StringUtils.hasText(header)) {
                return header.split(",")[0].trim();
            }
            return Objects.requireNonNullElse(request.getRemoteAddr(), "unknown");
        }

        private RateLimited resolvePolicy(Object handler) {
            if (handler instanceof HandlerMethod) {
                HandlerMethod hm = (HandlerMethod) handler;
                RateLimited methodAnn = AnnotatedElementUtils.findMergedAnnotation(hm.getMethod(), RateLimited.class);
                if (methodAnn != null) {
                    return methodAnn;
                }
                return AnnotatedElementUtils.findMergedAnnotation(hm.getBeanType(), RateLimited.class);
            }
            return null;
        }
    }

    /* **********************************************************************
     *                         Spring Configuration
     * *********************************************************************/

    @Configuration
    public static class RateLimitingConfiguration implements WebMvcConfigurer {

        private final RateLimitingInterceptor interceptor;

        @Autowired
        public RateLimitingConfiguration(ObjectProvider<StringRedisTemplate> redisTemplateProvider) {
            this.interceptor = new RateLimitingInterceptor(redisTemplateProvider);
        }

        @Override
        public void addInterceptors(org.springframework.web.servlet.config.annotation.InterceptorRegistry registry) {
            registry.addInterceptor(interceptor).order(1);
        }

        /**
         * Exposes the interceptor as a bean for external customisation & metrics.
         */
        @Bean
        public RateLimitingInterceptor rateLimitingInterceptor() {
            return interceptor;
        }
    }

    /* **********************************************************************
     *                       Exception ⇄ HTTP mapping
     * *********************************************************************/

    @ControllerAdvice
    public static class RateLimitExceededHandler extends ResponseEntityExceptionHandler {

        private static final Logger log = LoggerFactory.getLogger(RateLimitExceededHandler.class);

        @ExceptionHandler(RateLimitExceededException.class)
        public void handle(HttpServletRequest request,
                           HttpServletResponse response,
                           RateLimitExceededException ex) {

            log.info("429 Too Many Requests: path={} retryAfter={}",
                     request.getRequestURI(), ex.getRetryAfterSeconds());

            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setHeader("Retry-After", String.valueOf(ex.getRetryAfterSeconds()));
        }
    }

    private RateLimitingModule() {
        /* utility class – no instantiation */
    }
}