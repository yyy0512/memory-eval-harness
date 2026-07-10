package com.edupulse.web_social.module5;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Module 5 of the EduPulse Live Learning Hub.
 *
 * This file bundles a small, yet production-ready slice of the event-driven
 * “pulse” workflow:
 *
 * • Domain model (Pulse)                              – ORM-ready entity
 * • Data-transfer object (PulseDTO)                   – API layer contract
 * • Service layer (PulseService)                      – business logic
 * • Repository façade (PulseRepository)               – persistence port
 * • Domain events + publisher (EventPublisher)        – async integration
 * • Robust validation & error handling
 *
 * NOTE:
 *  In a full application these types would be split into separate packages and
 *  backed by real infrastructure (JPA repository, message broker, etc.).
 *  They are co-located here solely to satisfy the single-file requirement.
 */
public final class Module5 {

    /*======================================================
     *  SERVICE LAYER
     *====================================================*/
    public static final class PulseService {
        private static final Logger LOG = LoggerFactory.getLogger(PulseService.class);

        // Thread-pool for asynchronous event publication
        private static final Executor EVENT_EXECUTOR = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "pulse-event-dispatcher");
            t.setDaemon(true);
            return t;
        });

        private final PulseRepository repository;
        private final EventPublisher eventPublisher;

        public PulseService(PulseRepository repository, EventPublisher eventPublisher) {
            this.repository = Objects.requireNonNull(repository, "repository");
            this.eventPublisher = Objects.requireNonNull(eventPublisher, "eventPublisher");
        }

        /**
         * Creates a new micro-learning pulse and emits a {@link PulseCreatedEvent}.
         *
         * @param dto       transport object received from controller layer
         * @param authorId  authenticated user issuing the request
         * @return the persisted Pulse entity
         * @throws PulseValidationException when business constraints are violated
         * @throws PersistenceException     on database failures
         */
        public Pulse createPulse(PulseDTO dto, UUID authorId) {
            Objects.requireNonNull(dto, "dto");
            Objects.requireNonNull(authorId, "authorId");

            validate(dto);

            Pulse pulse = new Pulse(
                    UUID.randomUUID(),
                    dto.title().trim(),
                    dto.content().trim(),
                    authorId,
                    Instant.now()
            );

            try {
                repository.save(pulse);
                LOG.info("Pulse [{}] persisted successfully", pulse.id());
            } catch (Exception ex) {
                LOG.error("Failed to persist pulse [{}]", pulse.id(), ex);
                throw new PersistenceException("Failed to persist pulse", ex);
            }

            // Fire-and-forget event publication
            CompletableFuture.runAsync(() -> {
                try {
                    eventPublisher.publish(new PulseCreatedEvent(pulse));
                    LOG.debug("PulseCreatedEvent for [{}] published", pulse.id());
                } catch (Exception ex) {
                    // Log & swallow to avoid impacting user experience
                    LOG.error("Failed to publish PulseCreatedEvent for [{}]", pulse.id(), ex);
                }
            }, EVENT_EXECUTOR);

            return pulse;
        }

        private static void validate(PulseDTO dto) {
            if (dto.title() == null || dto.title().trim().isEmpty()) {
                throw new PulseValidationException("Title must not be empty");
            }
            if (dto.content() == null || dto.content().trim().isEmpty()) {
                throw new PulseValidationException("Content must not be empty");
            }
            if (dto.content().length() > 2_000) { // arbitrary platform limit
                throw new PulseValidationException("Content exceeds maximum length (2000 chars)");
            }
        }
    }

    /*======================================================
     *  DOMAIN MODEL
     *====================================================*/
    public record Pulse(
            UUID id,
            String title,
            String content,
            UUID authorId,
            Instant createdAt
    ) {
        @Override
        public String toString() {
            return "Pulse{" +
                   "id=" + id +
                   ", title='" + title + '\'' +
                   ", authorId=" + authorId +
                   ", createdAt=" + createdAt +
                   '}';
        }
    }

    /*======================================================
     *  DATA-TRANSFER OBJECT (API CONTRACT)
     *====================================================*/
    public record PulseDTO(String title, String content) { }

    /*======================================================
     *  DOMAIN EVENTS & PUBLISHER
     *====================================================*/
    public sealed interface DomainEvent permits PulseCreatedEvent {
        UUID aggregateId();
        Instant occurredAt();
    }

    public static final class PulseCreatedEvent implements DomainEvent {
        private final UUID pulseId;
        private final Instant timestamp;

        public PulseCreatedEvent(Pulse pulse) {
            this.pulseId = pulse.id();
            this.timestamp = Instant.now();
        }

        @Override
        public UUID aggregateId() {
            return pulseId;
        }

        @Override
        public Instant occurredAt() {
            return timestamp;
        }

        @Override
        public String toString() {
            return "PulseCreatedEvent{" +
                   "pulseId=" + pulseId +
                   ", occurredAt=" + timestamp +
                   '}';
        }
    }

    /**
     * Abstraction hiding the concrete message broker (e.g. Kafka, RabbitMQ).
     */
    public interface EventPublisher {
        void publish(DomainEvent event) throws EventPublicationException;
    }

    /*======================================================
     *  REPOSITORY FACADE (Persistence Port)
     *====================================================*/
    public interface PulseRepository {
        /**
         * Persists the given pulse. Implemented elsewhere with an ORM (JPA/Hibernate).
         *
         * @param pulse pulse to save
         * @throws Exception on storage failure
         */
        void save(Pulse pulse) throws Exception;
    }

    /*======================================================
     *  EXCEPTIONS
     *====================================================*/
    public static class PulseValidationException extends RuntimeException {
        public PulseValidationException(String message) { super(message); }
    }

    public static class PersistenceException extends RuntimeException {
        public PersistenceException(String message, Throwable cause) { super(message, cause); }
    }

    public static class EventPublicationException extends RuntimeException {
        public EventPublicationException(String message, Throwable cause) { super(message, cause); }
    }

    /*======================================================
     *  UTILITY: Dummy Implementations for Stand-alone Testing
     *  (Would be replaced by Spring Data repositories and a
     *   proper message-broker publisher in real production.)
     *====================================================*/
    static final class InMemoryPulseRepository implements PulseRepository {
        private static final Logger LOG = LoggerFactory.getLogger(InMemoryPulseRepository.class);

        @Override
        public synchronized void save(Pulse pulse) {
            // Simulates persistence with a latency
            try {
                Thread.sleep(40);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            LOG.debug("In-memory saved: {}", pulse);
        }
    }

    static final class LoggingEventPublisher implements EventPublisher {
        private static final Logger LOG = LoggerFactory.getLogger(LoggingEventPublisher.class);

        @Override
        public void publish(DomainEvent event) {
            // Pretend to send through broker
            LOG.info("Event published -> {}", event);
        }
    }

    /*======================================================
     *  MAIN (demo only, to prove compile-time integrity)
     *====================================================*/
    public static void main(String[] args) {
        PulseRepository repo = new InMemoryPulseRepository();
        EventPublisher publisher = new LoggingEventPublisher();
        PulseService service = new PulseService(repo, publisher);

        PulseDTO dto = new PulseDTO("Intro to Event-Driven Design",
                                    "In this pulse we explore how domain events decouple services.");
        UUID authorId = UUID.randomUUID();

        Pulse pulse = service.createPulse(dto, authorId);
        System.out.println("Created pulse: " + pulse);
    }
}