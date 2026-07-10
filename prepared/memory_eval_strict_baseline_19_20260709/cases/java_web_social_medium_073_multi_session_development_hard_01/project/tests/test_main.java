```java
/*
 * Copyright (c) 2024.
 * EduPulse Live Learning Hub — Tests
 *
 * These tests exercise the most business–critical code paths that power the
 * event-driven workflow behind pulse creation, payment initiation, and user
 * notifications.  While the production implementations live in their respective
 * modules (service, domain, messaging, notification), the tests below validate
 * contract-level behaviour in isolation via Mockito and Awaitility.
 *
 * NOTE:
 *  • All domain / service classes referenced here (PulseService, PaymentService,
 *    DomainEventPublisher, etc.) are part of the production code-base and are
 *    intentionally not re-implemented in the test source-set.
 *  • The file purposefully avoids a public top-level class so that the file
 *    name does not have to match a public class identifier.
 */

package com.edupulse.tests;

import com.edupulse.domain.events.DomainEvent;
import com.edupulse.domain.events.PulseCreatedEvent;
import com.edupulse.domain.events.PaymentInitiatedEvent;
import com.edupulse.domain.pulse.Pulse;
import com.edupulse.domain.pulse.PulseBuilder;
import com.edupulse.domain.pulse.VisibilityScope;
import com.edupulse.domain.user.User;
import com.edupulse.domain.user.UserId;
import com.edupulse.messaging.DomainEventPublisher;
import com.edupulse.persistence.PulseRepository;
import com.edupulse.service.PaymentService;
import com.edupulse.service.PulseService;
import com.edupulse.service.dto.PaymentRequest;
import com.edupulse.service.dto.PulseDTO;
import com.edupulse.notifications.EmailNotificationService;
import com.edupulse.payments.gateway.PaymentGateway;

import org.awaitility.Awaitility;
import org.awaitility.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.mockito.Captor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Mockito;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * Tests related to Pulse creation & event emission.
 */
@Tag("pulse")
@ExtendWith(MockitoExtension.class)
class PulseServiceTest {

    @Mock
    private PulseRepository pulseRepository;

    @Mock
    private DomainEventPublisher eventPublisher;

    @InjectMocks
    private PulseService pulseService;   // real service, mocks injected

    @Captor
    private ArgumentCaptor<DomainEvent> eventCaptor;

    @AfterEach
    void tearDown() {
        Mockito.verifyNoMoreInteractions(eventPublisher, pulseRepository);
    }

    @Test
    @DisplayName("Creating a valid pulse persists to repository and publishes PulseCreatedEvent")
    void createPulse_persistsAndEmitsEvent() {
        // Arrange
        User author = new User(new UserId("stu-123"), "Ada Lovelace", "ada@edupulse.io");
        PulseDTO dto = new PulseDTO(
                "Intro to Algorithms",
                "Divide & conquer, recursion and algorithms design tips.",
                VisibilityScope.PUBLIC,
                author.getId());

        Pulse fakePersistedPulse = PulseBuilder.from(dto, author)
                .withId("pulse-001")
                .withPublishedAt(Instant.now())
                .build();

        when(pulseRepository.save(any(Pulse.class))).thenReturn(fakePersistedPulse);

        // Act
        Pulse createdPulse = pulseService.createPulse(dto);

        // Assert
        assertNotNull(createdPulse.getId(), "Expected repository to assign an id");
        assertEquals("Intro to Algorithms", createdPulse.getTitle());

        // Capture & verify emitted domain event
        verify(eventPublisher, times(1)).publish(eventCaptor.capture());
        DomainEvent event = eventCaptor.getValue();
        assertTrue(event instanceof PulseCreatedEvent, "Expected PulseCreatedEvent");
        assertEquals(createdPulse.getId(), ((PulseCreatedEvent) event).getPulseId());
        verify(pulseRepository, times(1)).save(any(Pulse.class));
    }

    @ParameterizedTest(name = "Invalid Pulse[{index}] => \"{0}\"")
    @MethodSource("invalidPulses")
    @DisplayName("Invalid pulses throw IllegalArgumentException and no event is emitted")
    void createPulse_invalidInput_throws(String title, String content) {
        // Arrange
        UserId authorId = new UserId("stu-456");
        PulseDTO invalidDto = new PulseDTO(title, content, VisibilityScope.PRIVATE, authorId);

        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> pulseService.createPulse(invalidDto));
        verify(eventPublisher, never()).publish(any());
        verify(pulseRepository, never()).save(any());
    }

    private static Stream<String[]> invalidPulses() {
        return Stream.of(
                new String[]{"", "Valid content but empty title"},
                new String[]{"   ", "Whitespace title"},
                new String[]{"Valid title", ""}            // empty content
        );
    }
}

/**
 * Tests around payment workflow and downstream side-effects (email notification).
 */
@Tag("payment")
@ExtendWith(MockitoExtension.class)
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class PaymentServiceTest {

    @Mock
    private PaymentGateway paymentGateway;

    @Mock
    private EmailNotificationService emailNotificationService;

    @Mock
    private DomainEventPublisher eventPublisher;

    @InjectMocks
    private PaymentService paymentService;  // real service with mocks

    @Captor
    private ArgumentCaptor<DomainEvent> eventCaptor;

    @Test
    @DisplayName("Happy-path: payment authorisation succeeds and triggers event + email")
    @Timeout(value = 5, unit = TimeUnit.SECONDS)
    void processPayment_successfulFlow() {
        // Arrange
        PaymentRequest request = new PaymentRequest(
                new UserId("stu-789"),
                "course-42",
                1299 /* cents */,
                "tok_test_visa_4242"
        );

        // Simulate asynchronous gateway authorisation
        when(paymentGateway.authorise(request)).thenReturn(CompletableFuture.completedFuture(true));

        // Act
        CompletableFuture<Boolean> resultPromise = paymentService.initiatePayment(request);

        // Await completion
        Boolean result = Awaitility.await()
                                   .atMost(Duration.FIVE_SECONDS)
                                   .until(resultPromise::isDone, isDone -> isDone)
                                   ? resultPromise.join() : null;

        // Assert authorisation result
        assertNotNull(result);
        assertTrue(result, "Expected payment to be authorised");

        // Verify downstream email dispatch
        verify(emailNotificationService, timeout(2000).times(1))
                .sendPaymentReceipt(eq(request.userId()), eq(request.courseId()), any());

        // Verify domain event emission
        verify(eventPublisher, times(1)).publish(eventCaptor.capture());
        assertTrue(eventCaptor.getValue() instanceof PaymentInitiatedEvent);
        PaymentInitiatedEvent evt = (PaymentInitiatedEvent) eventCaptor.getValue();
        assertEquals(request.userId(), evt.getUserId());
        assertEquals(request.courseId(), evt.getCourseId());
    }

    @Test
    @DisplayName("Payment failure bubbles up as exception and no email/event are dispatched")
    void processPayment_failureFlow() {
        // Arrange
        PaymentRequest faultyRequest = new PaymentRequest(
                new UserId("stu-error"),
                "course-99",
                1599,
                "tok_charge_declined"    // invalid test token
        );

        when(paymentGateway.authorise(faultyRequest))
                .thenReturn(CompletableFuture.failedFuture(new RuntimeException("Card declined")));

        // Act & Assert
        RuntimeException ex = assertThrows(RuntimeException.class,
                () -> paymentService.initiatePayment(faultyRequest).join());

        assertEquals("Card declined", ex.getMessage());

        // Ensure no side-effects
        verify(emailNotificationService, never()).sendPaymentReceipt(any(), any(), any());
        verify(eventPublisher, never()).publish(any(DomainEvent.class));
    }
}
```