```java
package com.edupulse.shared;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Centralised location for application-wide constants.
 *
 * <p>These constants are intentionally grouped by responsibility to avoid
 * a single “mega‐class” of unrelated values.  The class is final and has a
 * private constructor to guarantee non-instantiability and thread-safety.</p>
 *
 * <p>Whenever possible, use the provided helper methods (e.g. {@link #env(String, String)})
 * instead of direct environment look-ups so defaults are explicit and testable.</p>
 *
 * <p>NOTE: Constants that are specific to a single bounded context or micro-service
 * should live closer to that context. Only truly cross-cutting values belong here.</p>
 *
 * @author  EduPulse Engineering
 */
public final class Constants {

    // ------------------------------------------------------------------------
    //  General Application
    // ------------------------------------------------------------------------

    public static final String APPLICATION_NAME = "EduPulse Live Learning Hub";
    public static final String APPLICATION_VERSION = "1.3.0";      // Updated at CI
    public static final String DEFAULT_LOCALE    = Locale.US.toLanguageTag();

    // ------------------------------------------------------------------------
    //  HTTP / API
    // ------------------------------------------------------------------------

    public static final class Http {
        private Http() {}

        public static final String HEADER_CORRELATION_ID = "X-Correlation-ID";
        public static final String HEADER_REQUEST_ID     = "X-Request-ID";
        public static final String HEADER_AUTH_TOKEN     = "Authorization";
        public static final String MIME_JSON             = "application/json";
        public static final String MIME_PDF              = "application/pdf";

        // Pagination
        public static final int DEFAULT_PAGE_SIZE = 20;
        public static final int MAX_PAGE_SIZE     = 100;
    }

    // ------------------------------------------------------------------------
    //  Authentication / Security
    // ------------------------------------------------------------------------

    public static final class Security {
        private Security() {}

        public static final String TOKEN_ISSUER    = "edupulse.io";
        public static final String TOKEN_AUDIENCE  = "edupulse-users";
        public static final Duration TOKEN_TTL     = Duration.ofHours(12);

        public static final String[] PUBLIC_ENDPOINTS = {
                "/v1/auth/**",
                "/v1/pulse/public/**",
                "/health",
                "/actuator/**"
        };

        public static final List<String> DEFAULT_ROLES = List.of("ROLE_STUDENT");

        public static final int BCRYPT_STRENGTH = 12;
    }

    // ------------------------------------------------------------------------
    //  File Upload
    // ------------------------------------------------------------------------

    public static final class FileUpload {
        private FileUpload() {}

        public static final long  MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;     // 50 MB
        public static final Set<String> IMAGE_TYPES   = Set.of("image/jpeg", "image/png", "image/gif");
        public static final Set<String> DOC_TYPES     = Set.of("application/pdf",
                                                               "application/msword",
                                                               "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

        public static final Path TEMP_DIR = Paths.get(
                env("EDUPULSE_UPLOAD_TMP", System.getProperty("java.io.tmpdir"), true)
        );
    }

    // ------------------------------------------------------------------------
    //  Email
    // ------------------------------------------------------------------------

    public static final class Email {
        private Email() {}

        public static final String DEFAULT_FROM        = "no-reply@edupulse.io";
        public static final String SUPPORT_ALIAS       = "support@edupulse.io";
        public static final String REPLY_TO            = "noreply@edupulse.io";
        public static final Duration VERIFICATION_TTL  = Duration.ofHours(24);

        // Templating placeholders
        public static final String PLACEHOLDER_USERNAME    = "{{username}}";
        public static final String PLACEHOLDER_VERIFY_LINK = "{{verify_link}}";
    }

    // ------------------------------------------------------------------------
    //  Event-Driven Constants
    // ------------------------------------------------------------------------

    public static final class Events {
        private Events() {}

        // Domain Event Names
        public static final String PULSE_CREATED             = "pulse.created";
        public static final String PULSE_REACTED             = "pulse.reacted";
        public static final String QUIZ_SUBMITTED            = "quiz.submitted";
        public static final String ASSIGNMENT_UPLOADED       = "assignment.uploaded";
        public static final String PREMIUM_PAYMENT_COMPLETED = "payment.premium.completed";
        public static final String BADGE_AWARDED             = "badge.awarded";

        // Message Broker Configuration
        public static final String EXCHANGE_EDU_CORE   = "edu.core.exchange";
        public static final String QUEUE_NOTIFICATIONS = "queue.notifications";
        public static final String QUEUE_ANALYTICS     = "queue.analytics";
        public static final String QUEUE_EMAIL         = "queue.email";
        public static final String ROUTING_KEY_ALL     = "#";
    }

    // ------------------------------------------------------------------------
    //  Caching
    // ------------------------------------------------------------------------

    public static final class Cache {
        private Cache() {}

        public static final String USER_PROFILE     = "cache.user.profile";
        public static final String COURSE_CATALOG   = "cache.course.catalog";
        public static final Duration DEFAULT_TTL    = Duration.ofMinutes(30);
    }

    // ------------------------------------------------------------------------
    //  Database
    // ------------------------------------------------------------------------

    public static final class Database {
        private Database() {}

        // Names of persistence units / data sources
        public static final String WRITE_DATASOURCE = "edupulse_primary_ds";
        public static final String READ_DATASOURCE  = "edupulse_replica_ds";

        // Connection pool defaults
        public static final int    DEFAULT_POOL_SIZE = 15;
        public static final int    MAX_POOL_SIZE     = 50;
        public static final long   CONNECTION_TIMEOUT_MS = 10_000L;
    }

    // ------------------------------------------------------------------------
    //  Logging
    // ------------------------------------------------------------------------

    public static final class Logging {
        private Logging() {}

        public static final String MDC_REQUEST_ID   = "requestId";
        public static final String MDC_USER_ID      = "userId";
        public static final String MDC_SESSION_ID   = "sessionId";

        // Log categories
        public static final String CATEGORY_SECURITY   = "com.edupulse.security";
        public static final String CATEGORY_CONTROLLER = "com.edupulse.api";
        public static final String CATEGORY_SERVICE    = "com.edupulse.service";
        public static final String CATEGORY_REPOSITORY = "com.edupulse.repository";
    }

    // ------------------------------------------------------------------------
    //  Helper Methods
    // ------------------------------------------------------------------------

    /**
     * Returns the value of an environment variable, or a default value if not present.
     *
     * @param key          name of the environment variable
     * @param defaultValue fallback if the variable is not set
     * @return env value or {@code defaultValue}
     */
    public static String env(String key, String defaultValue) {
        return env(key, defaultValue, false);
    }

    /**
     * Returns the value of an environment variable, optionally throwing an exception if missing.
     *
     * @param key          name of the env variable
     * @param defaultValue fallback used when {@code mandatory} is {@code false}
     * @param mandatory    whether the variable must be present
     * @return env value, never {@code null}
     * @throws IllegalStateException if {@code mandatory} is true and the variable is not set
     */
    public static String env(String key, String defaultValue, boolean mandatory) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            if (mandatory) {
                throw new IllegalStateException(
                        String.format("Required environment variable '%s' is not set.", key)
                );
            }
            value = defaultValue;
        }
        return value;
    }

    /**
     * Attempts to parse an integer from the environment, returning a default if absent or invalid.
     *
     * @param key          env variable name
     * @param defaultValue value returned when env var missing or malformed
     */
    public static int envInt(String key, int defaultValue) {
        String val = System.getenv(key);
        if (val == null) {
            return defaultValue;
        }
        try {
            return Integer.parseInt(val.trim());
        } catch (NumberFormatException ex) {
            return defaultValue;
        }
    }

    /**
     * Converts a map of headers to a lower-cased map for case-insensitive lookup.
     *
     * @param headers original headers
     * @return new immutable map with lower-cased keys
     */
    public static Map<String, String> normalizeHeaders(Map<String, String> headers) {
        return headers.entrySet()
                      .stream()
                      .collect(java.util.stream.Collectors.toUnmodifiableMap(
                              e -> e.getKey().toLowerCase(Locale.ROOT),
                              Map.Entry::getValue
                      ));
    }

    // Prevent instantiation
    private Constants() { }
}
```