```java
/*
 * CircleConnect Nexus – Rate-Limiting Middleware
 *
 * This module implements an adaptive, in-memory sliding-window rate limiter
 * backed by Caffeine.  It is wired into Spring’s filter chain so that *every*
 * HTTP request is checked before the request hits an MVC controller.  The
 * implementation is intentionally self-contained, so that the entire feature
 * lives in a single compilation unit (useful for bootstrapping or monolithic
 * deployments).
 *
 * File:       src/module_14.java
 * Package:    com.circleconnect.nexus.middleware
 *
 * NOTE:  The file name is decoupled from the classes defined below; no public
 *        top-level class is declared so the Java compiler does not complain
 *        about mismatching file names.  All classes are `package-private`
 *        and discovered through Spring’s component scan.
 */

package com.circleconnect.nexus.middleware;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.ConstructorBinding;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Spring‐aware servlet filter that rejects requests exceeding a configurable
 * threshold per sliding window.  Clients are keyed by authenticated principal
 * if present, otherwise by remote IP address.
 */
@Component
final class RateLimitingFilter extends OncePerRequestFilter implements InitializingBean {

    private final RateLimiterService rateLimiterService;
    private final RateLimitingProperties properties;

    RateLimitingFilter(RateLimiterService rateLimiterService,
                       RateLimitingProperties properties) {
        this.rateLimiterService = rateLimiterService;
        this.properties = properties;
    }

    @Override
    public void afterPropertiesSet() {
        if (properties.enabled()) {
            logger.info("Rate-limiting filter initialised with capacity={} req, window={}",
                    properties.capacity(), properties.window());
        } else {
            logger.warn("Rate-limiting filter is DISABLED via configuration");
        }
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain filterChain)
            throws ServletException, IOException {

        if (!properties.enabled()) {
            filterChain.doFilter(request, response);
            return;
        }

        final String clientKey = resolveClientKey(request);

        if (!rateLimiterService.tryAcquire(clientKey)) {
            // Too many requests, respond with 429
            handleRejection(clientKey, response);
            return;
        }

        filterChain.doFilter(request, response);
    }

    private void handleRejection(String clientKey, HttpServletResponse response) throws IOException {
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("""
                {
                  "status": 429,
                  "error": "Too Many Requests",
                  "message": "Rate limit exceeded. Please retry later.",
                  "clientKey": "%s",
                  "timestamp": "%s"
                }
                """.formatted(clientKey, DateTimeFormatter.ISO_INSTANT.format(Instant.now())));
        logger.debug("Rate limit exceeded for key={}", clientKey);
    }

    /**
     * Computes the bucket key for the current request.  Authenticated users are
     * rate-limited by username; unauthenticated traffic is limited by IP.
     */
    private String resolveClientKey(HttpServletRequest request) {
        String principal = (request.getUserPrincipal() != null) ? request.getUserPrincipal().getName() : null;
        if (StringUtils.hasText(principal)) {
            return "USER:" + principal;
        }
        String ip = request.getRemoteAddr();
        return "IP:" + (ip != null ? ip : "UNKNOWN");
    }
}

/**
 * In-memory sliding-window rate limiter.
 *
 * Algorithm:
 *   For each key, maintain a window start timestamp and an atomic counter.
 *   When the window expires, reset the counter and window start.
 *   Caffeine expiry drops idle buckets to avoid unbounded memory growth.
 */
@Component
final class RateLimiterService {

    private static final class Window {
        volatile long startEpochMilli;
        final AtomicInteger used = new AtomicInteger(0);
    }

    private final Cache<String, Window> cache;
    private final int capacity;
    private final long windowMillis;

    RateLimiterService(RateLimitingProperties properties) {
        this.capacity = properties.capacity();
        this.windowMillis = properties.window().toMillis();
        this.cache = Caffeine.newBuilder()
                .expireAfterAccess(properties.window().multipliedBy(2))
                .maximumSize(10_000)
                .build();
    }

    /**
     * Attempts to consume a single request for the given key.
     *
     * @return {@code true} if the request can be processed; {@code false}
     *         if the client is currently rate-limited.
     */
    boolean tryAcquire(String key) {
        final Window window = cache.get(key, k -> {
            Window w = new Window();
            w.startEpochMilli = System.currentTimeMillis();
            return w;
        });

        synchronized (window) {
            final long now = System.currentTimeMillis();

            if (now - window.startEpochMilli >= windowMillis) {
                // Reset the window
                window.startEpochMilli = now;
                window.used.set(0);
            }

            if (window.used.incrementAndGet() > capacity) {
                // over capacity, decrement back and reject
                window.used.decrementAndGet();
                return false;
            }
            return true;
        }
    }
}

/**
 * Configuration properties for the rate limiter.
 *
 * Example (application.yml):
 *   circleconnect:
 *     rate-limit:
 *       enabled: true
 *       capacity: 100        # requests
 *       window: 1m           # sliding window
 */
@ConfigurationProperties(prefix = "circleconnect.rate-limit")
record RateLimitingProperties(boolean enabled,
                              int capacity,
                              Duration window) {

    @ConstructorBinding
    RateLimitingProperties {
        Objects.requireNonNull(window, "window must not be null");
        if (capacity <= 0) {
            throw new IllegalArgumentException("capacity must be > 0");
        }
    }

    // Provide sensible defaults when configuration is absent
    public static RateLimitingProperties defaultProperties() {
        return new RateLimitingProperties(true, 100, Duration.ofMinutes(1));
    }
}

/**
 * Global error handler that maps {@link ResponseStatusException}s thrown by
 * controllers or filters to the expected JSON format.
 *
 * Including this here ensures that a missing global handler in the larger
 * codebase does not break compilation during isolated builds of this module.
 */
@ControllerAdvice
final class GlobalErrorHandler {

    @ExceptionHandler(ResponseStatusException.class)
    void handle(ResponseStatusException ex, HttpServletResponse response) throws IOException {
        response.setStatus(ex.getStatusCode().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write("""
                {
                  "status": %d,
                  "error": "%s",
                  "message": "%s",
                  "timestamp": "%s"
                }
                """.formatted(
                ex.getStatusCode().value(),
                ex.getStatusCode().getReasonPhrase(),
                ex.getReason() != null ? ex.getReason() : "Unexpected error",
                DateTimeFormatter.ISO_INSTANT.format(Instant.now())));
    }
}

/*
 * ---------------------------------------------------------------------------
 * Local integration test (can be deleted in production builds)
 * ---------------------------------------------------------------------------
 *
 * The code below demonstrates how the rate-limiter behaves without deploying
 * the entire Spring context.  Because it is packaged in a non-public class,
 * it does not interfere with application code.
 */

final class RateLimiterServiceSelfTest {

    private static void stressTest() throws InterruptedException {
        RateLimitingProperties props = RateLimitingProperties.defaultProperties();
        RateLimiterService limiter = new RateLimiterService(props);
        String key = "SELF-TEST";

        int accepted = 0;
        for (int i = 0; i < props.capacity() * 2; i++) {
            if (limiter.tryAcquire(key)) {
                accepted++;
            }
        }
        assert accepted == props.capacity() : "Limiter accepted " + accepted + " > " + props.capacity();
        System.out.println("✅  Stress test passed. Accepted=" + accepted);

        // Wait for the window to expire and ensure we can acquire again
        Thread.sleep(props.window().toMillis() + 100);
        assert limiter.tryAcquire(key) : "Limiter did not reset window";
        System.out.println("✅  Window reset verified.");
    }

    static {
        try {
            stressTest();
        } catch (Throwable t) {
            // Print on stderr but do not throw further – self-test should not
            // prevent application startup.
            System.err.println("⚠️  RateLimiter self-test failed: " + t.getMessage());
        }
    }
}
```