```java
package com.circleconnect.nexus.middleware;

import io.github.bucket4j.Bandwidth;
import io.github.bucket4j.Bucket;
import io.github.bucket4j.Refill;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.util.AntPathMatcher;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Production–grade request-rate limiter filter leveraging Bucket4j.
 * <p>
 * The filter enforces an IP/user based token-bucket algorithm on every HTTP request
 * before the request reaches Spring MVC. The goal is to prevent abuse, brute-force logins,
 * DoS attacks, and to provide a configurable QoS envelope for CircleConnect Nexus.
 * <p>
 * Configuration is sourced from {@code application.yml} / {@code application.properties} using
 * the prefix {@code circleconnect.ratelimit.*}. Any path patterns marked as exempt will pass
 * through un-throttled (ex. health checks, static assets).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
@EnableConfigurationProperties(Module11RateLimitingFilter.RateLimitProperties.class)
public class Module11RateLimitingFilter extends OncePerRequestFilter implements InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(Module11RateLimitingFilter.class);
    private static final String JSON_429 = """
            {
              "timestamp" : "%s",
              "status"    : 429,
              "error"     : "Too Many Requests",
              "message"   : "You have exhausted your request quota. Please try again later."
            }
            """;

    private final RateLimitProperties properties;
    private final ConcurrentMap<String, Bucket> bucketCache = new ConcurrentHashMap<>();
    private final AntPathMatcher pathMatcher = new AntPathMatcher();

    public Module11RateLimitingFilter(RateLimitProperties properties) {
        this.properties = properties;
    }

    @Override
    public void afterPropertiesSet() {
        log.info("Rate-limiting filter initialized: capacity={} tokens, refill={} every {}s, exemptedPaths={}",
                 properties.capacity,
                 properties.refillTokens,
                 properties.refillDuration.getSeconds(),
                 properties.exemptPaths);
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        // Skip filter on OPTIONS requests (CORS pre-flight) and configured exempt paths
        return "OPTIONS".equalsIgnoreCase(request.getMethod()) ||
                properties.exemptPaths.stream().anyMatch(pattern -> pathMatcher.match(pattern, path));
    }

    @Override
    protected void doFilterInternal(@NonNull HttpServletRequest request,
                                    @NonNull HttpServletResponse response,
                                    @NonNull FilterChain filterChain)
            throws ServletException, IOException {

        String key = resolveKey(request);
        Bucket bucket = bucketCache.computeIfAbsent(key, this::createNewBucket);

        if (bucket.tryConsume(1)) {
            filterChain.doFilter(request, response);
        } else {
            handleRateLimitExceeded(response, key);
        }
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    private Bucket createNewBucket(String key) {
        Refill refill = Refill.intervally(properties.refillTokens, properties.refillDuration);
        Bandwidth limit = Bandwidth.classic(properties.capacity, refill).withInitialTokens(properties.capacity);
        log.debug("Created new rate-limit bucket for key={}", key);
        return Bucket.builder()
                     .addLimit(limit)
                     .build();
    }

    /**
     * Generates a cache key for the current request.
     * Prefers authenticated user principal, falls back to remote IP address.
     */
    private String resolveKey(HttpServletRequest request) {
        String user = Objects.toString(request.getUserPrincipal(), null);
        if (user != null) {
            return "USER_" + user;
        }
        String ip = extractClientIp(request);
        return "IP_" + ip;
    }

    /**
     * Attempts to extract the originating IP address in the presence of reverse proxies
     * (AWS ALB, Nginx, Cloudflare, etc.). Falls back to the servlet container’s remote
     * address if headers are absent.
     */
    private String extractClientIp(HttpServletRequest request) {
        String header = request.getHeader("X-Forwarded-For");
        if (header != null && !header.isBlank()) {
            // First IP in the list is the original client
            int comma = header.indexOf(',');
            return comma > 0 ? header.substring(0, comma).trim() : header.trim();
        }
        return request.getRemoteAddr();
    }

    private void handleRateLimitExceeded(HttpServletResponse response, String key) throws IOException {
        log.warn("Rate-limit exceeded for key={}", key);
        response.setStatus(HttpServletResponse.SC_TOO_MANY_REQUESTS);
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.getWriter().write(JSON_429.formatted(OffsetDateTime.now()));
        response.getWriter().flush();
    }

    // ------------------------------------------------------------------------
    // Configuration Properties
    // ------------------------------------------------------------------------

    /**
     * Serializable POJO bound to {@code circleconnect.ratelimit.*} properties.
     * <p>
     * Example YAML:
     * <pre>
     * circleconnect:
     *   ratelimit:
     *     capacity: 120            # bucket capacity
     *     refillTokens: 120        # number of tokens to add per interval
     *     refillDuration: 60s      # interval length
     *     exemptPaths:             # Ant style patterns
     *       - /actuator/**
     *       - /static/**
     * </pre>
     */
    @ConfigurationProperties(prefix = "circleconnect.ratelimit")
    public static class RateLimitProperties {
        /**
         * Maximum tokens per bucket (burst capacity).
         */
        private int capacity = 100;

        /**
         * Tokens to add each refill cycle.
         */
        private int refillTokens = 100;

        /**
         * Refill cadence (e.g. 1 minute).
         */
        private Duration refillDuration = Duration.ofMinutes(1);

        /**
         * Request path patterns that bypass rate limiting.
         */
        private List<String> exemptPaths = Collections.emptyList();

        // getters & setters for Spring binding

        public int getCapacity() {
            return capacity;
        }

        public void setCapacity(int capacity) {
            this.capacity = capacity;
        }

        public int getRefillTokens() {
            return refillTokens;
        }

        public void setRefillTokens(int refillTokens) {
            this.refillTokens = refillTokens;
        }

        public Duration getRefillDuration() {
            return refillDuration;
        }

        public void setRefillDuration(Duration refillDuration) {
            this.refillDuration = refillDuration;
        }

        public List<String> getExemptPaths() {
            return exemptPaths;
        }

        public void setExemptPaths(List<String> exemptPaths) {
            this.exemptPaths = exemptPaths;
        }
    }
}
```