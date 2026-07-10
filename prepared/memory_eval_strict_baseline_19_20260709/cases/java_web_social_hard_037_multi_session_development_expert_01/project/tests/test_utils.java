package com.circleconnectnexus.tests.util;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.SignatureAlgorithm;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.Assertions;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.MediaType;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.Key;
import java.time.Instant;
import java.util.Date;
import java.util.Random;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * Centralized helper utilities shared by unit and integration tests.
 * <p>
 * The class intentionally lives under {@code src/test/java} and MUST NOT be
 * referenced by production source sets.
 */
public final class TestUtils {

    /* -------------------------------------------------------------------------
     * Jackson configuration
     * ---------------------------------------------------------------------- */
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    /* -------------------------------------------------------------------------
     * TestContainers – single shared PostgreSQL instance for ITs
     * ---------------------------------------------------------------------- */
    private static final DockerImageName POSTGRES_IMAGE = DockerImageName.parse("postgres:15-alpine");

    /**
     * Singleton container which is automatically started the first time the
     * class is loaded. All integration tests will point their Spring
     * {@code spring.datasource.*} configuration to this container.
     */
    @SuppressWarnings("resource") // container is closed by JVM shutdown hook
    public static final PostgreSQLContainer<?> POSTGRESQL = new PostgreSQLContainer<>(POSTGRES_IMAGE)
            .withDatabaseName("circle_test")
            .withUsername("circle_user")
            .withPassword("circle_pass");

    /* -------------------------------------------------------------------------
     * JWT test token generation
     * ---------------------------------------------------------------------- */
    private static final Key JWT_SECRET = Keys.secretKeyFor(SignatureAlgorithm.HS512);

    private TestUtils() {
        /* utility class – do not instantiate */
    }

    /* -------------------------------------------------------------------------
     * Static initializer(s)
     * ---------------------------------------------------------------------- */
    static {
        // Start the PostgreSQL container once for the entire JVM.
        if (!POSTGRESQL.isRunning()) {
            POSTGRESQL.start();
        }
    }

    /* -------------------------------------------------------------------------
     * JSON helpers
     * ---------------------------------------------------------------------- */

    /**
     * Serialize an arbitrary object to a JSON {@link String}.
     *
     * @param value object to convert
     * @return JSON string
     */
    public static String toJson(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Failed to serialize object to JSON", ex);
        }
    }

    /**
     * Read a file from the class-path and deserialize it into the requested type.
     *
     * @param resourcePath path relative to {@code src/test/resources}
     * @param clazz        target Java type
     * @param <T>          generic type parameter
     * @return deserialized object
     */
    public static <T> T jsonFixture(String resourcePath, Class<T> clazz) {
        try {
            byte[] bytes = Files.readAllBytes(new ClassPathResource(resourcePath).getFile().toPath());
            return MAPPER.readValue(bytes, clazz);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read JSON test fixture: " + resourcePath, ex);
        }
    }

    /**
     * Read a file from the class-path and deserialize it into the requested type reference
     * (useful for collections & generics).
     *
     * @param resourcePath path relative to {@code src/test/resources}
     * @param typeRef      Jackson type reference
     * @param <T>          generic type parameter
     * @return deserialized object
     */
    public static <T> T jsonFixture(String resourcePath, TypeReference<T> typeRef) {
        try {
            byte[] bytes = Files.readAllBytes(new ClassPathResource(resourcePath).getFile().toPath());
            return MAPPER.readValue(bytes, typeRef);
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read JSON test fixture: " + resourcePath, ex);
        }
    }

    /**
     * Convenience method for converting an object into a Spring {@link org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder}
     * compatible JSON object.
     *
     * @param value object to convert
     * @return {@link org.springframework.mock.web.MockHttpServletResponse} body content
     */
    public static org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder jsonRequest(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder builder, Object value) {

        return builder
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.APPLICATION_JSON)
                .content(toJson(value));
    }

    /* -------------------------------------------------------------------------
     * Randomized data helpers
     * ---------------------------------------------------------------------- */

    private static final Random RANDOM = new Random();

    /**
     * Generate a random, RFC-4122 compliant UUID string.
     */
    public static String randomId() {
        return UUID.randomUUID().toString();
    }

    /**
     * Generate a random email address to avoid unique-constraint collisions
     * in integration tests.
     */
    public static String randomEmail() {
        return "user+" + randomId().substring(0, 8) + "@test.circle.dev";
    }

    /* -------------------------------------------------------------------------
     * JWT helpers
     * ---------------------------------------------------------------------- */

    /**
     * Create a signed JWT token valid for 2 hours for the given subject.
     */
    public static String jwtForSubject(String subject) {
        Instant now = Instant.now();
        return Jwts.builder()
                .setSubject(subject)
                .setIssuedAt(Date.from(now))
                .setExpiration(Date.from(now.plusSeconds(7200)))
                .signWith(JWT_SECRET)
                .compact();
    }

    /**
     * Lazy supplier that always returns a valid token for random subjects.
     */
    public static Supplier<String> jwtSupplier() {
        return () -> jwtForSubject(randomEmail());
    }

    /* -------------------------------------------------------------------------
     * Assertion helpers
     * ---------------------------------------------------------------------- */

    /**
     * Assert that a given executable throws an expected exception type and
     * that the exception message contains (case-insensitive) the provided
     * text.
     *
     * @param expectedType expected exception class
     * @param expectedText text that should appear in the exception message
     * @param executable   lambda or method reference that is expected to throw
     * @param <T>          exception generic type
     * @return the thrown exception for further inspection
     */
    public static <T extends Throwable> T assertThrowsWithMessage(
            Class<T> expectedType,
            String expectedText,
            org.junit.jupiter.api.function.Executable executable) {

        T thrown = Assertions.assertThrows(expectedType, executable,
                () -> "Expected exception of type "
                        + expectedType.getSimpleName()
                        + " was not thrown.");

        Assertions.assertTrue(
                thrown.getMessage() != null && thrown.getMessage().toLowerCase().contains(expectedText.toLowerCase()),
                () -> "Exception message «" + thrown.getMessage() + "» does not contain «" + expectedText + "»");

        return thrown;
    }

    /* -------------------------------------------------------------------------
     * Resource helpers
     * ---------------------------------------------------------------------- */

    /**
     * Read a raw text file from class-path into a {@link String}.
     *
     * @param resourcePath path relative to {@code src/test/resources}
     */
    public static String readResource(String resourcePath) {
        try {
            return Files.readString(
                    new ClassPathResource(resourcePath).getFile().toPath(),
                    StandardCharsets.UTF_8
            );
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to read resource: " + resourcePath, ex);
        }
    }

    /* -------------------------------------------------------------------------
     * Convenience cleanup
     * ---------------------------------------------------------------------- */

    /**
     * Close containers & resources between test suites.
     * This method can be invoked from a {@code @AfterAll} static block
     * if necessary, though TestContainers registers a JVM shutdown hook
     * automatically.
     */
    public static void shutdown() {
        if (POSTGRESQL != null && POSTGRESQL.isRunning()) {
            POSTGRESQL.stop();
        }
    }
}