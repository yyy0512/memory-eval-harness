package com.circleconnect.nexus.common;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Centralised location for compile–time constants that are referenced across the
 * CircleConnect Nexus code-base. <p/>
 *
 * The class is intentionally <code>final</code> with a private constructor so
 * that it cannot be instantiated or extended. All fields are <code>public
 * static final</code> and therefore inlined by the compiler wherever they are
 * used. <p/>
 *
 * WARNING: <b>DO NOT</b> place tenant / environment-specific values here
 * (secrets, credentials, host names, ports, etc.)—those belong in the external
 * configuration files managed by Spring Boot (e.g. application.yml) or a
 * secrets manager. Constants should remain environment-agnostic.
 */
@SuppressWarnings("unused") // many constants are consumed reflectively
public final class Constants {

    // -------------------------------------------------------------------------
    //  Pagination
    // -------------------------------------------------------------------------

    /** Default number of items returned per page when the client omits a size. */
    public static final int DEFAULT_PAGE_SIZE = 25;

    /** Upper bound for the page size parameter to protect the DB from abuse. */
    public static final int MAX_PAGE_SIZE = 250;

    // -------------------------------------------------------------------------
    //  Timeouts & Durations
    // -------------------------------------------------------------------------

    /** Maximum duration we will block on a downstream I/O request (e.g. Stripe, OAuth provider). */
    public static final Duration EXTERNAL_IO_TIMEOUT = Duration.ofSeconds(12);

    /** How long a login session will be considered valid before renewal is required. */
    public static final Duration SESSION_TTL = Duration.ofHours(12);

    /** Default cache duration for rarely-changing metadata. */
    public static final Duration METADATA_CACHE_TTL = Duration.ofMinutes(10);

    // -------------------------------------------------------------------------
    //  Security
    // -------------------------------------------------------------------------

    /** HTTP header used for Bearer/OAuth2 tokens when used internally. */
    public static final String AUTH_HEADER = "Authorization";

    /** Name of the cookie that stores the signed session token. */
    public static final String SESSION_COOKIE = "ccnx_session";

    /** Length of generated CSRF tokens in bytes (before Base64 encoding). */
    public static final int CSRF_TOKEN_LENGTH = 32;

    /** Roles used by Spring Security and referenced in @PreAuthorize annotations. */
    public static final class Roles {
        public static final String ADMIN  = "ROLE_ADMIN";
        public static final String MEMBER = "ROLE_MEMBER";
        public static final String GUEST  = "ROLE_GUEST";

        private Roles() { /* utility class */ }
    }

    // -------------------------------------------------------------------------
    //  Validation Rules
    // -------------------------------------------------------------------------

    /** Maximum length for a circle name in UTF-8 characters. */
    public static final int CIRCLE_NAME_MAX = 80;

    /** Maximum allowed bytes for a post's body (after UTF-8 encoding). */
    public static final int POST_BODY_MAX_BYTES = 16_384; // 16 KB

    /** Regular expression for a compliant username (cannot start with a number). */
    public static final String USERNAME_REGEX = "^[A-Za-z][A-Za-z0-9_]{2,29}$";

    /** Pre-compiled validation error message map keys. */
    public static final class ValidationMessages {
        public static final String USERNAME_INVALID = "user.username.invalid";
        public static final String PASSWORD_WEAK    = "user.password.weak";
        public static final String EMAIL_INVALID    = "user.email.invalid";

        private ValidationMessages() { /* utility class */ }
    }

    // -------------------------------------------------------------------------
    //  Observability / Logging
    // -------------------------------------------------------------------------

    /** Correlation ID header for request tracing across micro-services. */
    public static final String TRACE_ID_HEADER = "X-Request-Trace-Id";

    /** MDC key used by Logback to propagate trace id across threads. */
    public static final String MDC_TRACE_ID_KEY = "traceId";

    /** List of headers we redact when logging inbound/outbound HTTP. */
    public static final List<String> SENSITIVE_HEADERS =
            Collections.unmodifiableList(List.of("Authorization", "Cookie", "Set-Cookie"));

    // -------------------------------------------------------------------------
    //  Content-Type Shortcuts
    // -------------------------------------------------------------------------

    public static final String APPLICATION_JSON = "application/json";
    public static final String APPLICATION_FORM_URLENCODED = "application/x-www-form-urlencoded";

    // -------------------------------------------------------------------------
    //  Miscellaneous
    // -------------------------------------------------------------------------

    /** Default locale when the client does not send an Accept-Language header. */
    public static final Locale DEFAULT_LOCALE = Locale.US;

    /** Standard application character set—to be used wherever an explicit charset is required. */
    public static final String DEFAULT_CHARSET = StandardCharsets.UTF_8.name();

    /** Prevent accidental instantiation. */
    private Constants() {
        throw new AssertionError("No instances of Constants for you!");
    }
}