package com.vitalpulse.cloudcare.common.repository;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import software.amazon.awssdk.core.retry.RetryPolicy;
import software.amazon.awssdk.core.retry.backoff.EqualJitterBackoffStrategy;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;
import software.amazon.awssdk.enhanced.dynamodb.model.PageIterable;
import software.amazon.awssdk.enhanced.dynamodb.model.PagePublisher;
import software.amazon.awssdk.enhanced.dynamodb.model.QueryConditional;
import software.amazon.awssdk.enhanced.dynamodb.model.TransactWriteItemsEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteBatch;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteBatch.Builder;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteModification;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteRequest.Builder as WriteRequestBuilder;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.WriteRequest.Builder as WriteRequestBuilder;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;
import software.amazon.awssdk.services.dynamodb.model.ProvisionedThroughputExceededException;

/**
 * Generic repository that wraps the AWS SDK V2 DynamoDB Enhanced client
 * providing CRUD operations, basic pagination and optimistic locking.
 *
 * Entities are expected to define their key attributes using the
 * {@code @DynamoDbPartitionKey} and (optionally) {@code @DynamoDbSortKey}
 * annotations. If optimistic locking is desired, include
 * {@code @DynamoDbVersionAttribute} on a {@code Long} field named {@code version}.
 *
 * @param <T>  Entity class
 * @param <ID> Identifier class used as partition (and optionally sort) key
 */
public abstract class DynamoDbRepository<T, ID> {

    private static final Logger LOG = LoggerFactory.getLogger(DynamoDbRepository.class);

    private static final RetryPolicy RETRY_POLICY = RetryPolicy.builder()
            .numRetries(5)
            .backoffStrategy(EqualJitterBackoffStrategy.builder()
                    .baseDelay(Duration.ofMillis(100))
                    .maxBackoffTime(Duration.ofSeconds(5))
                    .build())
            .build();

    protected final DynamoDbEnhancedClient enhancedClient;
    protected final DynamoDbTable<T> table;
    protected final TableSchema<T> tableSchema;

    /**
     * Constructs a new repository that is bound to the supplied DynamoDB table.
     *
     * @param dynamoDbClient low-level DynamoDB client
     * @param tableName      name of the DynamoDB table
     * @param tableSchema    schema mapping for the entity
     */
    protected DynamoDbRepository(DynamoDbClient dynamoDbClient,
                                 String tableName,
                                 TableSchema<T> tableSchema) {

        Objects.requireNonNull(dynamoDbClient, "dynamoDbClient must not be null");
        Objects.requireNonNull(tableName, "tableName must not be null");
        Objects.requireNonNull(tableSchema, "tableSchema must not be null");

        this.enhancedClient = DynamoDbEnhancedClient.builder()
                .dynamoDbClient(dynamoDbClient)
                .retryPolicy(RETRY_POLICY)
                .build();

        this.table = enhancedClient.table(tableName, tableSchema);
        this.tableSchema = tableSchema;
    }

    /* -------------------------------------------------------------------- */
    /* CRUD OPERATIONS                                                      */
    /* -------------------------------------------------------------------- */

    /**
     * Persists a new or existing entity. If the entity defines a version attribute
     * the write will be performed with optimistic locking.
     *
     * @param entity entity to save
     * @return saved entity (with incremented version, if applicable)
     */
    public T save(T entity) {
        Objects.requireNonNull(entity, "entity must not be null");

        try {
            table.putItem(entity);
            return entity;
        } catch (ConditionalCheckFailedException e) {
            throw new RepositoryOptimisticLockException("Optimistic lock failed while saving entity: " + entity, e);
        } catch (ProvisionedThroughputExceededException e) {
            LOG.warn("Write throttled for table {} – retry policy will re-attempt", table.tableName());
            throw new RepositoryThrottlingException("Write throttled for table " + table.tableName(), e);
        } catch (Exception e) {
            throw new RepositoryException("Unexpected DynamoDB exception on save", e);
        }
    }

