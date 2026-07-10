```java
package com.circleconnect.nexus.infrastructure.rate;

import java.io.IOException;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.time.Instant;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import org.springframework.aop.support.AopUtils;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.AnnotationUtils;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.lang.Nullable;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.util.Assert;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * NOTE:
 * This file is intentionally named "module_12.java" to satisfy the prompt’s
 * path requirement.  It contains a single public wrapper class (module_12) that
 * exposes nested types holding reusable, production-ready rate-limiting
 * facilities.  All Spring components are declared as <em>public static</em>
 * nested classes so that component scanning functions as usual.
 */
public final class module_12 {

    private module_12() {
        /* utility wrapper – prevent instantiation */
    }

    /* ==================================================================================
     *  Annotation
     * ================================================================================== */

    /**
     * Declarative rate-limit for controllers / individual request handler methods.
     * Example usage:
     * <pre>
     * &#64;RateLimit(permits = 50, timeWindow = 1, unit = TimeUnit.MINUTES)
     * public ResponseEntity&lt;?&gt; postMessage(...) { ... }
     * </pre>
     */
    @Target({ElementType.METHOD, ElementType.TYPE})
    @Retention(RetentionPolicy.RUNTIME)
    public @interface RateLimit {

        /**
         * How many requests are allowed in a single window.
         */
        int permits();

        /**
         * Size of the window, expressed in {@link #unit()}.
         */
        long timeWindow();

        /**
         * Time unit for {@link #timeWindow()}.
         */
        TimeUnit unit() default TimeUnit.SECONDS;

        /**
         * Logical bucket identifier so multiple endpoints can share the same quota.
         * Defaults to the declaring class / method’s simple name when left empty.
         */
        String bucket() default "";
    }

    /* ==================================================================================
     *  Exception
     * ================================================================================== */

    /**
     * Thrown when a request exceeds the configured rate limit.  Spring MVC will translate
     * this to a 429 (Too Many Requests) by default, but the interceptor also sets the
     * status manually when possible for early feedback.
     */
    public static class RateLimitExceededException extends RuntimeException {

        private static final long serialVersionUID = -863065374421196268L;

        public RateLimitExceededException(String message) {
            super(message);
        }
    }

    /* ==================================================================================
     *  Interceptor
     * ================================================================================== */

    /**
     * MVC interceptor using a Redis backbone (with local fallback) to enforce distributed
     * rate-limits across the whole CircleConnect Nexus cluster.  The algorithm is a simple
     * fixed window counter, which is sufficient for human-scale interactions and avoids
     * expensive Lua scripts.
     */
    @Component
    public static class RateLimitingInterceptor implements HandlerInterceptor, InitializingBean {

        private final StringRedisTemplate redis;
        private final boolean redisAvailable;
        private final ConcurrentHashMap<String, LocalBucket> localBuckets = new ConcurrentHashMap<>();

        /**
         * When Redis is unavailable, an in-memory fallback is enabled so the platform
         * remains resilient (albeit without cluster-wide consistency).
         */
        @Value("${nexus.rate.fallback-window-ms:60000}")
        private long fallbackWindowMs;

        public RateLimitingInterceptor(@Nullable StringRedisTemplate redis) {
            this.redis = redis;
            this.redisAvailable = redis != null;
        }

        @Override
        public boolean preHandle(
                @NonNull HttpServletRequest request,
                @NonNull HttpServletResponse response,
                @NonNull Object handler) throws Exception {

            // Only inspect handler methods.
            if (!(handler instanceof HandlerMethod)) {
                return true;
            }

            HandlerMethod handlerMethod = (HandlerMethod) handler;
            RateLimit settings = resolveRateLimit(handlerMethod);
            if (settings == null) {
                return true; // No annotation present.
            }

            String key = buildKey(request, handlerMethod, settings);
            boolean allowed = redisAvailable ? checkRedisQuota(key, settings) : checkLocalQuota(key, settings);
            if (!allowed) {
                handleLimitExceeded(response, settings);
                return false;
            }

            return true;
        }

        @Override
        public void afterPropertiesSet() throws Exception {
            if (!redisAvailable) {
                System.err.println("[RateLimiting] Redis not detected – using local fallback mode");
            }
        }

        /* -------------------------------------------------------------------------
         *  Quota logic
         * ------------------------------------------------------------------------- */

        private boolean checkRedisQuota(String key, RateLimit settings) {
            try {
                long current = Optional
                        .ofNullable(redis.opsForValue().increment(key))
                        .orElse(0L);

                if (current == 1) {
                    // First hit in window – set TTL.
                    long ttl = settings.unit().toSeconds(settings.timeWindow());
                    redis.expire(key, ttl, TimeUnit.SECONDS);
                }
                return current <= settings.permits();
            } catch (RedisConnectionFailureException ex) {
                // Fail-open to local fallback if Redis is temporarily unreachable.
                System.err.println("[RateLimiting] Redis connection failed – switching to local fallback");
                return checkLocalQuota(key, settings);
            }
        }

        private boolean checkLocalQuota(String key, RateLimit settings) {
            long windowMs = settings.unit().toMillis(settings.timeWindow());
            LocalBucket bucket = localBuckets.computeIfAbsent(key, k -> new LocalBucket(windowMs));
            return bucket.increment() <= settings.permits();
        }

        /* -------------------------------------------------------------------------
         *  Utility helpers
         * ------------------------------------------------------------------------- */

        /**
         * Determine which annotation applies (method overrides class).  Uses Spring’s
         * {@link AnnotationUtils} to resolve merged / meta annotations transparently.
         */
        @Nullable
        private RateLimit resolveRateLimit(HandlerMethod handlerMethod) {
            RateLimit methodLimit = AnnotationUtils.findAnnotation(handlerMethod.getMethod(), RateLimit.class);
            if (methodLimit != null) {
                return methodLimit;
            }
            // If a proxy is in play, inspect the target class rather than the proxy itself.
            Class<?> beanClass = AopUtils.getTargetClass(handlerMethod.getBean());
            return AnnotationUtils.findAnnotation(beanClass, RateLimit.class);
        }

        /**
         * Build a quota key combining:
         *  – logical bucket name
         *  – authenticated user (if present) or remote IP
         *  – fixed window segment
         */
        private String buildKey(HttpServletRequest request, HandlerMethod hm, RateLimit cfg) {
            String bucket = !cfg.bucket().isEmpty()
                    ? cfg.bucket()
                    : hm.getMethod().getDeclaringClass().getSimpleName() + "#" + hm.getMethod().getName();

            String principal = resolveUserKey(request);
            long window = Instant.now().toEpochMilli() / cfg.unit().toMillis(cfg.timeWindow());
            return "rl:" + bucket + ":" + principal + ":" + window;
        }

        private String resolveUserKey(HttpServletRequest request) {
            Authentication auth = SecurityContextHolder.getContext().getAuthentication();
            if (auth != null && auth.isAuthenticated() && !"anonymousUser".equals(auth.getPrincipal())) {
                return auth.getName();
            }
            return Objects.requireNonNullElse(request.getRemoteAddr(), "unknown");
        }

        private void handleLimitExceeded(HttpServletResponse response, RateLimit settings) throws IOException {
            String msg = String.format(
                    "Rate limit exceeded – allowed %d req / %d %s",
                    settings.permits(), settings.timeWindow(), settings.unit().name().toLowerCase());

            response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
            response.setContentType("application/json");
            response.getWriter().write("{\"error\":\"" + msg + "\"}");
            response.flushBuffer();
            throw new RateLimitExceededException(msg);
        }

        /* -------------------------------------------------------------------------
         *  Local fallback bucket
         * ------------------------------------------------------------------------- */

        /**
         * Minimal fixed-window counter for local fallback.  Keeps Track of the current
         * window segment and resets automatically when the window slides.
         */
        private static final class LocalBucket {

            private final long windowSizeMs;
            private volatile long windowStart;
            private final AtomicLong counter = new AtomicLong(0L);

            LocalBucket(long windowSizeMs) {
                Assert.isTrue(windowSizeMs > 0, "windowSizeMs must be > 0");
                this.windowSizeMs = windowSizeMs;
                this.windowStart = currentWindow();
            }

            long increment() {
                long nowWindow = currentWindow();
                if (nowWindow != windowStart) {
                    synchronized (this) {
                        if (nowWindow != windowStart) {
                            windowStart = nowWindow;
                            counter.set(0L);
                        }
                    }
                }
                return counter.incrementAndGet();
            }

            private long currentWindow() {
                return System.currentTimeMillis() / windowSizeMs;
            }
        }
    }
}
```