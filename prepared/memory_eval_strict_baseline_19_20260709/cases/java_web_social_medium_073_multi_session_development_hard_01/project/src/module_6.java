```java
package com.edupulse.core.event;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.Closeable;
import java.io.IOException;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Module6 – Domain-Event Dispatcher & Registry
 *
 * <p>This component is the in-process backbone that glues together EduPulse’s
 * event-driven workflow.  It provides:
 *
 * <ol>
 *   <li>Type-safe listener registration</li>
 *   <li>Asynchronous, fault-tolerant delivery</li>
 *   <li>Graceful degradation under back-pressure</li>
 *   <li>Metrics hooks for observability (slf4j logging for brevity)</li>
 * </ol>
 *
 * <p>External adapters (e.g., RabbitMQ, Kafka, or WebSocket gateways) can
 * publish messages here to disseminate cross-service events to the local JVM,
 * while internal services (Assessment, Notification, Payment) can emit domain
 * events to be picked up by remote subscribers through an outbound bridge.</p>
 *
 * <h3>Usage</h3>
 * <pre>{@code
 * Module6 eventBus = Module6.getInstance();
 *
 * eventBus.registerListener(PulsePostedEvent.class, event -> {
 *     // update news-feed, award badges, etc.
 * });
 *
 * eventBus.publish(new PulsePostedEvent(authorId, pulseId));
 * }</pre>
 */
public final class Module6 implements Closeable {

    // --------------------------------------------------------------------- //
    // Singleton bootstrap                                                   //
    // --------------------------------------------------------------------- //

    private static final Logger LOGGER = LoggerFactory.getLogger(Module6.class);
    private static final Module6 INSTANCE = new Module6();

    /**
     * Thread-pool executor tuned for bursty classroom traffic.
     */
    private final ExecutorService executor;

    /**
     * Map<EventType, List<Listeners>>
     */
    private final ConcurrentMap<Class<? extends DomainEvent>, CopyOnWriteArrayList<DomainEventListener<?>>> listenerRegistry =
            new ConcurrentHashMap<>();

    /**
     * Prevent accidental double shutdown.
     */
    private final AtomicBoolean closed = new AtomicBoolean(false);

    private Module6() {
        int parallelism = Math.max(4, Runtime.getRuntime().availableProcessors() * 2);

        this.executor = new ThreadPoolExecutor(
                parallelism,
                parallelism,
                60L,
                TimeUnit.SECONDS,
                /*
                 * Bounded queue to avoid unbounded RAM consumption when a
                 * lecturer accidentally fires a thousand micro-quizzes at once.
                 */
                new LinkedBlockingQueue<>(4_096),
                new NamedThreadFactory("edupulse-event-dispatcher"),
                /*
                 * When the queue is saturated, run the task on the caller's
                 * thread so we exert natural back-pressure.
                 */
                new ThreadPoolExecutor.CallerRunsPolicy()
        );

        LOGGER.info("Module6 DomainEvent dispatcher initialized " +
                    "(threads={}, queue={})", parallelism, 4_096);
    }

    public static Module6 getInstance() {
        return INSTANCE;
    }

    // --------------------------------------------------------------------- //
    // Public API                                                            //
    // --------------------------------------------------------------------- //

    /**
     * Registers a new listener for the specified event type.
     *
     * @param eventType domain event class
     * @param listener  consumer that processes the event
     * @param <E>       concrete event subtype
     */
    public <E extends DomainEvent> void registerListener(Class<E> eventType,
                                                         DomainEventListener<E> listener) {
        Objects.requireNonNull(eventType, "eventType");
        Objects.requireNonNull(listener, "listener");

        listenerRegistry
                .computeIfAbsent(eventType, key -> new CopyOnWriteArrayList<>())
                .add(listener);

        LOGGER.debug("Registered listener={} for eventType={}",
                listener.getClass().getSimpleName(), eventType.getSimpleName());
    }

    /**
     * Publishes an event to all registered listeners.  Delivery is asynchronous
     * and non-blocking; listeners are invoked on an internal thread-pool and
     * failures are logged without interrupting other consumers.
     *
     * @param event immutable domain event
     */
    public void publish(DomainEvent event) {
        Objects.requireNonNull(event, "event");

        // Notify listeners that have an exact match on event class.
        List<DomainEventListener<?>> listeners = listenerRegistry
                .getOrDefault(event.getClass(), new CopyOnWriteArrayList<>());

        if (listeners.isEmpty()) {
            LOGGER.debug("No local listeners for eventType={} (correlationId={})",
                    event.getClass().getSimpleName(), event.correlationId());
            return;
        }

        for (DomainEventListener<?> raw : listeners) {
            @SuppressWarnings("unchecked")
            DomainEventListener<DomainEvent> listener = (DomainEventListener<DomainEvent>) raw;

            executor.submit(() -> safeInvoke(listener, event));
        }
    }

    /**
     * Drains the executor and stops accepting new events. Blocking.
     */
    @Override
    public void close() throws IOException {
        if (!closed.compareAndSet(false, true)) {
            return;
        }

        LOGGER.info("Shutting down Module6 event dispatcher …");

        executor.shutdown(); // disable new tasks

        try {
            if (!executor.awaitTermination(30, TimeUnit.SECONDS)) {
                LOGGER.warn("Forcing shutdown of event dispatcher (tasks still running)");
                executor.shutdownNow();
            }
        } catch (InterruptedException ie) {
            executor.shutdownNow();
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while shutting down dispatcher", ie);
        }

        LOGGER.info("Event dispatcher terminated");
    }

    // --------------------------------------------------------------------- //
    // Internal helpers                                                      //
    // --------------------------------------------------------------------- //

    private void safeInvoke(DomainEventListener<DomainEvent> listener, DomainEvent event) {
        try {
            listener.onEvent(event);
        } catch (Exception ex) {
            LOGGER.error("Listener [{}] failed for eventType={} (correlationId={})",
                    listener.getClass().getSimpleName(),
                    event.getClass().getSimpleName(),
                    event.correlationId(),
                    ex);
        }
    }

    // --------------------------------------------------------------------- //
    // Domain abstractions                                                   //
    // --------------------------------------------------------------------- //

    /**
     * Marker interface for an immutable domain event.  Events should be simple
     * DTOs – no behavior – and <strong>never</strong> mutated after creation.
     */
    public interface DomainEvent {

        /**
         * When did the event occur (UTC).
         */
        Instant occurredOn();

        /**
         * Correlates a chain of events spawned by a single user action or
         * request.  Useful for tracing in a distributed system.
         */
        String correlationId();
    }

    /**
     * Functional interface for event listeners.
     */
    @FunctionalInterface
    public interface DomainEventListener<E extends DomainEvent> {
        void onEvent(E event) throws Exception;
    }

    // --------------------------------------------------------------------- //
    // Example concrete events                                               //
    // --------------------------------------------------------------------- //

    /**
     * Emitted when a student posts a new micro-learning pulse.
     */
    public static final class PulsePostedEvent implements DomainEvent {

        private final Instant occurredOn = Instant.now();
        private final String correlationId = UUID.randomUUID().toString();

        private final String authorId;
        private final String pulseId;

        public PulsePostedEvent(String authorId, String pulseId) {
            this.authorId = Objects.requireNonNull(authorId, "authorId");
            this.pulseId = Objects.requireNonNull(pulseId, "pulseId");
        }

        public String authorId() {
            return authorId;
        }

        public String pulseId() {
            return pulseId;
        }

        @Override
        public Instant occurredOn() {
            return occurredOn;
        }

        @Override
        public String correlationId() {
            return correlationId;
        }

        @Override
        public String toString() {
            return "PulsePostedEvent{" +
                    "authorId='" + authorId + '\'' +
                    ", pulseId='" + pulseId + '\'' +
                    ", occurredOn=" + occurredOn +
                    ", correlationId='" + correlationId + '\'' +
                    '}';
        }
    }

    /**
     * Emitted when a payment intent is created (e.g., for premium bundles).
     */
    public static final class PaymentInitiatedEvent implements DomainEvent {

        private final Instant occurredOn = Instant.now();
        private final String correlationId = UUID.randomUUID().toString();

        private final String userId;
        private final long amountInCents;
        private final String currency;
        private final String paymentProviderReference;

        public PaymentInitiatedEvent(String userId,
                                     long amountInCents,
                                     String currency,
                                     String paymentProviderReference) {
            this.userId = Objects.requireNonNull(userId, "userId");
            this.amountInCents = amountInCents;
            this.currency = Objects.requireNonNull(currency, "currency");
            this.paymentProviderReference = Objects.requireNonNull(paymentProviderReference,
                    "paymentProviderReference");
        }

        public String userId() {
            return userId;
        }

        public long amountInCents() {
            return amountInCents;
        }

        public String currency() {
            return currency;
        }

        public String paymentProviderReference() {
            return paymentProviderReference;
        }

        @Override
        public Instant occurredOn() {
            return occurredOn;
        }

        @Override
        public String correlationId() {
            return correlationId;
        }

        @Override
        public String toString() {
            return "PaymentInitiatedEvent{" +
                    "userId='" + userId + '\'' +
                    ", amountInCents=" + amountInCents +
                    ", currency='" + currency + '\'' +
                    ", paymentProviderReference='" + paymentProviderReference + '\'' +
                    ", occurredOn=" + occurredOn +
                    ", correlationId='" + correlationId + '\'' +
                    '}';
        }
    }

    // --------------------------------------------------------------------- //
    // Infrastructure – custom thread factory                                //
    // --------------------------------------------------------------------- //

    /**
     * Gives threads meaningful names for easier debugging/profiling.
     */
    private static final class NamedThreadFactory implements ThreadFactory {

        private final String baseName;
        private final ThreadFactory delegate = Executors.defaultThreadFactory();
        private final AtomicInteger counter = new AtomicInteger(1);

        private NamedThreadFactory(String baseName) {
            this.baseName = baseName;
        }

        @Override
        public Thread newThread(Runnable r) {
            Thread thread = delegate.newThread(r);
            thread.setName(baseName + "-" + counter.getAndIncrement());
            thread.setDaemon(false);
            return thread;
        }
    }

    // --------------------------------------------------------------------- //
    // Demonstration main (optional)                                         //
    // --------------------------------------------------------------------- //

    /**
     * Simple smoke-test; remove or disable in production.
     */
    public static void main(String[] args) throws Exception {
        Module6 bus = Module6.getInstance();

        // Listen for pulse events
        bus.registerListener(PulsePostedEvent.class, event -> {
            LOGGER.info("NewsFeedService consumed {}", event);
        });

        // Listen for payments
        bus.registerListener(PaymentInitiatedEvent.class, event -> {
            LOGGER.info("BillingService consumed {}", event);
        });

        bus.publish(new PulsePostedEvent("u42", "pulse777"));
        bus.publish(new PaymentInitiatedEvent("u42", 4999, "USD", "STRIPE_PI_123"));

        // Let async tasks finish before shutting down the demo
        bus.executor.awaitTermination(2, TimeUnit.SECONDS);
        bus.close();
    }
}
```