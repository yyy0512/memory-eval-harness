package com.edupulse.utils;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.SerializationFeature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Base64;
import java.util.Objects;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * A collection of frequently used, stateless utility helpers that are commonly required across
 * the EduPulse Live Learning Hub code-base.
 *
 * <p>These helpers are intentionally kept dependency-free with the exception of Jackson
 * (already used system-wide) and SLF4J for logging. Whenever possible, prefer using these
 * methods over re-implementing ad-hoc solutions in feature modules.</p>
 */
public final class Utils {

    /* -------------------------------------------------- */
    /* Constants                                           */
    /* -------------------------------------------------- */

    private static final Logger LOG = LoggerFactory.getLogger(Utils.class);

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper()
            .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)
            .setPropertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE);

    private static final SecureRandom SECURE_RANDOM = new SecureRandom();

    private static final DateTimeFormatter ISO_MILLIS_FORMATTER =
            DateTimeFormatter.ISO_INSTANT.withZone(ZoneId.of("UTC"));

    private static final ScheduledExecutorService SCHEDULER =
            Executors.newScheduledThreadPool(
                    Runtime.getRuntime().availableProcessors(),
                    r -> {
                        Thread t = new Thread(r, "edupulse-utils-scheduler");
                        t.setDaemon(true);
                        return t;
                    });

    private static final Pattern EMAIL_REGEX = Pattern.compile(
            "^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$",
            Pattern.CASE_INSENSITIVE);

    /* -------------------------------------------------- */
    /* Constructors                                        */
    /* -------------------------------------------------- */

    private Utils() {
        throw new AssertionError("Utility class should not be instantiated.");
    }

    /* -------------------------------------------------- */
    /* JSON helpers                                        */
    /* -------------------------------------------------- */

    /**
     * Serializes the supplied object to a JSON string using a shared, pre-configured
     * {@link ObjectMapper}. Will not swallow exceptions—callers should handle them
     * appropriately.
     *
     * @param value POJO to serialize
     * @return JSON string
     * @throws JsonProcessingException if serialization fails
     */
    public static String toJson(Object value) throws JsonProcessingException {
        Objects.requireNonNull(value, "value");
        return OBJECT_MAPPER.writeValueAsString(value);
    }

    /**
     * Deserializes a JSON string back into an instance of {@code clazz}.
     *
     * @param json  the JSON payload
     * @param clazz target type
     * @param <T>   type parameter
     * @return deserialized object
     * @throws IOException if deserialization fails
     */
    public static <T> T fromJson(String json, Class<T> clazz) throws IOException {
        Objects.requireNonNull(json, "json");
        Objects.requireNonNull(clazz, "clazz");
        return OBJECT_MAPPER.readValue(json, clazz);
    }

    /* -------------------------------------------------- */
    /* String helpers                                      */
    /* -------------------------------------------------- */

    /**
     * Generates a cryptographically secure, URL-safe random token.
     *
     * @return token string
     */
    public static String generateSecureToken() {
        // 32 random bytes = 256 bits of entropy
        byte[] randomBytes = new byte[32];
        SECURE_RANDOM.nextBytes(randomBytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(randomBytes);
    }

    /**
     * Validates an e-mail address using RFC-5322 light regex. Good enough for UI
     * pre-validation; do not use as sole verification.
     *
     * @param candidate e-mail string
     * @return {@code true} if candidate looks like a valid e-mail
     */
    public static boolean isValidEmail(String candidate) {
        return candidate != null && EMAIL_REGEX.matcher(candidate).matches();
    }

    /**
     * Environment variable helper that gracefully falls back to a default value
     * and logs the decision once.
     *
     * @param key          env variable name
     * @param defaultValue fallback
     * @return resolved value
     */
    public static String env(String key, String defaultValue) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            LOG.info("Environment variable '{}' not set; using default '{}'.", key, defaultValue);
            return defaultValue;
        }
        return value;
    }

    /* -------------------------------------------------- */
    /* Time helpers                                        */
    /* -------------------------------------------------- */

    /**
     * Formats the supplied {@link Instant} in ISO-8601 with millisecond precision.
     *
     * @param instant the instant
     * @return formatted string
     */
    public static String formatInstant(Instant instant) {
        Objects.requireNonNull(instant, "instant");
        return ISO_MILLIS_FORMATTER.format(instant);
    }

    /**
     * Convert a {@link Duration} into a human-readable string (e.g., "4h 32m").
     *
     * @param duration duration
     * @return human readable representation
     */
    public static String humanReadableDuration(Duration duration) {
        Objects.requireNonNull(duration, "duration");
        long seconds = duration.getSeconds();
        long absSeconds = Math.abs(seconds);
        long days = absSeconds / 86_400;
        long hours = (absSeconds % 86_400) / 3_600;
        long minutes = (absSeconds % 3_600) / 60;

        StringBuilder sb = new StringBuilder();
        if (days > 0) sb.append(days).append("d ");
        if (hours > 0 || days > 0) sb.append(hours).append("h ");
        sb.append(minutes).append("m");
        return sb.toString().trim();
    }

    /* -------------------------------------------------- */
    /* Byte helpers                                        */
    /* -------------------------------------------------- */

    /**
     * Converts a byte count into a human-friendly string (e.g., "10.5 MB").
     *
     * @param bytes number of bytes
     * @param si    use SI units (base-10) if {@code true}; otherwise binary (base-2)
     * @return formatted string
     */
    public static String humanReadableByteCount(long bytes, boolean si) {
        int unit = si ? 1000 : 1024;
        if (bytes < unit) return bytes + " B";
        int exp = (int) (Math.log(bytes) / Math.log(unit));
        char pre = (si ? "kMGTPE" : "KMGTPE").charAt(exp - 1);
        String suffix = si ? "" : "i";
        return String.format("%.1f %s%sB", bytes / Math.pow(unit, exp), pre, suffix);
    }

    /* -------------------------------------------------- */
    /* Concurrent helpers                                  */
    /* -------------------------------------------------- */

    /**
     * Executes the supplied task with bounded retries and exponential backoff.
     *
     * @param task        task to execute
     * @param maxAttempts max number of attempts (including first)
     * @param baseDelay   delay before first retry
     * @param logger      caller-supplied logger (can be class specific)
     * @param <T>         return type
     * @return task result
     * @throws Exception if all attempts fail, propagate the final exception
     */
    public static <T> T withRetry(
            Callable<T> task,
            int maxAttempts,
            Duration baseDelay,
            Logger logger) throws Exception {

        Objects.requireNonNull(task, "task");
        Objects.requireNonNull(baseDelay, "baseDelay");
        logger = logger != null ? logger : LOG;

        int attempt = 0;
        long delayMillis = baseDelay.toMillis();

        while (true) {
            try {
                attempt++;
                return task.call();
            } catch (Exception e) {
                if (attempt >= maxAttempts) {
                    logger.error("All {} attempts failed; propagating.", maxAttempts, e);
                    throw e;
                }
                logger.warn("Attempt {} failed: {}. Retrying in {}ms...", attempt, e.getMessage(), delayMillis);
                Thread.sleep(delayMillis);
                delayMillis *= 2; // Exponential backoff
            }
        }
    }

    /**
     * Schedules a task to run after the specified delay using a shared, daemon
     * executor. Useful for low-volume background clean-ups or reminders.
     *
     * @param runnable task
     * @param delay    delay duration
     */
    public static void schedule(Runnable runnable, Duration delay) {
        Objects.requireNonNull(runnable, "runnable");
        Objects.requireNonNull(delay, "delay");
        SCHEDULER.schedule(runnable, delay.toMillis(), TimeUnit.MILLISECONDS);
    }

    /* -------------------------------------------------- */
    /* Resource helpers                                    */
    /* -------------------------------------------------- */

    /**
     * Quietly closes a {@link AutoCloseable} resource, swallowing any
     * {@link Exception} and logging it on debug level. Preferred over try-catch
     * clutter when closing streams in finally blocks.
     *
     * @param closeable resource
     */
    public static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception e) {
            LOG.debug("Exception while closing resource: {}", e.getMessage(), e);
        }
    }

    /* -------------------------------------------------- */
    /* Shutdown hook                                       */
    /* -------------------------------------------------- */

    static {
        // Ensure our scheduler is terminated gracefully
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("Shutting down util scheduler...");
            SCHEDULER.shutdown();
            try {
                if (!SCHEDULER.awaitTermination(5, TimeUnit.SECONDS)) {
                    SCHEDULER.shutdownNow();
                }
            } catch (InterruptedException ex) {
                SCHEDULER.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }, "edupulse-utils-shutdown"));
    }
}