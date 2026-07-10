```java
package com.circleconnect.nexus.config;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.SerializationFeature;
import io.github.resilience4j.ratelimiter.RateLimiter;
import io.github.resilience4j.ratelimiter.RateLimiterConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.core.Ordered;
import org.springframework.http.HttpMethod;
import org.springframework.lang.NonNull;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.filter.OncePerRequestFilter;

import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.validation.constraints.Max;
import javax.validation.constraints.Min;
import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.TimeUnit;

/**
 * NexusConfig wires together cross–cutting infrastructure concerns such as:
 *  • Password encoding
 *  • Shared RestTemplate
 *  • API-wide rate limiting
 *  • Stripe client bootstrapping
 *  • Jackson customisation
 *  • Servlet request logging
 *
 * All overridable knobs are exposed via strongly-typed
 * {@code @ConfigurationProperties} to make them environment-agnostic and
 * friendly to Spring Cloud Config or Kubernetes ConfigMaps.
 */
@Configuration
@EnableConfigurationProperties({
        NexusConfig.OAuth2ProviderProperties.class,
        NexusConfig.StripeProperties.class,
        NexusConfig.RateLimitingProperties.class,
        NexusConfig.LoggingProperties.class
})
public class NexusConfig {

    private static final Logger log = LoggerFactory.getLogger(NexusConfig.class);

    /* ------------------------------------------------------------------------
     *  General infrastructure beans
     * --------------------------------------------------------------------- */

    @Bean
    public PasswordEncoder passwordEncoder() {
        return new BCryptPasswordEncoder();
    }

    @Bean
    public RestTemplate restTemplate(RestTemplateBuilder builder) {
        return builder
                .setConnectTimeout(Duration.ofSeconds(5))
                .setReadTimeout(Duration.ofSeconds(5))
                .build();
    }

    /* ------------------------------------------------------------------------
     *  Stripe integration
     * --------------------------------------------------------------------- */

    @Bean
    public StripeClient stripeClient(StripeProperties props) {
        log.info("Initialising Stripe client — mode: {}", props.isMock() ? "MOCK" : "LIVE");
        if (props.isMock()) {
            return new MockStripeClient();
        }
        return new DefaultStripeClient(props.getApiKey(), props.getWebhookSecret());
    }

    /* ------------------------------------------------------------------------
     *  Global rate limiter — backed by Resilience4j
     * --------------------------------------------------------------------- */

    @Bean
    public RateLimiter apiRateLimiter(RateLimitingProperties props) {
        RateLimiterConfig config = RateLimiterConfig.custom()
                .limitForPeriod(props.getRequests())
                .limitRefreshPeriod(props.getRefreshPeriod())
                .timeoutDuration(props.getTimeout())
                .build();
        return RateLimiter.of("global-api", config);
    }

    /* ------------------------------------------------------------------------
     *  Security filter chain
     * --------------------------------------------------------------------- */

    @Bean
    public SecurityFilterChain filterChain(HttpSecurity http,
                                           RateLimiter apiRateLimiter) throws Exception {

        http
            /* HTTPS everywhere */
            .requiresChannel(channel -> channel.anyRequest().requiresSecure())

            /* Session & CSRF */
            .csrf(csrf -> csrf.ignoringRequestMatchers("/api/v*/public/**"))
            .sessionManagement(s -> s
                    .maximumSessions(10)
                    .maxSessionsPreventsLogin(false))

            /* Authorisation */
            .authorizeHttpRequests(auth -> auth
                    .requestMatchers(HttpMethod.GET, "/", "/favicon.ico", "/assets/**").permitAll()
                    .requestMatchers("/admin/**").hasRole("ADMIN")
                    .anyRequest().authenticated())

            /* OAuth2 social login */
            .oauth2Login(Customizer.withDefaults())

            /* Rate-limiting */
            .addFilterBefore(new RateLimitingFilter(apiRateLimiter),
                    UsernamePasswordAuthenticationFilter.class);

        return http.build();
    }

    /* ------------------------------------------------------------------------
     *  Jackson – snake-case + sensible defaults
     * --------------------------------------------------------------------- */

    @Bean
    @Primary
    public ObjectMapper objectMapper() {
        return new ObjectMapper()
                .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
                .setSerializationInclusion(JsonInclude.Include.NON_NULL)
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }

    /* ------------------------------------------------------------------------
     *  Servlet request logging
     * --------------------------------------------------------------------- */

    @Bean
    public FilterRegistrationBean<RequestLoggingFilter> loggingFilter(LoggingProperties props) {
        FilterRegistrationBean<RequestLoggingFilter> bean = new FilterRegistrationBean<>();
        RequestLoggingFilter filter = new RequestLoggingFilter(props);
        bean.setFilter(filter);
        bean.setOrder(Ordered.LOWEST_PRECEDENCE);
        return bean;
    }

    /* ======================================================================
     *  Property classes
     * ==================================================================== */

    /**
     * Exposes OAuth2 provider-specific tweaks (if any are needed in future).
     */
    @Validated
    @ConfigurationProperties(prefix = "nexus.oauth2")
    public static class OAuth2ProviderProperties {
        /** Placeholder to demonstrate strongly-typed config. */
        @NotBlank
        private String defaultProvider = "google";

        public String getDefaultProvider() {
            return defaultProvider;
        }

        public void setDefaultProvider(String defaultProvider) {
            this.defaultProvider = defaultProvider;
        }
    }

    /**
     * Stripe API keys and toggle for mock mode.
     */
    @Validated
    @ConfigurationProperties(prefix = "nexus.stripe")
    public static class StripeProperties {
        @NotBlank
        private String apiKey = "dummy";
        @NotBlank
        private String webhookSecret = "dummy";
        private boolean mock = true;

        public String getApiKey() { return apiKey; }
        public void setApiKey(String apiKey) { this.apiKey = apiKey; }

        public String getWebhookSecret() { return webhookSecret; }
        public void setWebhookSecret(String webhookSecret) { this.webhookSecret = webhookSecret; }

        public boolean isMock() { return mock; }
        public void setMock(boolean mock) { this.mock = mock; }
    }

    /**
     * Simple token-bucket style limiter exposed to infra.
     */
    @Validated
    @ConfigurationProperties(prefix = "nexus.rate-limit")
    public static class RateLimitingProperties {
        @Min(1) @Max(10_000)
        private int requests = 100;

        @NotNull
        private Duration refreshPeriod = Duration.ofSeconds(60);

        @NotNull
        private Duration timeout = Duration.ofSeconds(2);

        public int getRequests() { return requests; }
        public void setRequests(int requests) { this.requests = requests; }

        public Duration getRefreshPeriod() { return refreshPeriod; }
        public void setRefreshPeriod(Duration refreshPeriod) { this.refreshPeriod = refreshPeriod; }

        public Duration getTimeout() { return timeout; }
        public void setTimeout(Duration timeout) { this.timeout = timeout; }
    }

    /**
     * Configures HTTP request logging granularity.
     */
    @Validated
    @ConfigurationProperties(prefix = "nexus.logging")
    public static class LoggingProperties {
        private boolean includePayload = false;
        private int maxPayloadLength = 1024;

        public boolean isIncludePayload() { return includePayload; }
        public void setIncludePayload(boolean includePayload) { this.includePayload = includePayload; }

        public int getMaxPayloadLength() { return maxPayloadLength; }
        public void setMaxPayloadLength(int maxPayloadLength) { this.maxPayloadLength = maxPayloadLength; }
    }

    /* ======================================================================
     *  Private helper components
     * ==================================================================== */

    /**
     * Spring Security filter that delegates to Resilience4j’s {@link RateLimiter}.
     * If the request cannot acquire a permit within {@code timeout}, the client
     * receives HTTP 429.
     */
    private static final class RateLimitingFilter extends OncePerRequestFilter {

        private final RateLimiter limiter;

        RateLimitingFilter(RateLimiter limiter) {
            this.limiter = limiter;
        }

        @Override
        protected void doFilterInternal(@NonNull HttpServletRequest req,
                                        @NonNull HttpServletResponse res,
                                        @NonNull FilterChain chain)
                throws ServletException, IOException {

            boolean granted = limiter.acquirePermission(Duration.ZERO);
            if (!granted) {
                res.sendError(HttpServletResponse.SC_TOO_MANY_REQUESTS, "Rate limit exceeded");
                return;
            }

            long startNanos = System.nanoTime();
            try {
                chain.doFilter(req, res);
            } finally {
                long durationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
                limiter.onResult(durationMs, java.util.concurrent.TimeUnit.MILLISECONDS, res.getStatus());
            }
        }
    }

    /**
     * Simple servlet request logging filter used instead of CommonsRequestLoggingFilter
     * for tighter control over payload size.
     */
    private static final class RequestLoggingFilter extends OncePerRequestFilter {

        private final LoggingProperties props;
        private final Logger reqLog = LoggerFactory.getLogger("NEXUS_HTTP_REQ");

        RequestLoggingFilter(LoggingProperties props) {
            this.props = props;
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request,
                                        HttpServletResponse response,
                                        FilterChain filterChain)
                throws ServletException, IOException {

            if (reqLog.isInfoEnabled()) {
                reqLog.info("[{}] {} {}",
                        request.getMethod(),
                        request.getRequestURI(),
                        request.getQueryString() == null ? "" : "?" + request.getQueryString());
            }

            filterChain.doFilter(request, response);
        }
    }

    /* ======================================================================
     *  Placeholder Stripe client abstractions — thin wrappers so that the
     *  remainder of the codebase can inject StripeClient without dealing
     *  with the actual SDK in unit tests.
     * ==================================================================== */

    public interface StripeClient {
        /**
         * Sends a charge request to Stripe.
         *
         * @param amount   amount in the smallest currency unit (e.g. cents)
         * @param currency ISO-4217 currency code
         * @param source   payment source token
         */
        void charge(int amount, String currency, String source) throws StripeException;
    }

    public static final class DefaultStripeClient implements StripeClient {

        private final String apiKey;
        private final String webhookSecret;

        DefaultStripeClient(String apiKey, String webhookSecret) {
            this.apiKey = apiKey;
            this.webhookSecret = webhookSecret;
        }

        @Override
        public void charge(int amount, String currency, String source) throws StripeException {
            // In real life, delegate to Stripe SDK:
            // Stripe.apiKey = apiKey;
            // Charge.create(params, RequestOptions.getDefault());
            log.debug("Charging {} {} to source {} (live)", amount, currency, source);
        }
    }

    public static final class MockStripeClient implements StripeClient {
        @Override
        public void charge(int amount, String currency, String source) {
            log.debug("Simulated charge of {} {} to source {} (mock)", amount, currency, source);
        }
    }

    /**
     * Soft-checked exception used when Stripe operations fail.
     */
    public static class StripeException extends Exception {
        public StripeException(String message, Throwable cause) { super(message, cause); }
        public StripeException(String message) { super(message); }
    }
}
```