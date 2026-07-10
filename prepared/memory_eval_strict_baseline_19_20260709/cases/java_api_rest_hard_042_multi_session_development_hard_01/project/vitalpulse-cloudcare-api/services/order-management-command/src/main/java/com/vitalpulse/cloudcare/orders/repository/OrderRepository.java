package com.vitalpulse.cloudcare.orders.repository;

import com.vitalpulse.cloudcare.orders.model.Order;
import com.vitalpulse.cloudcare.orders.model.OrderStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbEnhancedClient;
import software.amazon.awssdk.enhanced.dynamodb.DynamoDbTable;
import software.amazon.awssdk.enhanced.dynamodb.Key;
import software.amazon.awssdk.enhanced.dynamodb.TableSchema;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbBean;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbPartitionKey;
import software.amazon.awssdk.enhanced.dynamodb.mapper.annotations.DynamoDbSortKey;
import software.amazon.awssdk.enhanced.dynamodb.model.Expression;
import software.amazon.awssdk.enhanced.dynamodb.model.PutItemEnhancedRequest;
import software.amazon.awssdk.enhanced.dynamodb.model.UpdateItemEnhancedRequest;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Repository interface in charge of persisting Order aggregate roots.
 * <p>
 * Production implementation relies on AWS DynamoDB Enhanced Client.
 * Command &amp; Query segregation is enforced by exposing only mutation-centric
 * methods here. Read models live in the query Lambda.
 */
public interface OrderRepository {

    /**
     * Persists a new order. Operation is idempotent and protected against
     * accidental overwrite by using a conditional put (PK must not exist).
     *
     * @param order Order domain object
     * @return the same Order instance, enriched with persistence metadata
     * @throws RepositoryException if the order already exists or I/O fails
     */
    Order save(Order order) throws RepositoryException;

    /**
     * Updates the status of an existing order. Optimistic locking is applied
     * using the {@code version} attribute—callers must supply the current
     * version or a {@link ConcurrencyException} will be raised.
     *
     * @param orderId   aggregate identifier
     * @param newStatus new status
     * @param modifiedBy user initiating the change (for auditing)
     * @throws RepositoryException   infra failures
     * @throws ConcurrencyException  optimistic locking conflict
     */
    void updateStatus(UUID orderId, OrderStatus newStatus, String modifiedBy)
            throws RepositoryException, ConcurrencyException;

    /**
     * Fetches an order by id, if present.
     *
     * @param orderId aggregate identifier
     * @return Optional Order
     * @throws RepositoryException I/O failures
     */
    Optional<Order> findById(UUID orderId) throws RepositoryException;

    /* --------------------------------------------------------------------- */
    /* -------------------- DynamoDB IMPLEMENTATION BELOW ------------------ */
    /* --------------------------------------------------------------------- */

    /**
     * Factory helper creating a repository wired to the provided DynamoDB client.
     */
    static OrderRepository dynamoDb(DynamoDbEnhancedClient enhancedClient) {
        return new DynamoDbOrderRepository(enhancedClient);
    }

    /**
     * Default, production-ready DynamoDB implementation.
     * Package-private to avoid exposing storage details.
     */
    final class DynamoDbOrderRepository implements OrderRepository {

        private static final Logger LOG = LoggerFactory.getLogger(DynamoDbOrderRepository.class);

        private static final String TABLE_NAME = "cc_orders";
        private static final String ATTR_VERSION = "version";

        private final DynamoDbTable<OrderDdbRecord> table;

        DynamoDbOrderRepository(DynamoDbEnhancedClient enhancedClient) {
            this.table = enhancedClient.table(TABLE_NAME, TableSchema.fromBean(OrderDdbRecord.class));
        }

        @Override
        public Order save(Order order) throws RepositoryException {
            try {
                OrderDdbRecord record = OrderDdbRecord.from(order);
                Expression condition = Expression.builder()
                        .expression("attribute_not_exists(PK)") // idempotent create
                        .build();

                PutItemEnhancedRequest<OrderDdbRecord> request =
                        PutItemEnhancedRequest.<OrderDdbRecord>builder(record.getClass())
                                .item(record)
                                .conditionExpression(condition)
                                .build();

                table.putItem(request);
                LOG.info("Order {} persisted with version {}", order.getId(), order.getVersion());
                return order;
            } catch (ConditionalCheckFailedException e) {
                throw new RepositoryException("Order already exists: " + order.getId(), e);
            } catch (Exception e) {
                throw new RepositoryException("Unable to save order: " + order.getId(), e);
            }
        }

        @Override
        public void updateStatus(UUID orderId, OrderStatus newStatus, String modifiedBy)
                throws RepositoryException, ConcurrencyException {

            // fetch current record to obtain the version for optimistic locking
            OrderDdbRecord current = table.getItem(key(orderId));
            if (current == null) {
                throw new RepositoryException("Order not found: " + orderId);
            }

            OrderDdbRecord updated = current.toBuilder()
                    .status(newStatus.name())
                    .updatedAt(Instant.now())
                    .updatedBy(modifiedBy)
                    .version(current.version + 1)
                    .build();

            Expression optimisticLock = Expression.builder()
                    .expression(ATTR_VERSION + " = :v")
                    .putExpressionValue(":v",
                            AttributeValue.builder().n(String.valueOf(current.version)).build())
                    .build();

            UpdateItemEnhancedRequest<OrderDdbRecord> request =
                    UpdateItemEnhancedRequest.<OrderDdbRecord>builder(updated.getClass())
                            .conditionExpression(optimisticLock)
                            .item(updated)
                            .build();

            try {
                table.updateItem(request);
                LOG.info("Order {} status moved to {} by {}", orderId, newStatus, modifiedBy);
            } catch (ConditionalCheckFailedException e) {
                throw new ConcurrencyException("Version conflict while updating order " + orderId, e);
            } catch (Exception e) {
                throw new RepositoryException("Failed to update order " + orderId, e);
            }
        }

