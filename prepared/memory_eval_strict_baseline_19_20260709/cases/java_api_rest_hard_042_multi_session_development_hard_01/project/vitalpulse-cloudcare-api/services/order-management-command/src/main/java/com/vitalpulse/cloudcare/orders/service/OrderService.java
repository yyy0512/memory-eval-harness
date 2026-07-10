package com.vitalpulse.cloudcare.orders.service;

import com.vitalpulse.cloudcare.common.audit.AuditTrailService;
import com.vitalpulse.cloudcare.common.command.IdempotencyKeyStore;
import com.vitalpulse.cloudcare.common.context.RequestContext;
import com.vitalpulse.cloudcare.common.error.DomainException;
import com.vitalpulse.cloudcare.common.error.ErrorCodes;
import com.vitalpulse.cloudcare.common.error.ValidationException;
import com.vitalpulse.cloudcare.common.event.EventPublisher;
import com.vitalpulse.cloudcare.orders.domain.model.Order;
import com.vitalpulse.cloudcare.orders.domain.model.OrderId;
import com.vitalpulse.cloudcare.orders.domain.model.OrderStatus;
import com.vitalpulse.cloudcare.orders.domain.repository.OrderRepository;
import com.vitalpulse.cloudcare.orders.service.dto.CancelOrderRequest;
import com.vitalpulse.cloudcare.orders.service.dto.CreateOrderRequest;
import com.vitalpulse.cloudcare.orders.service.dto.OrderResponse;
import com.vitalpulse.cloudcare.orders.service.dto.UpdateOrderRequest;
import com.vitalpulse.cloudcare.orders.service.events.OrderCancelledEvent;
import com.vitalpulse.cloudcare.orders.service.events.OrderCreatedEvent;
import com.vitalpulse.cloudcare.orders.service.events.OrderUpdatedEvent;
import com.vitalpulse.cloudcare.orders.service.validation.OrderValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.inject.Inject;
import javax.validation.constraints.NotNull;
import java.time.Clock;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

