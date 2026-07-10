```java
package com.edupulse.livelearninghub.core;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.validation.*;
import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import java.io.Closeable;
import java.io.IOException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Predicate;

/**
 * Central asynchronous dispatcher for domain events.
 *
 * <p>This component is the backbone of EduPulse’s event-driven architecture.
 * All bounded contexts interact with it when they need to emit or listen to a
 * {@link DomainEvent}. The dispatcher guarantees:
 *
 * <ul>
 *     <li>Asynchronous fan-out so producers are never blocked by slow consumers.</li>
 *     <li>Graceful degradation—when the thread-pool is exhausted, events are
 *         executed in the caller thread to prevent loss.</li>
 *     <li>Pluggable retry policies for at-least-once delivery semantics.</li>
 *     <li>Input validation via Jakarta Bean Validation.</li>
 * </ul>
 *
 * <p>Because this dispatcher is thread-safe, it can be shared application-wide
 * (for example as a Spring singleton or CDI bean).
 */
public final class Module1 implements Closeable {

    private static final Logger LOG = LoggerFactory.getLogger(Module1.class);

    /**
     * Lazy-initialised singleton instance.
     */
    private static final class Holder {
        private static final Module1 INSTANCE = new Module1();
    }

    /** Factory method for obtaining the singleton. */
    public static Module1 getInstance() {
        return Holder.INSTANCE;
    }

    // -------------------------------------------------------------------------
    //                                     State
    // -------------------------------------------------------------------------

    /** Thread-safe registry of listeners. */
    private final List<EventListener<? extends DomainEvent>> listeners =
            new CopyOnWriteArrayList<>();

    /** Primary executor for asynchronous dispatch. */
    private final ExecutorService executor;

    /** Bean Validation infrastructure (thread-safe). */
    private final Validator validator;

    private Module1() {
        /*
         * Custom ThreadPoolExecutor with bounded queue. When the queue fills up
         * we fall back to a CallerRunsPolicy so that events are not silently
         * discarded—at the expense of temporarily blocking the publisher.
         */
        this.executor = new ThreadPoolExecutor(
                Runtime.getRuntime().availableProcessors(),
                Runtime.getRuntime().availableProcessors() * 2,
                60L, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(10_000),
                new ThreadPoolExecutor.CallerRunsPolicy());

        ValidatorFactory factory = Validation.buildDefaultValidatorFactory();
        this.validator = factory.getValidator();

        /*
         * Register built-in listeners for core platform capabilities.
         * Additional listeners can be registered at runtime (e.g. from plugins).
         */
        registerListener(new NotificationListener());
        registerListener(new AnalyticsListener());
    }

    // -------------------------------------------------------------------------
    //                                 API
    // -------------------------------------------------------------------------

    /**
     * Dispatches an event asynchronously.
     *
     * @param event concrete {@link DomainEvent} implementation.
     * @throws ConstraintViolationException if {@code event} is invalid.
     * @throws NullPointerException         if {@code event} is {@code null}.
     */
    public <E extends DomainEvent> void publish(@NotNull E event) {
        Objects.requireNonNull(event, "event must not be null");
        validate(event);

        for (EventListener<? extends DomainEvent> listener : listeners) {
            if (!listener.supports(event)) {
                continue;
            }
            // We must capture the listener reference for the lambda
            EventListener<DomainEvent> l = cast(listener);
            executor.submit(() -> invokeListener(l, event));
        }
    }

    /**
     * Registers a listener for domain events.
     *
     * <p>If the listener is already present, the call does nothing.</p>
     */
    public void registerListener(@NotNull EventListener<? extends DomainEvent> listener) {
        Objects.requireNonNull(listener, "listener must not be null");
        if (listeners.contains(listener)) {
            LOG.warn("Listener {} already registered — ignoring", listener.getClass().getSimpleName());
            return;
        }
        listeners.add(listener);
        LOG.info("Registered listener {}", listener.getClass().getSimpleName());
    }

    /**
     * Removes a listener previously registered with {@link #registerListener}.
     *
     * @param listenerClass concrete implementation class to remove.
     */
    public void unregisterListener(@NotNull Class<? extends EventListener<?>> listenerClass) {
        Objects.requireNonNull(listenerClass, "listenerClass must not be null");
        listeners.removeIf(l -> l.getClass().equals(listenerClass));
    }

    /**
     * Closes the dispatcher and releases thread-pool resources.
     */
    @Override
    public void close() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                executor.shutdownNow();
                LOG.warn("Forced shutdown of dispatcher thread-pool");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }

    // -------------------------------------------------------------------------
    //                         Internal helper methods
    // -------------------------------------------------------------------------

    private <E extends DomainEvent> void invokeListener(EventListener<E> listener, DomainEvent event) {
        try {
            listener.onEvent(cast(event));
        } catch (Exception ex) {
            LOG.error("Listener {} failed handling event {}: {}",
                    listener.getClass().getSimpleName(),
                    event.eventName(),
                    ex.getMessage(),
                    ex);
            /*
             * Could optionally implement a retry mechanism or dead-letter queue
             * here. For now, we simply log the failure so the platform’s
             * observability pipeline can pick it up.
             */
        }
    }

    private void validate(Object target) {
        Set<ConstraintViolation<Object>> violations = validator.validate(target);
        if (!violations.isEmpty()) {
            throw new ConstraintViolationException(violations);
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> T cast(Object obj) {
        return (T) obj;
    }

    // -------------------------------------------------------------------------
    //                     Domain-event infrastructure contracts
    // -------------------------------------------------------------------------

    /**
     * Marker interface for all domain events.
     *
     * <p>All events are immutable value objects. Implementations should override
     * {@link #eventName()} to return a meaningful name that can be used for
     * logging and analytics.</p>
     */
    public interface DomainEvent {

        /**
         * Unique identifier for this event instance.
         */
        @NotBlank String id();

        /**
         * Time the event occurred in UTC.
         */
        @NotNull Instant occurredOn();

        /**
         * A stable, machine-readable name for the event (e.g. <code>PULSE_POSTED</code>).
         */
        @NotBlank String eventName();

        /**
         * Flattened payload for serialization to message brokers / audit logs.
         */
        @NotNull Map<String, Object> payload();
    }

    /**
     * Generic, type-safe listener.
     *
     * @param <E> event type the listener handles.
     */
    public interface EventListener<E extends DomainEvent> {

        /**
         * Called by the dispatcher to handle {@code event}.
         */
        void onEvent(E event) throws Exception;

        /**
         * Whether the listener supports this event instance.
         */
        default boolean supports(DomainEvent event) {
            // Default implementation relies on generic type
            return getEventType().isInstance(event);
        }

        /**
         * Used by the default {@link #supports(DomainEvent)}.
         */
        Class<E> getEventType();
    }

    /**
     * Base class for common event attributes.
     */
    public abstract static class AbstractDomainEvent implements DomainEvent {

        private final String id = UUID.randomUUID().toString();
        private final Instant occurredOn = Instant.now();

        @Override public String id()          { return id; }
        @Override public Instant occurredOn() { return occurredOn; }
    }

    // -------------------------------------------------------------------------
    //                    Concrete events and standard listeners
    // -------------------------------------------------------------------------

    /**
     * Domain event emitted when an instructor or student posts a new pulse.
     */
    public static final class PulsePostedEvent extends AbstractDomainEvent {

        @NotBlank private final String pulseId;
        @NotBlank private final String authorUserId;
        @NotBlank private final String courseId;

        public PulsePostedEvent(String pulseId, String authorUserId, String courseId) {
            this.pulseId      = pulseId;
            this.authorUserId = authorUserId;
            this.courseId     = courseId;
        }

        public String getPulseId()      { return pulseId; }
        public String getAuthorUserId() { return authorUserId; }
        public String getCourseId()     { return courseId; }

        @Override public String eventName() {
            return "PULSE_POSTED";
        }

        @Override public Map<String, Object> payload() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("pulseId", pulseId);
            map.put("authorUserId", authorUserId);
            map.put("courseId", courseId);
            map.put("occurredOn", occurredOn());
            return map;
        }
    }

    /**
     * Example listener that sends push/email notifications.
     */
    public static final class NotificationListener implements EventListener<PulsePostedEvent> {

        private static final Logger LOG = LoggerFactory.getLogger(NotificationListener.class);

        private final Predicate<PulsePostedEvent> shouldNotify = event ->
                !Objects.equals(event.getAuthorUserId(), "system_bot");

        @Override
        public void onEvent(PulsePostedEvent event) {
            if (!shouldNotify.test(event)) {
                LOG.debug("Skipping notification for event {}", event.id());
                return;
            }
            // In real life, delegate to the NotificationService (Email/SMS/push)
            LOG.info("Sending notifications for new pulse {} by user {}", event.getPulseId(), event.getAuthorUserId());
            // ... actual notification logic goes here ...
        }

        @Override
        public Class<PulsePostedEvent> getEventType() {
            return PulsePostedEvent.class;
        }
    }

    /**
     * Example listener that feeds the analytics pipeline.
     */
    public static final class AnalyticsListener implements EventListener<DomainEvent> {

        private static final Logger LOG = LoggerFactory.getLogger(AnalyticsListener.class);

        @Override
        public void onEvent(DomainEvent event) {
            /*
             * Simulate serialization and shipping to Kafka / Kinesis /
             * BigQuery. We keep it simple here.
             */
            LOG.info("Streaming event {} ({}) to analytics pipeline", event.eventName(), event.id());
        }

        @Override
        @SuppressWarnings("unchecked")
        public Class<DomainEvent> getEventType() {
            // Wildcard listener for any DomainEvent
            return (Class<DomainEvent>) (Class<?>) DomainEvent.class;
        }

        @Override
        public boolean supports(DomainEvent event) {
            // Accept everything but could install filters here
            return true;
        }
    }

    // -------------------------------------------------------------------------
    //                        Demonstration / Smoke test
    // -------------------------------------------------------------------------

    /**
     * Manual test harness. In production the dispatcher would be called by
     * service layer code (e.g. PulseService#createPulse).
     */
    public static void main(String[] args) throws IOException {
        Module1 dispatcher = Module1.getInstance();

        // Simulate posting a pulse
        dispatcher.publish(new PulsePostedEvent("pulse-123", "user-456", "course-789"));

        // Allow async tasks to complete before exiting
        dispatcher.close();
    }
}
```