package com.circleconnect.nexus.util;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.owasp.html.PolicyFactory;
import org.owasp.html.Sanitizers;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.text.Normalizer.Form;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Locale;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * A collection of common utilities used across the CircleConnect Nexus code-base.
 * All methods are stateless and thread-safe.
 */
public final class Utils {

    private static final Logger log = LoggerFactory.getLogger(Utils.class);

    /* -----------------------------  General Constants  ------------------------------ */
    public static final int DEFAULT_PAGE_SIZE = 20;
    public static final int MAX_PAGE_SIZE = 100;
    private static final String CORRELATION_ID_KEY = "correlationId";

    /* -----------------------------  JSON (Jackson)  --------------------------------- */
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    /* -----------------------------  Sanitization  ----------------------------------- */
    // A reasonably permissive HTML sanitizer for user-generated content.
    private static final PolicyFactory HTML_POLICY = Sanitizers.BLOCKS
            .and(Sanitizers.FORMATTING)
            .and(Sanitizers.IMAGES)
            .and(Sanitizers.LINKS);

    /* -----------------------------  Slug generation  -------------------------------- */
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern NONLATIN = Pattern.compile("[^\\w\\-]");

    /* -----------------------------  Token generation  ------------------------------- */
    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    /* -----------------------------  Date / Time  ------------------------------------ */
    private static final DateTimeFormatter ISO_OFFSET_DATE_TIME = DateTimeFormatter.ISO_OFFSET_DATE_TIME;

    private Utils() {
        // utility class
    }

    /* ============================================================================== */
    /* == JSON ====================================================================== */
    /* ============================================================================== */

    /**
     * Serializes the given object to a compact JSON string.
     *
     * @param obj the object to serialize
     * @return JSON representation
     * @throws IllegalArgumentException if serialization fails
     */
    public static String toJson(Object obj) {
        try {
            return OBJECT_MAPPER.writeValueAsString(obj);
        } catch (JsonProcessingException ex) {
            log.error("Unable to serialize object of type {}", obj.getClass().getName(), ex);
            throw new IllegalArgumentException("Failed to serialize object", ex);
        }
    }

    /**
     * Deserializes JSON into the given target class.
     *
     * @param json       the JSON string
     * @param targetType destination class
     * @param <T>        generic type
     * @return deserialized object
     * @throws IllegalArgumentException if deserialization fails
     */
    public static <T> T fromJson(String json, Class<T> targetType) {
        try {
            return OBJECT_MAPPER.readValue(json, targetType);
        } catch (JsonProcessingException ex) {
            log.error("Unable to deserialize json to type {}", targetType.getName(), ex);
            throw new IllegalArgumentException("Failed to deserialize json", ex);
        }
    }

    /* ============================================================================== */
    /* == Pagination ================================================================ */
    /* ============================================================================== */

    /**
     * Builds a {@link Pageable} object while enforcing sane defaults and upper bounds.
     * <p>
     * Spring MVC controllers are encouraged to delegate request parameter parsing
     * to this helper to prevent accidental DoS vectors through very large page sizes.
     *
     * @param page zero-based page index, may be {@code null}
     * @param size requested page size, may be {@code null}
     * @param sort Spring {@link Sort} definition, may be {@code null}
     * @return a non-null {@link Pageable}
     */
    public static Pageable buildPageRequest(Integer page, Integer size, Sort sort) {
        int pg = Optional.ofNullable(page).filter(p -> p >= 0).orElse(0);
        int sz = Optional.ofNullable(size)
                .filter(s -> s > 0)
                .map(s -> Math.min(s, MAX_PAGE_SIZE))
                .orElse(DEFAULT_PAGE_SIZE);

        return PageRequest.of(pg, sz, sort == null ? Sort.unsorted() : sort);
    }

    /* ============================================================================== */
    /* == Slug / URL-safe strings =================================================== */
    /* ============================================================================== */