/**
 * Service-layer component for write (command) operations on {@link Order}s.
 * <p>
 * This class is intentionally stateless; all state is persisted in the repository or transiently
 * stored in the {@link IdempotencyKeyStore}. The service is responsible for:
 * <ul>
 *     <li>FHIR/Domain validation</li>
 *     <li>Authorization checks</li>
 *     <li>Optimistic locking &amp; concurrency safety</li>
 *     <li>Idempotent command processing</li>
 *     <li>Publishing domain events</li>
 *     <li>Emitting audit entries</li>
 * </ul>
 */
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final OrderRepository orderRepository;
    private final OrderValidator orderValidator;
    private final IdempotencyKeyStore idempotencyKeyStore;
    private final EventPublisher eventPublisher;
    private final AuditTrailService auditTrailService;
    private final Clock clock;

    @Inject
    public OrderService(final OrderRepository orderRepository,
                        final OrderValidator orderValidator,
                        final IdempotencyKeyStore idempotencyKeyStore,
                        final EventPublisher eventPublisher,
                        final AuditTrailService auditTrailService,
                        final Clock clock) {
        this.orderRepository = orderRepository;
        this.orderValidator = orderValidator;
        this.idempotencyKeyStore = idempotencyKeyStore;
        this.eventPublisher = eventPublisher;
        this.auditTrailService = auditTrailService;
        this.clock = clock;
    }

    /**
     * Creates a new {@link Order} in the system.
     *
     * @throws ValidationException  if validation fails
     * @throws DomainException      if an order with the supplied id already exists
     */
    public OrderResponse createOrder(@NotNull final CreateOrderRequest request,
                                     @NotNull final RequestContext ctx) {
        log.debug("CreateOrder invoked, requestId={} patientId={}", ctx.getRequestId(), request.getPatientId());

        // 1. Validate FHIR payload & business constraints
        orderValidator.validateForCreate(request);

        // 2. Idempotency check
        if (idempotencyKeyStore.isProcessed(ctx.getIdempotencyKey())) {
            log.info("Idempotent request replay detected, key={}", ctx.getIdempotencyKey());
            return idempotencyKeyStore.retrieve(ctx.getIdempotencyKey(), OrderResponse.class)
                    .orElseThrow(() -> new DomainException(ErrorCodes.IDEMPOTENCY_CONFLICT,
                            "Idempotency key processed but no cached response"));
        }

        // 3. Build Order Aggregate
        Order order = Order.builder()
                .orderId(OrderId.of(UUID.randomUUID().toString()))
                .patientId(request.getPatientId())
                .clinicianId(ctx.getPrincipalId())
                .status(OrderStatus.PENDING)
                .createdAt(Instant.now(clock))
                .updatedAt(Instant.now(clock))
                .payload(request.getFhirBundle())
                .build();

        // 4. Persist
        orderRepository.save(order);

        // 5. Emit event & audit
        OrderCreatedEvent event = new OrderCreatedEvent(order.getOrderId(), order.getPatientId());
        eventPublisher.publish(event);

        auditTrailService.record(ctx, "ORDER_CREATED", order.getOrderId().value(),
                "Order created for patient " + order.getPatientId());

        // 6. Prepare response & cache for idempotency
        OrderResponse response = toResponse(order);
        idempotencyKeyStore.store(ctx.getIdempotencyKey(), response);

        return response;
    }

    /**
     * Updates an existing {@link Order}. Only orders in PENDING state can be modified.
     */
    public OrderResponse updateOrder(@NotNull final UpdateOrderRequest request,
                                     @NotNull final RequestContext ctx) {
        log.debug("UpdateOrder invoked, requestId={} orderId={}", ctx.getRequestId(), request.getOrderId());

        // 1. Validate
        orderValidator.validateForUpdate(request);

        Order order = orderRepository.findById(OrderId.of(request.getOrderId()))
                .orElseThrow(() -> new DomainException(ErrorCodes.RESOURCE_NOT_FOUND,
                        "Order not found: " + request.getOrderId()));

        if (!order.canModify()) {
            throw new DomainException(ErrorCodes.RESOURCE_STATE_CONFLICT,
                    "Only PENDING orders may be modified");
        }

        // 2. Concurrency / optimistic lock (version check)
        if (request.getVersion() != null && !request.getVersion().equals(order.getVersion())) {
            throw new DomainException(ErrorCodes.OPTIMISTIC_LOCK_FAILURE,
                    "Order version mismatch");
        }

        // 3. Apply modifications
        order.updatePayload(request.getFhirBundle(), Instant.now(clock));

        // 4. Persist
        orderRepository.save(order);

        // 5. Publish & audit
        eventPublisher.publish(new OrderUpdatedEvent(order.getOrderId(), order.getPatientId()));
        auditTrailService.record(ctx, "ORDER_UPDATED", order.getOrderId().value(),
                "Order updated by clinician " + ctx.getPrincipalId());

        return toResponse(order);
    }

    /**
     * Cancels an existing {@link Order}. Orders that are already COMPLETED or CANCELLED cannot be cancelled again.
     */
    public OrderResponse cancelOrder(@NotNull final CancelOrderRequest request,
                                     @NotNull final RequestContext ctx) {
        log.debug("CancelOrder invoked, requestId={} orderId={}", ctx.getRequestId(), request.getOrderId());

        Order order = orderRepository.findById(OrderId.of(request.getOrderId()))
                .orElseThrow(() -> new DomainException(ErrorCodes.RESOURCE_NOT_FOUND,
                        "Order not found: " + request.getOrderId()));

        if (!order.canCancel()) {
            throw new DomainException(ErrorCodes.RESOURCE_STATE_CONFLICT,
                    "Order cannot be cancelled in its current state: " + order.getStatus());
        }

        order.cancel(Instant.now(clock));

        // Persist
        orderRepository.save(order);

        // Publish event & audit
        eventPublisher.publish(new OrderCancelledEvent(order.getOrderId(), order.getPatientId()));
        auditTrailService.record(ctx, "ORDER_CANCELLED", order.getOrderId().value(),
                "Order cancelled by clinician " + ctx.getPrincipalId());

        return toResponse(order);
    }

    /**
     * Performs a lightweight verification on an order without mutating state.
     *
     * @return Optional.empty() if order not found
     * @throws ValidationException for any validation failure
     */
    public Optional<OrderResponse> verifyOrder(@NotNull final String orderId) {
        return orderRepository.findById(OrderId.of(orderId)).map(order -> {
            orderValidator.verify(order);
            return toResponse(order);
        });
    }

    /* -----------------------------------------------------------------------------------------------------------------
     * MAPPING HELPERS
     * ----------------------------------------------------------------------------------------------------------------- */

    private OrderResponse toResponse(final Order order) {
        return OrderResponse.builder()
                .orderId(order.getOrderId().value())
                .patientId(order.getPatientId())
                .status(order.getStatus().name())
                .version(order.getVersion())
                .timestamp(order.getUpdatedAt())
                .build();
    }
}