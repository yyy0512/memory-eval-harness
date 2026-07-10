```java
package com.vitalpulse.cloudcare.api_rest.config;

import java.net.URI;
import java.time.Duration;
import java.util.Locale;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import javax.annotation.Nullable;
import javax.annotation.concurrent.ThreadSafe;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.AwsCredentialsProvider;
import software.amazon.awssdk.auth.credentials.DefaultCredentialsProvider;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;

/**
 * Centralized, immutable configuration for the VitalPulse CloudCare API. <p>
 *
 * Backed by environment variables injected at deployment time (e.g., by AWS SAM/CloudFormation),
 * with sensible defaults for local development. Provides lazy, thread-safe access to heavyweight
 * resources such as the {@link DynamoDbClient}. All configuration lookups are validated eagerly
 * on first access to surface misconfigurations early in a Lambda warm start rather than at runtime.
 */
@ThreadSafe
public final class Config {

    /* ======================= Public Accessors ======================= */

    public static Stage stage() {
        return INSTANCE.stage;
    }

    public static Region awsRegion() {
        return INSTANCE.awsRegion;
    }

    public static String auditTableName() {
        return INSTANCE.auditTableName;
    }

    public static String patientTelemetryTableName() {
        return INSTANCE.patientTelemetryTableName;
    }

    public static int burstRateLimit() {
        return INSTANCE.burstRateLimit;
    }

    public static int steadyStateRateLimit() {
        return INSTANCE.steadyStateRateLimit;
    }

    public static Duration defaultDynamoDbTimeout() {
        return INSTANCE.defaultDynamoDbTimeout;
    }

    public static boolean debugEnabled() {
        return INSTANCE.debugEnabled;
    }

    public static DynamoDbClient dynamoDbClient() {
        return INSTANCE.dynamoDbClient();
    }

    /* ======================= Implementation ========================= */

    private static final Logger LOGGER = LoggerFactory.getLogger(Config.class);
    private static final Config INSTANCE = new Config();

    private final Stage stage;
    private final Region awsRegion;
    private final String auditTableName;
    private final String patientTelemetryTableName;
    private final int burstRateLimit;
    private final int steadyStateRateLimit;
    private final Duration defaultDynamoDbTimeout;
    private final boolean debugEnabled;

    // Lazy-heavy resources
    private final AtomicReference<DynamoDbClient> dynamoDbClientRef = new AtomicReference<>();

    private Config() {
        // Stage
        this.stage = Stage.from(env("STAGE", true));

        // Region
        this.awsRegion = Region.of(env("AWS_REGION", false).orElse("us-east-1"));

        // DynamoDB tables
        this.auditTableName = env("DDB_AUDIT_TABLE", true).orElseThrow();
        this.patientTelemetryTableName = env("DDB_PATIENT_TELEMETRY_TABLE", true).orElseThrow();

        // Rate limiting (token-bucket: burst/steady)
        this.burstRateLimit = envInt("RATE_LIMIT_BURST", 100);
        this.steadyStateRateLimit = envInt("RATE_LIMIT_STEADY", 50);

        // Timeouts (ms) – default 5s
        this.defaultDynamoDbTimeout = Duration.ofMillis(envLong("DDB_DEFAULT_TIMEOUT_MS", 5_000));

        // Debug flag
        this.debugEnabled = envBool("DEBUG_ENABLED", false);

        LOGGER.info("Config initialized: stage={}, region={}, auditTable={}, telemetryTable={}",
                stage, awsRegion, auditTableName, patientTelemetryTableName);
    }

    /**
     * Lazily builds a thread-safe, shareable DynamoDB client for Lambda invocations.
     */
    private DynamoDbClient dynamoDbClient() {
        DynamoDbClient client = dynamoDbClientRef.get();
        if (client == null) {
            synchronized (dynamoDbClientRef) {
                client = dynamoDbClientRef.get();
                if (client == null) {
                    client = buildDynamoDbClient();
                    dynamoDbClientRef.set(client);
                }
            }
        }
        return client;
    }

    private DynamoDbClient buildDynamoDbClient() {
        DynamoDbClient.Builder builder = DynamoDbClient.builder()
                .region(awsRegion)
                .httpClientBuilder(UrlConnectionHttpClient.builder())
                .overrideConfiguration(cfg -> cfg
                        .apiCallAttemptTimeout(defaultDynamoDbTimeout)
                        .apiCallTimeout(defaultDynamoDbTimeout.multipliedBy(2)));

        // LocalStack or on-prem testing: allow endpoint override
        env("DDB_ENDPOINT_OVERRIDE", false).ifPresent(e -> builder.endpointOverride(URI.create(e)));

        // Allow explicit credentials for CI/CD or local dev
        Optional<String> accessKey = env("AWS_ACCESS_KEY_ID", false);
        Optional<String> secretKey = env("AWS_SECRET_ACCESS_KEY", false);
        AwsCredentialsProvider provider;
        if (accessKey.isPresent() && secretKey.isPresent()) {
            provider = StaticCredentialsProvider.create(
                    AwsBasicCredentials.create(accessKey.get(), secretKey.get()));
        } else {
            provider = DefaultCredentialsProvider.create();
        }
        builder.credentialsProvider(provider);
        return builder.build();
    }

    /* ======================= Helper Enums & Methods ================= */

    public enum Stage {
        DEV, QA, PROD;

        public static Stage from(Optional<String> value) {
            return value.map(v -> Stage.valueOf(v.trim().toUpperCase(Locale.ROOT)))
                        .orElse(DEV);
        }
    }

    private static Optional<String> env(String key, boolean required) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            if (required) {
                throw new MisconfigurationException("Missing required env var: " + key);
            }
            return Optional.empty();
        }
        return Optional.of(value.trim());
    }

    private static int envInt(String key, int defaultVal) {
        return env(key, false).map(Integer::parseInt).orElse(defaultVal);
    }

    private static long envLong(String key, long defaultVal) {
        return env(key, false).map(Long::parseLong).orElse(defaultVal);
    }

    private static boolean envBool(String key, boolean defaultVal) {
        return env(key, false).map(v -> v.equalsIgnoreCase("true")).orElse(defaultVal);
    }

    /* ======================= Custom Exception ======================= */

    /**
     * Thrown when a required environment variable is missing or cannot be parsed.
     * Unchecked to bubble up to the Lambda runtime and fail the warm start,
     * forcing infrastructure operators to fix the deployment package.
     */
    public static final class MisconfigurationException extends RuntimeException {
        public MisconfigurationException(String msg) { super(msg); }
        public MisconfigurationException(String msg, @Nullable Throwable cause) { super(msg, cause); }
    }
}
```