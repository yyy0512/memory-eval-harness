package com.vitalpulse.cloudcare.ingestion.repository;

import com.vitalpulse.cloudcare.common.model.VitalSign;
import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.enhanced.dynamodb.*;
import software.amazon.awssdk.enhanced.dynamodb.model.BatchWriteItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.PutItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteBatch;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteBatch.Builder;
import software.amazon.awssdk.services.dynamodb.DynamoDbAsyncClient;
import software.amazon.awssdk.services.dynamodb.model.ProvisionedThroughputExceededException;
import software.amazon.awssdk.services.dynamodb.model.ResourceNotFoundException;

import javax.annotation.Nonnull;
import javax.annotation.concurrent.ThreadSafe;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Repository responsible for persisting VitalSign domain objects into DynamoDB.
 * <p>
 * This class is intended to be instantiated once per container / Lambda invoker.
 * The implementation is fully async/non-blocking and resilient to intermittent
 * DynamoDB throttling by applying an exponential back-off retry loop.
 */
@ThreadSafe
public class VitalSignRepository {

    private static final Logger LOGGER = LoggerFactory.getLogger(VitalSignRepository.class);

    // DynamoDB attribute names
    private static final String ATTR_PK = "pk";
    private static final String ATTR_SK = "sk";
    private static final String ATTR_PATIENT_ID = "patientId";
    private static final String ATTR_VITAL_NAME = "vitalName";
    private static final String ATTR_VALUE = "value";
    private static final String ATTR_UNIT = "unit";
    private static final String ATTR_RECORDED_AT = "recordedAtEpochMillis";
    private static final String ATTR_VERSION = "version";
    private static final String ATTR_TTL = "ttlEpochSeconds";

    // Back-off configuration
    private static final int MAX_RETRY_ATTEMPTS = 3;
    private static final Duration BASE_DELAY = Duration.ofMillis(150);

    private final DynamoDbEnhancedAsyncClient enhancedClient;
    private final DynamoDbAsyncTable<DynamoVitalSign> table;
    private final Counter persistSuccessCounter;
    private final Counter persistFailureCounter;

    /**
     * Creates a new repository with the given DynamoDB client and MeterRegistry.
     *
     * @param dynamoDbAsyncClient non-null DynamoDB async client
     * @param tableName           fully resolved table name (typically obtained from env/config)
     * @param meterRegistry       Micrometer registry used for custom metrics
     */
    public VitalSignRepository(@Nonnull final DynamoDbAsyncClient dynamoDbAsyncClient,
                               @Nonnull final String tableName,
                               @Nonnull final MeterRegistry meterRegistry) {

        Objects.requireNonNull(dynamoDbAsyncClient, "dynamoDbAsyncClient must not be null");
        Objects.requireNonNull(tableName, "tableName must not be null");
        Objects.requireNonNull(meterRegistry, "meterRegistry must not be null");

        this.enhancedClient = DynamoDbEnhancedAsyncClient.builder()
                .dynamoDbClient(dynamoDbAsyncClient)
                .build();

        this.table = enhancedClient.table(tableName, TableSchema.fromBean(DynamoVitalSign.class));
        this.persistSuccessCounter = meterRegistry.counter("vital_sign_repository.persist.success");
        this.persistFailureCounter = meterRegistry.counter("vital_sign_repository.persist.failure");
    }

    /**
     * Persists a single VitalSign object in an idempotent fashion.
     * Uses optimistic locking on the "version" attribute (increments by one).
     *
     * @param vitalSign domain object to persist
     * @return completed future once the item has been acknowledged by DynamoDB
     */
    public CompletableFuture<Void> save(@Nonnull final VitalSign vitalSign) {
        Objects.requireNonNull(vitalSign, "vitalSign must not be null");

        final DynamoVitalSign dynamoItem = mapToDynamo(vitalSign);

        PutItemEnhancedRequest<DynamoVitalSign> request = PutItemEnhancedRequest.<DynamoVitalSign>builder(dynamoItem)
                .conditionExpression(Expression.builder()
                        .expression("attribute_not_exists(#pk)")
                        .putExpressionName("#pk", ATTR_PK)
                        .build())
                .build();

        return executeWithRetry(() -> table.putItem(request))
                .thenAccept(result -> persistSuccessCounter.increment())
                .exceptionally(throwable -> {
                    persistFailureCounter.increment();
                    throw new CompletionException(throwable);
                });
    }

    /**
     * Batch-persists up to 25 VitalSign objects. DynamoDB SDK splits larger
     * collections into multiple BatchWriteItem calls.
     *
     * @param vitalSigns list of domain objects
     * @return future that completes when all items have been persisted
     */
    public CompletableFuture<Void> saveBatch(@Nonnull final Collection<VitalSign> vitalSigns) {
        Objects.requireNonNull(vitalSigns, "vitalSigns must not be null");

        if (vitalSigns.isEmpty()) {
            return CompletableFuture.completedFuture(null);
        }

        WriteBatch.Builder<DynamoVitalSign> batchBuilder = WriteBatch.<DynamoVitalSign>builder(DynamoVitalSign.class)
                .mappedTableResource(table);

        vitalSigns.stream()
                .map(this::mapToDynamo)
                .forEach(batchBuilder::addPutItem);

        BatchWriteItemEnhancedRequest batchRequest = BatchWriteItemEnhancedRequest.builder()
                .writeBatches(batchBuilder.build())
                .build();

        return executeWithRetry(() -> enhancedClient.batchWriteItem(batchRequest))
                .thenAccept(ignore -> persistSuccessCounter.increment(vitalSigns.size()))
                .exceptionally(throwable -> {
                    persistFailureCounter.increment(vitalSigns.size());
                    throw new CompletionException(throwable);
                });
    }

