package com.vitalpulse.cloudcare.orders;

import com.vitalpulse.cloudcare.common.audit.AuditLogService;
import com.vitalpulse.cloudcare.common.error.DuplicateResourceException;
import com.vitalpulse.cloudcare.common.error.OrderServiceException;
import com.vitalpulse.cloudcare.common.metrics.MetricsPublisher;
import com.vitalpulse.cloudcare.orders.domain.CreateOrderCommand;
import com.vitalpulse.cloudcare.orders.domain.Order;
import com.vitalpulse.cloudcare.orders.domain.OrderStatus;
import com.vitalpulse.cloudcare.orders.port.OrderRepository;
import com.vitalpulse.cloudcare.orders.validation.OrderValidationException;
import com.vitalpulse.cloudcare.orders.validation.OrderValidator;
import org.assertj.core.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.mockito.MockedStatic;
import org.mockito.Mockito;

import java.time.Instant;
import java.util.Collections;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

/**
 * Unit tests for {@link CreateOrderHandler}.
 *
 * <p>NOTE:
 * In production this handler is executed inside an AWS Lambda function.
 * The unit tests are completely isolated from AWS services and instead
 * rely on mocked collaborators (repository, validator, etc.).
 */
class CreateOrderHandlerTest {

    private OrderRepository orderRepository;
    private OrderValidator  orderValidator;
    private AuditLogService auditLogService;
    private MetricsPublisher metricsPublisher;

    private CreateOrderHandler handler;

    @BeforeEach
    void setUp() {
        orderRepository  = mock(OrderRepository.class);
        orderValidator   = mock(OrderValidator.class);
        auditLogService  = mock(AuditLogService.class);
        metricsPublisher = mock(MetricsPublisher.class);

        handler = new CreateOrderHandler(orderRepository,
                                         orderValidator,
                                         auditLogService,
                                         metricsPublisher);
    }

    @Nested
    @DisplayName("happy-path scenarios")
    class HappyPath {

        @Test
        @DisplayName("should persist order, generate audit, and publish metrics")
        void shouldCreateOrderSuccessfully() {
            // Arrange
            CreateOrderCommand command = buildCommand();
            ArgumentCaptor<Order> orderCaptor = ArgumentCaptor.forClass(Order.class);

            Order persisted = Order.builder()
                                   .id(UUID.randomUUID().toString())
                                   .patientId(command.getPatientId())
                                   .clinicianId(command.getClinicianId())
                                   .status(OrderStatus.ACTIVE)
                                   .createdAt(Instant.now())
                                   .build();

            when(orderRepository.save(any(Order.class))).thenReturn(persisted);
            when(orderValidator.validate(command)).thenReturn(Collections.emptyList());

            // Act
            Order response = handler.handle(command);

            // Assert
            InOrder inOrder = inOrder(orderValidator, orderRepository, auditLogService, metricsPublisher);
            inOrder.verify(orderValidator).validate(command);
            inOrder.verify(orderRepository).save(orderCaptor.capture());
            inOrder.verify(auditLogService).audit(eq("ORDER_CREATED"), any());
            inOrder.verify(metricsPublisher).publishCounter("orders.created", 1);

            Order savedOrder = orderCaptor.getValue();
            assertThat(savedOrder.getPatientId()).isEqualTo(command.getPatientId());
            assertThat(savedOrder.getClinicianId()).isEqualTo(command.getClinicianId());
            assertThat(response).isSameAs(persisted);
        }
    }

    @Nested
    @DisplayName("validation failures")
    class ValidationFailures {

        @Test
        @DisplayName("should throw OrderValidationException when command is invalid")
        void shouldFailValidation() {
            // Arrange
            CreateOrderCommand command = buildCommand();

            when(orderValidator.validate(command))
                    .thenReturn(Collections.singletonList("Missing dosage information"));

            // Act & Assert
            assertThrows(OrderValidationException.class, () -> handler.handle(command));

            verifyNoInteractions(orderRepository);
            verify(metricsPublisher).publishCounter("orders.validation_failed", 1);
        }
    }

    @Nested
    @DisplayName("duplicate order handling")
    class DuplicateOrder {

        @Test
        @DisplayName("should return existing order on idempotent retry")
        void shouldHandleDuplicateGracefully() {
            // Arrange
            CreateOrderCommand command = buildCommand();

            Order existing = Order.builder()
                                  .id(UUID.randomUUID().toString())
                                  .patientId(command.getPatientId())
                                  .clinicianId(command.getClinicianId())
                                  .status(OrderStatus.ACTIVE)
                                  .createdAt(Instant.now())
                                  .build();

            when(orderValidator.validate(command)).thenReturn(Collections.emptyList());
            when(orderRepository.save(any(Order.class)))
                    .thenThrow(new DuplicateResourceException("order", existing.getId(), "Duplicate externalRef"))
                    .thenReturn(existing); // simulate repository resolving duplicate and returning existing order

            // Act
            Order response = handler.handle(command);

            // Assert
            assertThat(response.getId()).isEqualTo(existing.getId());
            verify(metricsPublisher).publishCounter("orders.duplicate", 1);
        }
    }

    @Nested
    @DisplayName("repository failures")
    class RepositoryFailures {

        @Test
        @DisplayName("should translate repository errors into OrderServiceException")
        void shouldTranslateRepositoryException() {
            // Arrange
            CreateOrderCommand command = buildCommand();

            when(orderValidator.validate(command)).thenReturn(Collections.emptyList());
            when(orderRepository.save(any(Order.class)))
                    .thenThrow(new RuntimeException("DynamoDB timeout"));

            // Act / Assert
            OrderServiceException ex =
                    assertThrows(OrderServiceException.class, () -> handler.handle(command));

            Assertions.assertThat(ex.getMessage()).contains("unable to create order");
            verify(metricsPublisher).publishCounter("orders.failed", 1);
        }
    }

    /* --------------------------------------------------------------------- */
    /* Helpers                                                               */
    /* --------------------------------------------------------------------- */

    private CreateOrderCommand buildCommand() {
        return CreateOrderCommand.builder()
                                 .patientId("patient-123")
                                 .clinicianId("clinician-456")
                                 .externalRef("ehr-789")
                                 .dosage("2mg")
                                 .schedule("q6h")
                                 .build();
    }
}