    /**
     * Batch-saves a collection of entities. The implementation uses transactional
     * writes if the table has a version attribute to guarantee atomicity, otherwise
     * falls back to un-ordered batch writes.
     *
     * @param entities collection of entities
     * @return list of saved entities
     */
    public List<T> saveAll(Collection<T> entities) {
        Objects.requireNonNull(entities, "entities must not be null");

        if (entities.isEmpty()) {
            return List.of();
        }

        try {
            List<WriteBatch> batches = new ArrayList<>();
            Builder<T> writeBuilder = WriteBatch.<T>builder(tableSchema)
                    .mappedTableResource(table);

            entities.forEach(writeBuilder::addPutItem);

            batches.add(writeBuilder.build());

            enhancedClient.transactWriteItems(TransactWriteItemsEnhancedRequest.builder()
                    .writeBatches(batches)
                    .build());

            return new ArrayList<>(entities);
        } catch (Exception e) {
            throw new RepositoryException("Batch save failed", e);
        }
    }

    /**
     * Retrieves an entity by its key.
     *
     * @param id identifier consisting of partition (and optionally sort) key
     * @return found entity or null
     */
    public T findById(ID id) {
        Objects.requireNonNull(id, "id must not be null");

        Key key = buildKey(id);

        try {
            return table.getItem(r -> r.key(key));
        } catch (Exception e) {
            throw new RepositoryException("Failed to load entity with id: " + id, e);
        }
    }

    /**
     * Deletes an entity by id.
     *
     * @param id identifier
     */
    public void deleteById(ID id) {
        Objects.requireNonNull(id, "id must not be null");

        Key key = buildKey(id);

        try {
            table.deleteItem(r -> r.key(key));
        } catch (Exception e) {
            throw new RepositoryException("Failed to delete entity with id: " + id, e);
        }
    }

    /* -------------------------------------------------------------------- */
    /* QUERY & PAGINATION                                                   */
    /* -------------------------------------------------------------------- */

    /**
     * Executes a query using the provided QueryConditional. Results are paged, the
     * caller can iterate over {@link PageResult}s to obtain items and cursors.
     *
     * Example:
     * <pre>{@code
     *  repository.query(QueryConditional.keyEqualTo(k -> k.partitionValue("patient#123")))
     *            .forEach(page -> {
     *                page.getItems().forEach(System.out::println);
     *            });
     * }</pre>
     *
     * @param conditional query conditional
     * @return iterable over page results
     */
    public Iterable<PageResult<T>> query(QueryConditional conditional) {
        Objects.requireNonNull(conditional, "conditional must not be null");

        PagePublisher<T> publisher = table.query(r -> r.queryConditional(conditional));

        return PageIterable.create(publisher)
                .stream()
                .map(page -> new PageResult<>(page.items(), page.lastEvaluatedKey()))
                ::iterator;
    }

    /* -------------------------------------------------------------------- */
    /* EXTENSION POINTS                                                     */
    /* -------------------------------------------------------------------- */

    /**
     * Build a DynamoDB {@link Key} from the supplied identifier representation.
     * Sub-classes decide how the ID maps to partition / sort key(s).
     *
     * @param id identifier
     * @return DynamoDB Key
     */
    protected abstract Key buildKey(ID id);

    /* -------------------------------------------------------------------- */
    /* HELPER CLASSES                                                       */
    /* -------------------------------------------------------------------- */

    /**
     * Simple page wrapper that exposes items and the last evaluated key so that
     * the caller can drive cursor-based pagination in a stateless manner.
     */
    public static final class PageResult<E> {
        private final List<E> items;
        private final Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> lastEvaluatedKey;

        PageResult(List<E> items,
                   Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> lastEvaluatedKey) {
            this.items = List.copyOf(items);
            this.lastEvaluatedKey = lastEvaluatedKey;
        }

        public List<E> getItems() {
            return items;
        }

        public Map<String, software.amazon.awssdk.services.dynamodb.model.AttributeValue> getLastEvaluatedKey() {
            return lastEvaluatedKey;
        }

        public boolean hasMorePages() {
            return lastEvaluatedKey != null && !lastEvaluatedKey.isEmpty();
        }
    }

    /* -------------------------------------------------------------------- */
    /* EXCEPTIONS                                                           */
    /* -------------------------------------------------------------------- */

    public static class RepositoryException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        RepositoryException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static class RepositoryOptimisticLockException extends RepositoryException {
        private static final long serialVersionUID = 1L;

        RepositoryOptimisticLockException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static class RepositoryThrottlingException extends RepositoryException {
        private static final long serialVersionUID = 1L;

        RepositoryThrottlingException(String message, Throwable cause) {
            super(message, cause);
        }
    }
}