    /* ------------------------------------------------------------------------------------------
     * Internal helper methods
     * ------------------------------------------------------------------------------------------ */

    /**
     * Executes the supplied async call with exponential back-off retry on
     * ProvisionedThroughputExceededException (DynamoDB throttling) or unprovisioned table.
     */
    private <T> CompletableFuture<T> executeWithRetry(final SupplierWithFuture<T> action) {
        CompletableFuture<T> future = new CompletableFuture<>();
        executeWithRetry(action, future, 0);
        return future;
    }

    private <T> void executeWithRetry(final SupplierWithFuture<T> action,
                                      final CompletableFuture<T> future,
                                      final int attempt) {

        if (attempt > MAX_RETRY_ATTEMPTS) {
            future.completeExceptionally(new IllegalStateException(
                    "Exceeded max retry attempts (" + MAX_RETRY_ATTEMPTS + ")"));
            return;
        }

        action.get()
                .whenComplete((result, throwable) -> {
                    if (throwable == null) {
                        future.complete(result);
                    } else if (isRetryable(throwable)) {
                        Duration backoff = BASE_DELAY.multipliedBy(1L << attempt); // 2^attempt
                        LOGGER.warn("Retrying DynamoDB write (attempt #{}) after {} ms due to {}",
                                attempt + 1, backoff.toMillis(), throwable.getClass().getSimpleName());
                        sleep(backoff);
                        executeWithRetry(action, future, attempt + 1);
                    } else {
                        future.completeExceptionally(unwrapCompletionException(throwable));
                    }
                });
    }

    private boolean isRetryable(Throwable throwable) {
        Throwable root = unwrapCompletionException(throwable);
        return root instanceof ProvisionedThroughputExceededException
                || root instanceof ResourceNotFoundException;
    }

    private Throwable unwrapCompletionException(Throwable throwable) {
        return throwable instanceof CompletionException && throwable.getCause() != null
                ? throwable.getCause()
                : throwable;
    }

    private void sleep(Duration duration) {
        try {
            Thread.sleep(duration.toMillis());
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }

    private DynamoVitalSign mapToDynamo(VitalSign src) {
        DynamoVitalSign dest = new DynamoVitalSign();
        dest.setPk("PATIENT#" + src.getPatientId());
        dest.setSk("VITAL#" + src.getRecordedAt().toEpochMilli() + "#" + UUID.randomUUID());
        dest.setPatientId(src.getPatientId());
        dest.setVitalName(src.getVitalName().name());
        dest.setValue(src.getValue());
        dest.setUnit(src.getUnit());
        dest.setRecordedAtEpochMillis(src.getRecordedAt().toEpochMilli());
        dest.setVersion(1L); // initial revision
        dest.setTtlEpochSeconds(Instant.now().plus(Duration.ofDays(365)).getEpochSecond()); // 1 year retention
        return dest;
    }

    /* ------------------------------------------------------------------------------------------
     * Functional Interface
     * ------------------------------------------------------------------------------------------ */

    @FunctionalInterface
    private interface SupplierWithFuture<T> {
        CompletableFuture<T> get();
    }

    /* ------------------------------------------------------------------------------------------
     * DynamoDB Enhanced Client Bean
     * ------------------------------------------------------------------------------------------ */

    /**
     * Internal DTO used by the Enhanced Client. Encapsulates partition and sort keys
     * as well as the FHIR-compatible VitalSign payload.
     */
    @DynamoDbBean
    public static final class DynamoVitalSign {

        private String pk;
        private String sk;
        private String patientId;
        private String vitalName;
        private double value;
        private String unit;
        private long recordedAtEpochMillis;
        private long version;
        private long ttlEpochSeconds;

        @DynamoDbPartitionKey
        @DynamoDbAttribute(ATTR_PK)
        public String getPk() {
            return pk;
        }

        public void setPk(String pk) {
            this.pk = pk;
        }

        @DynamoDbSortKey
        @DynamoDbAttribute(ATTR_SK)
        public String getSk() {
            return sk;
        }

        public void setSk(String sk) {
            this.sk = sk;
        }

        @DynamoDbAttribute(ATTR_PATIENT_ID)
        public String getPatientId() {
            return patientId;
        }

        public void setPatientId(String patientId) {
            this.patientId = patientId;
        }

        @DynamoDbAttribute(ATTR_VITAL_NAME)
        public String getVitalName() {
            return vitalName;
        }

        public void setVitalName(String vitalName) {
            this.vitalName = vitalName;
        }

        @DynamoDbAttribute(ATTR_VALUE)
        public double getValue() {
            return value;
        }

        public void setValue(double value) {
            this.value = value;
        }

        @DynamoDbAttribute(ATTR_UNIT)
        public String getUnit() {
            return unit;
        }

        public void setUnit(String unit) {
            this.unit = unit;
        }

        @DynamoDbAttribute(ATTR_RECORDED_AT)
        public long getRecordedAtEpochMillis() {
            return recordedAtEpochMillis;
        }

        public void setRecordedAtEpochMillis(long recordedAtEpochMillis) {
            this.recordedAtEpochMillis = recordedAtEpochMillis;
        }

        @DynamoDbVersionAttribute
        @DynamoDbAttribute(ATTR_VERSION)
        public long getVersion() {
            return version;
        }

        public void setVersion(long version) {
            this.version = version;
        }

        @DynamoDbAttribute(ATTR_TTL)
        public long getTtlEpochSeconds() {
            return ttlEpochSeconds;
        }

        public void setTtlEpochSeconds(long ttlEpochSeconds) {
            this.ttlEpochSeconds = ttlEpochSeconds;
        }
    }
}