        @Override
        public Optional<Order> findById(UUID orderId) throws RepositoryException {
            try {
                OrderDdbRecord record = table.getItem(key(orderId));
                return Optional.ofNullable(record).map(OrderDdbRecord::toDomain);
            } catch (Exception e) {
                throw new RepositoryException("Failed to load order " + orderId, e);
            }
        }

        private static Key key(UUID orderId) {
            return Key.builder().partitionValue(orderId.toString()).build();
        }
    }

    /* --------------------------------------------------------------------- */
    /* ------------------------ DYNAMODB BEAN MAPPING ----------------------- */
    /* --------------------------------------------------------------------- */

    /**
     * DynamoDB representation of the Order aggregate.
     * <p>
     * A thin DTO layer avoids leaking database annotations into the domain.
     */
    @DynamoDbBean
    class OrderDdbRecord {

        private String PK;            // Partition key (orderId)
        private String SK = "META";   // Sort key, constant for aggregate root
        private String patientId;
        private String status;
        private long version;
        private Instant createdAt;
        private Instant updatedAt;
        private String createdBy;
        private String updatedBy;
        private String payload;       // JSON snapshot for additional attributes

        @DynamoDbPartitionKey
        public String getPK() {
            return PK;
        }

        public void setPK(String PK) {
            this.PK = PK;
        }

        @DynamoDbSortKey
        public String getSK() {
            return SK;
        }

        public void setSK(String SK) {
            this.SK = SK;
        }

        public String getPatientId() {
            return patientId;
        }

        public void setPatientId(String patientId) {
            this.patientId = patientId;
        }

        public String getStatus() {
            return status;
        }

        public void setStatus(String status) {
            this.status = status;
        }

        public long getVersion() {
            return version;
        }

        public void setVersion(long version) {
            this.version = version;
        }

        public Instant getCreatedAt() {
            return createdAt;
        }

        public void setCreatedAt(Instant createdAt) {
            this.createdAt = createdAt;
        }

        public Instant getUpdatedAt() {
            return updatedAt;
        }

        public void setUpdatedAt(Instant updatedAt) {
            this.updatedAt = updatedAt;
        }

        public String getCreatedBy() {
            return createdBy;
        }

        public void setCreatedBy(String createdBy) {
            this.createdBy = createdBy;
        }

        public String getUpdatedBy() {
            return updatedBy;
        }

        public void setUpdatedBy(String updatedBy) {
            this.updatedBy = updatedBy;
        }

        public String getPayload() {
            return payload;
        }

        public void setPayload(String payload) {
            this.payload = payload;
        }

        /* -------------------- Conversion helpers -------------------- */

        static OrderDdbRecord from(Order order) {
            OrderDdbRecord record = new OrderDdbRecord();
            record.PK = order.getId().toString();
            record.patientId = order.getPatientId();
            record.status = order.getStatus().name();
            record.version = order.getVersion();
            record.createdAt = order.getCreatedAt();
            record.updatedAt = order.getUpdatedAt();
            record.createdBy = order.getCreatedBy();
            record.updatedBy = order.getUpdatedBy();
            record.payload = order.getPayloadJson();
            return record;
        }

        Order toDomain() {
            return Order.builder()
                    .id(UUID.fromString(PK))
                    .patientId(patientId)
                    .status(OrderStatus.valueOf(status))
                    .version(version)
                    .createdAt(createdAt)
                    .updatedAt(updatedAt)
                    .createdBy(createdBy)
                    .updatedBy(updatedBy)
                    .payloadJson(payload)
                    .build();
        }

        Builder toBuilder() {
            return builder()
                    .PK(PK)
                    .patientId(patientId)
                    .status(status)
                    .version(version)
                    .createdAt(createdAt)
                    .updatedAt(updatedAt)
                    .createdBy(createdBy)
                    .updatedBy(updatedBy)
                    .payload(payload);
        }

        /* Lombok-style manual builder to avoid extra dependencies */
        static Builder builder() {
            return new Builder();
        }

        static final class Builder {
            private final OrderDdbRecord r = new OrderDdbRecord();

            Builder PK(String pk) { r.PK = pk; return this; }
            Builder patientId(String p) { r.patientId = p; return this; }
            Builder status(String s) { r.status = s; return this; }
            Builder version(long v) { r.version = v; return this; }
            Builder createdAt(Instant i) { r.createdAt = i; return this; }
            Builder updatedAt(Instant i) { r.updatedAt = i; return this; }
            Builder createdBy(String u) { r.createdBy = u; return this; }
            Builder updatedBy(String u) { r.updatedBy = u; return this; }
            Builder payload(String p) { r.payload = p; return this; }
            OrderDdbRecord build() { return r; }
        }
    }

    /* --------------------------------------------------------------------- */
    /* ----------------------------- EXCEPTIONS ---------------------------- */
    /* --------------------------------------------------------------------- */

    /**
     * Generic persistence error wrapper to isolate the storage layer.
     */
    class RepositoryException extends RuntimeException {
        public RepositoryException(String message) { super(message); }
        public RepositoryException(String message, Throwable cause) { super(message, cause); }
    }

    /**
     * Thrown when optimistic locking fails (version mismatch).
     */
    class ConcurrencyException extends RepositoryException {
        public ConcurrencyException(String message, Throwable cause) { super(message, cause); }
    }
}