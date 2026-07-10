package com.circleconnect.nexus.middleware;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.lang.NonNull;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Collectors;

/**
 * AdaptiveRateLimitingInterceptor enforces per-identity token–bucket rate limits
 * for every incoming HTTP request. It distinguishes identities by authenticated
 * user name (if present) or by remote IP address.
 *
 * <p>By default, each identity receives {@code defaultCapacity} tokens.  Tokens
 * are replenished at {@code refillPerMinute} every minute.  When the bucket is
 * empty, the request is rejected with HTTP 429 “Too Many Requests” and a
 * Retry-After header indicating the next second the client may retry.</p>
 *
 * <p>Roles defined in {@code circleconnect.rate-limit.skip-roles} are exempt
 * from throttling.</p>
 *
 * Usage:
 *   – Declare the interceptor as a Spring component (done below).
 *   – Register it through {@link RateLimitingConfiguration}.
 *
 * This module purposely lives in its own source file so that controllers and
 * services remain unaware of the implementation details.
 *
 * Thread-safety: internal buckets use CAS to avoid coarse-grained locks.
 */
@Component
public class AdaptiveRateLimitingInterceptor implements HandlerInterceptor, InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(AdaptiveRateLimitingInterceptor.class);

    @Value("${circleconnect.rate-limit.capacity:120}")
    private int defaultCapacity;

    @Value("${circleconnect.rate-limit.refill-per-minute:120}")
    private int refillPerMinute;

    @Value("${circleconnect.rate-limit.skip-roles:ROLE_ADMIN,ROLE_SYSTEM}")
    private String skipRolesProperty;

    private Set<String> skipRoles;

    // Keep up to 100 000 unique keys (IP or username) & purge after 2h of inactivity.
    private Cache<String, TokenBucket> buckets;

    @Override
    public void afterPropertiesSet() {
        this.skipRoles = Arrays.stream(skipRolesProperty.split(","))
                               .map(String::trim)
                               .collect(Collectors.toSet());

        this.buckets = Caffeine.newBuilder()
                               .expireAfterAccess(2, TimeUnit.HOURS)
                               .maximumSize(100_000)
                               .build();

        log.info("Adaptive rate limiter enabled: capacity={} req, refill={} req/min, skippedRoles={}",
                 defaultCapacity, refillPerMinute, skipRoles);
    }

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request,
                             @NonNull HttpServletResponse response,
                             @NonNull Object handler) {

        // Skip non-request thread (e.g. WebSocket handshake) to avoid false negatives.
        if (response.isCommitted()) {
            return true;
        }

        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.isAuthenticated()
            && auth.getAuthorities().stream()
                    .map(GrantedAuthority::getAuthority)
                    .anyMatch(skipRoles::contains)) {
            return true; // privileged role – bypass limiter
        }

        String identity = (auth != null && auth.isAuthenticated())
                          ? auth.getName()                                // logged-in user
                          : request.getRemoteAddr();                      // fallback to IP

        TokenBucket bucket = buckets.get(identity, k ->
                new TokenBucket(defaultCapacity, refillPerMinute));

        if (bucket.tryConsume()) {
            return true;
        }

        long retryAfterSeconds = bucket.secondsUntilNextToken();
        response.setHeader("Retry-After", String.valueOf(retryAfterSeconds));
        response.setStatus(HttpStatus.TOO_MANY_REQUESTS.value());

        if (log.isDebugEnabled()) {
            log.debug("Rate limit exceeded for identity={} path={} retryAfter={}s",
                      identity, request.getRequestURI(), retryAfterSeconds);
        }
        return false; // abort processing chain
    }

    /**
     * Token-bucket implementation with nanosecond precision.
     * Tokens are refilled lazily on each {@link #tryConsume()} call.
     */
    private static final class TokenBucket {
        private final int capacity;
        private final long nanosPerToken;
        private final AtomicInteger tokens;
        private final AtomicLong lastRefillNanos;

        TokenBucket(int capacity, int refillPerMinute) {
            if (capacity <= 0 || refillPerMinute <= 0) {
                throw new IllegalArgumentException("Capacity and refill rate must be positive");
            }
            this.capacity       = capacity;
            this.nanosPerToken  = TimeUnit.MINUTES.toNanos(1) / refillPerMinute;
            this.tokens         = new AtomicInteger(capacity);
            this.lastRefillNanos = new AtomicLong(System.nanoTime());
        }

        /**
         * Attempt to consume one token. Returns true if successful, false otherwise.
         */
        boolean tryConsume() {
            refill(); // make sure state is up-to-date
            while (true) {
                int current = tokens.get();
                if (current == 0) {
                    return false;
                }
                if (tokens.compareAndSet(current, current - 1)) {
                    return true;
                }
            }
        }

        /**
         * Calculates seconds until next token is available. Useful for Retry-After.
         */
        long secondsUntilNextToken() {
            refill();
            if (tokens.get() > 0) {
                return 0;
            }
            long nanosSinceLastRefill = System.nanoTime() - lastRefillNanos.get();
            long nanosUntilNext = nanosPerToken - nanosSinceLastRefill;
            return TimeUnit.NANOSECONDS.toSeconds(Math.max(nanosUntilNext, 0));
        }

        /**
         * Lazily add tokens proportional to elapsed time.
         */
        private void refill() {
            long now = System.nanoTime();
            long last = lastRefillNanos.get();
            long elapsed = now - last;

            if (elapsed < nanosPerToken) {
                return; // not enough time for a full token
            }

            long tokensToAdd = elapsed / nanosPerToken;
            if (tokensToAdd == 0) {
                return;
            }

            if (lastRefillNanos.compareAndSet(last, last + tokensToAdd * nanosPerToken)) {
                // Prevent overflow: clamp to capacity
                int updated;
                int current;
                do {
                    current  = tokens.get();
                    updated  = (int) Math.min(capacity, current + tokensToAdd);
                } while (!tokens.compareAndSet(current, updated));
            }
        }
    }
}

/**
 * Auto-registers {@link AdaptiveRateLimitingInterceptor} for every request path.
 * Making the class package-private avoids polluting the public API; Spring can
 * still discover it via component-scanning.
 */
@Configuration
class RateLimitingConfiguration implements WebMvcConfigurer {

    private final AdaptiveRateLimitingInterceptor interceptor;

    RateLimitingConfiguration(AdaptiveRateLimitingInterceptor interceptor) {
        this.interceptor = interceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(interceptor)
                .addPathPatterns("/**")           // apply to all HTTP endpoints
                .order(-100);                     // high precedence, but keep space for auth filters
    }
}