```java
package com.circleconnect.nexus.infrastructure.rate;

import jakarta.servlet.http.HttpServletRequest;
import java.lang.reflect.Method;
import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.aspectj.lang.reflect.MethodSignature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.ResponseStatus;

/**
 * Aspect that enforces rate–limiting rules declared via {@link RateLimited}.
 *
 * <p>The annotation can be placed on
 * <ul>
 *   <li>Controller methods</li>
 *   <li>Service facade methods that are exposed through RPC or Websocket gateways</li>
 * </ul>
 *
 * <p>Implementation details:
 * <ul>
 *   <li>Uses Redis atomic increment operations for distributed throttling.</li>
 *   <li>Supports per-user or per-IP segmentation.</li>
 *   <li>If no authenticated principal is present, falls back to client IP.</li>
 * </ul>
 *
 * <p>When the limit is exceeded, a {@link RateLimitExceededException} is thrown
 * and will be translated into an HTTP 429 response by Spring’s {@code @ControllerAdvice}.
 */
@Aspect
@Component
@Order(1) // Execute before transactional advice, logging, etc.
public class RateLimitingAspect {

    private static final Logger log = LoggerFactory.getLogger(RateLimitingAspect.class);

    private static final String REDIS_RATE_KEY_TEMPLATE = "ccnx:rl:%s:%s"; // {segment}:{method}

    private final RedisTemplate<String, Long> redisTemplate;
    private final HttpServletRequest request;

    public RateLimitingAspect(RedisTemplate<String, Long> redisTemplate, HttpServletRequest request) {
        this.redisTemplate = Objects.requireNonNull(redisTemplate, "redisTemplate must not be null");
        this.request = Objects.requireNonNull(request, "request must not be null");
    }

    @Around("@annotation(com.circleconnect.nexus.infrastructure.rate.RateLimited)")
    public Object enforceRateLimit(final ProceedingJoinPoint pjp) throws Throwable {
        Method method = ((MethodSignature) pjp.getSignature()).getMethod();
        RateLimited config = method.getAnnotation(RateLimited.class);

        // compute bucket key – either by authenticated user or by originating IP
        String segmentIdentifier = config.perUser() ? resolveUserId().orElse(resolveIp()) : resolveIp();
        String redisKey = String.format(
                REDIS_RATE_KEY_TEMPLATE,
                segmentIdentifier,
                method.getDeclaringClass().getSimpleName() + "#" + method.getName()
        );

        long current = incrementCounter(redisKey, config.timeWindowSeconds());

        if (current > config.maxRequests()) {
            log.debug("Rate limit exceeded for key={} (count={}/{})", redisKey, current, config.maxRequests());
            throw new RateLimitExceededException(
                    "Rate limit exceeded. Allowed "
                            + config.maxRequests()
                            + " requests / "
                            + config.timeWindowSeconds()
                            + "s");
        }

        return pjp.proceed();
    }

    private long incrementCounter(String redisKey, long windowSeconds) {
        try {
            Long counter = redisTemplate.opsForValue().increment(redisKey, 1);
            if (counter != null && counter == 1L) {
                // newly created – set TTL
                redisTemplate.expire(redisKey, Duration.ofSeconds(windowSeconds));
            }
            return counter != null ? counter : 0L;
        } catch (Exception ex) {
            // In case of Redis outage, fail-open rather than degrade user experience.
            log.error("Unable to increment rate-limit counter for key={}", redisKey, ex);
            return 0L;
        }
    }

    private Optional<String> resolveUserId() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth == null || !auth.isAuthenticated()) {
            return Optional.empty();
        }
        // Use principal name by default; OAauth2 tokens may expose different attributes
        return Optional.ofNullable(auth.getName());
    }

    private String resolveIp() {
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            // Could be a list: client, proxy1, proxy2...
            return forwarded.split(",")[0].trim();
        }
        return Optional.ofNullable(request.getRemoteAddr()).orElse("unknown");
    }

    /**
     * Annotation that declares rate–limiting parameters.
     *
     * <p>Usage: annotate controller methods that should be throttled.</p>
     *
     * Example:
     * <pre>
     * {@code
     * @GetMapping("/api/v1/search")
     * @RateLimited(maxRequests = 20, timeWindowSeconds = 10)
     * public ResponseEntity<SearchResult> search(@RequestParam String q) { ... }
     * }
     * </pre>
     */
    @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
    @java.lang.annotation.Target({java.lang.annotation.ElementType.METHOD})
    public @interface RateLimited {
        /**
         * Maximum number of requests allowed during the window.
         */
        long maxRequests();

        /**
         * Sliding window in seconds.
         */
        long timeWindowSeconds();

        /**
         * Apply rate-limit per user (true) or per originating IP (false).
         */
        boolean perUser() default true;
    }

    /**
     * Exception thrown when a rate-limit rule is violated.
     */
    @ResponseStatus(HttpStatus.TOO_MANY_REQUESTS)
    public static class RateLimitExceededException extends RuntimeException {
        public RateLimitExceededException(String message) {
            super(message);
        }
    }
}
```