    /**
     * Converts arbitrary input into a URL-friendly slug.
     * Example: "Café & Bistro – Specials" -> "cafe-bistro-specials"
     *
     * @param input raw input
     * @return slugified string, never {@code null}
     */
    public static String slugify(String input) {
        if (input == null || input.isBlank()) {
            return "";
        }
        String trimmed = input.trim();
        String nowhitespace = WHITESPACE.matcher(trimmed).replaceAll("-");
        String normalized = Normalizer.normalize(nowhitespace, Form.NFD);
        String slug = NONLATIN.matcher(normalized).replaceAll("");
        slug = slug.toLowerCase(Locale.ENGLISH);
        slug = slug.replaceAll("-{2,}", "-");     // collapse duplicate '-'
        return slug.replaceAll("^-|-$", "");      // trim leading/trailing '-'
    }

    /* ============================================================================== */
    /* == Security / Tokens ========================================================= */
    /* ============================================================================== */

    /**
     * Generates a cryptographically secure random token encoded with
     * URL-safe Base64 (no padding).
     *
     * @param byteLength the number of random bytes before encoding
     * @return token string
     */
    public static String generateSecureToken(int byteLength) {
        if (byteLength <= 0) {
            throw new IllegalArgumentException("byteLength must be greater than 0");
        }
        byte[] randomBytes = new byte[byteLength];
        SECURE_RANDOM.nextBytes(randomBytes);
        return Base64.getUrlEncoder()
                     .withoutPadding()
                     .encodeToString(randomBytes);
    }

    /* ============================================================================== */
    /* == Sanitization ============================================================== */
    /* ============================================================================== */

    /**
     * Sanitizes the supplied HTML using a curated OWASP policy. Intended for
     * user-generated content such as circle descriptions or post bodies.
     *
     * @param unsafeHtml possibly unsafe HTML
     * @return sanitized HTML safe for storage / rendering
     */
    public static String sanitizeHtml(String unsafeHtml) {
        if (unsafeHtml == null) {
            return null;
        }
        return HTML_POLICY.sanitize(unsafeHtml);
    }

    /* ============================================================================== */
    /* == Date / Time ============================================================== */
    /* ============================================================================== */

    /**
     * Formats the given {@link OffsetDateTime} as an ISO-8601 string.
     */
    public static String formatIso(OffsetDateTime time) {
        return Optional.ofNullable(time)
                       .map(ISO_OFFSET_DATE_TIME::format)
                       .orElse(null);
    }

    /**
     * Parses an ISO-8601 string into {@link OffsetDateTime}.
     *
     * @throws IllegalArgumentException if parsing fails
     */
    public static OffsetDateTime parseIso(String isoString) {
        try {
            return OffsetDateTime.parse(isoString, ISO_OFFSET_DATE_TIME);
        } catch (Exception ex) {
            log.warn("Unable to parse ISO date time '{}'", isoString);
            throw new IllegalArgumentException("Invalid ISO date string", ex);
        }
    }

    /* ============================================================================== */
    /* == Correlation Id ============================================================ */
    /* ============================================================================== */

    /**
     * Retrieves the correlation id associated with the current thread/request,
     * generating one if absent. Controllers and service layers should include
     * this id in log statements to ease distributed tracing.
     */
    public static String ensureCorrelationId() {
        String id = MDC.get(CORRELATION_ID_KEY);
        if (id == null) {
            id = generateSecureToken(16);
            MDC.put(CORRELATION_ID_KEY, id);
        }
        return id;
    }

    /**
     * Clears the correlation id from {@link MDC}. Should be called at the end
     * of a request to avoid memory leaks when using thread pools.
     */
    public static void clearCorrelationId() {
        MDC.remove(CORRELATION_ID_KEY);
    }

    /* ============================================================================== */
    /* == Misc ====================================================================== */
    /* ============================================================================== */

    /**
     * Performs a constant-time comparison of two byte arrays to mitigate timing attacks.
     */
    public static boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a == null || b == null) {
            return false;
        }
        if (a.length != b.length) {
            return false;
        }
        int result = 0;
        for (int i = 0; i < a.length; i++) {
            result |= a[i] ^ b[i];
        }
        return result == 0;
    }

    /**
     * Converts the given string to UTF-8 bytes. Provided for convenience when
     * interacting with cryptographic or IO libraries.
     */
    public static byte[] utf8(String s) {
        return s == null ? null : s.getBytes(StandardCharsets.UTF_8);
    }
}