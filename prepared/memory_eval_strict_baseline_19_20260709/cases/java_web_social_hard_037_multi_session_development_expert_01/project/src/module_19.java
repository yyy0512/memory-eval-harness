package com.circleconnect.nexus.infrastructure.security.ratelimit;

import java.io.IOException;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.springframework.beans.BeansException;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import org.springframework.context.ApplicationContextAware;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.MethodParameter;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.lang.Nullable;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.util.WebUtils;

import org.springframework.data.redis.core.RedisTemplate;

/**
 * Production-quality, Redis-backed rate limiting interceptor for CircleConnect Nexus.
 * <p>
 * The interceptor is applied transparently via {@link WebMvcConfigurer} and
 * inspects custom {@link RateLimit} annotations on controllers/handler methods.
 * <p>
 * A lightweight Lua-script-free token bucket implementation is used to guarantee
 * atomic increments while delegating TTL handling to Redis.
 */
@Component
public class RateLimitingInterceptor implements HandlerInterceptor, ApplicationContextAware, InitializingBean {

    private static final String DEFAULT_IDENTIFIER_HEADER = "X-Forwarded-For";

    private final RedisTokenBucket tokenBucket;

    private ApplicationContext applicationContext;

    @Autowired
    public RateLimitingInterceptor(final RedisTemplate<String, String> redisTemplate) {
        this.tokenBucket = new RedisTokenBucket(redisTemplate);
    }

    @Override
    public void afterPropertiesSet() {
        // Bean validation hook – make sure a Redis connection is available.
        if (!tokenBucket.isOperational()) {
            throw new IllegalStateException("RateLimitingInterceptor cannot be initialized – Redis unavailable.");
        }
    }

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request,
                             @NonNull HttpServletResponse response,
                             @NonNull Object handler) throws Exception {

        Optional<RateLimit> annotationOpt = resolveRateLimitAnnotation(handler);
        if (annotationOpt.isEmpty()) {
            // No rate-limit annotation present – proceed normally.
            return true;
        }

        RateLimit rateLimit = annotationOpt.get();
        String identifier = resolveRequesterIdentifier(request);

        final String redisKey = buildRedisKey(rateLimit, identifier, request);

        boolean allowed = tokenBucket.tryConsume(
                redisKey,
                rateLimit.requests(),
                rateLimit.durationUnit().toSeconds(rateLimit.duration())
        );

        if (!allowed) {
            handleRejection(response, rateLimit);
            return false;
        }
        return true;
    }

    private Optional<RateLimit> resolveRateLimitAnnotation(Object handler) {
        if (!(handler instanceof HandlerMethod)) {
            return Optional.empty();
        }
        HandlerMethod handlerMethod = (HandlerMethod) handler;

        // Method-level overrides class-level settings
        RateLimit methodAnnotation = handlerMethod.getMethodAnnotation(RateLimit.class);
        if (methodAnnotation != null) {
            return Optional.of(methodAnnotation);
        }
        Class<?> beanType = handlerMethod.getBeanType();
        return Optional.ofNullable(beanType.getAnnotation(RateLimit.class));
    }

    private String resolveRequesterIdentifier(HttpServletRequest request) {
        // 1. Prefer an authenticated user ID
        Object principal = request.getUserPrincipal();
        if (principal != null) {
            return principal.toString();
        }

        // 2. Fall back to forwarded-for header or remote addr
        String headerIp = request.getHeader(DEFAULT_IDENTIFIER_HEADER);
        if (StringUtils.hasText(headerIp)) {
            return headerIp;
        }
        return request.getRemoteAddr();
    }

    private String buildRedisKey(RateLimit rateLimit, String identifier, HttpServletRequest request) {
        String endpoint = Optional.ofNullable(WebUtils.extractPathWithinApplication(request))
                                  .orElse("UNKNOWN");
        return new StringBuilder("ratelimit:")
                .append(rateLimit.scope())
                .append(':')
                .append(endpoint).append(':')
                .append(identifier)
                .toString();
    }

    private void handleRejection(HttpServletResponse response, RateLimit rateLimit) throws IOException {
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setContentType("application/json");
        long retryAfterSeconds = rateLimit.durationUnit().toSeconds(rateLimit.duration());
        response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
        response.getWriter().write("{\"error\":\"rate_limit_exceeded\",\"message\":\"Slow down!\"}");
    }

    @Override
    public void setApplicationContext(@NonNull ApplicationContext applicationContext) throws BeansException {
        this.applicationContext = applicationContext;
    }

    // ---------------------------------------------------------------------
    // Helper token-bucket implementation
    // ---------------------------------------------------------------------

    /**
     * Simple, thread-safe token bucket implementation backed by Redis INCR/EXPIRE.
     */
    static class RedisTokenBucket {

        private final RedisTemplate<String, String> redisTemplate;

        RedisTokenBucket(RedisTemplate<String, String> redisTemplate) {
            this.redisTemplate = redisTemplate;
        }

        boolean isOperational() {
            try {
                redisTemplate.getConnectionFactory().getConnection().ping();
                return true;
            } catch (Exception ex) {
                return false;
            }
        }

        /**
         * Attempts to consume a single token.
         *
         * @param key              bucket key
         * @param capacity         maximum number of requests per window
         * @param windowInSeconds  window size
         * @return {@code true} if request is allowed, {@code false} otherwise
         */
        boolean tryConsume(String key, int capacity, long windowInSeconds) {
            Long current = redisTemplate.opsForValue().increment(key);
            if (current == null) {
                // Redis failure – be fail-safe and allow request
                return true;
            }
            if (current == 1) {
                // First hit – add TTL
                redisTemplate.expire(key, Duration.ofSeconds(windowInSeconds));
            }
            return current <= capacity;
        }
    }
}

/* ---------------------------------------------------------
 *  Annotation definition
 * ---------------------------------------------------------
 */

@Target({ElementType.METHOD, ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
@interface RateLimit {

    /**
     * Number of requests allowed within the specified time window.
     */
    int requests();

    /**
     * Duration of the time window.
     */
    long duration();

    /**
     * TimeUnit of duration, default SECONDS.
     */
    TimeUnit durationUnit() default TimeUnit.SECONDS;

    /**
     * Free-form scope label for easier key grouping in Redis.
     */
    @NonNull String scope() default "api";
}

/* ---------------------------------------------------------
 *  MVC configuration to register the interceptor
 * ---------------------------------------------------------
 */

@Configuration
class RateLimitWebMvcConfigurer implements WebMvcConfigurer {

    private final RateLimitingInterceptor interceptor;

    @Autowired
    RateLimitWebMvcConfigurer(RateLimitingInterceptor interceptor) {
        this.interceptor = interceptor;
    }

    @Override
    public void addInterceptors(@NonNull InterceptorRegistry registry) {
        // Order set to lowest precedence to ensure auth/metrics happen first.
        registry.addInterceptor(interceptor).order(InterceptorRegistry.LOWEST_PRECEDENCE);
    }
}
