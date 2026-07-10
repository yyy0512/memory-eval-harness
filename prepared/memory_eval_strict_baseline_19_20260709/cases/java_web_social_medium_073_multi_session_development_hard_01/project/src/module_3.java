package com.edupulse.platform.event;

import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * A lightweight, intra-JVM event-dispatching module that mirrors the
 * cross-service message-broker topology used in production. It enables
 * decoupled publication and asynchronous handling of domain events
 * within a single service boundary.
 *
 * <p>While the file name is unconventional, the {@code module_3}
 * class purposefully exposes all necessary types—events, listeners,
 * and a dispatcher—so that other packages can interact without tight
 * coupling to the underlying implementation details.</p>
 *
 * <p>Usage example:
 * <pre>{@code
 *     // Wire up default listeners
 *     module_3.bootstrap();
 *
 *     // Publish some events
 *     module_3.dispatcher().publish(
 *         new module_3.PulseCreatedEvent(UUID.randomUUID(), UUID.randomUUID(), "Event-Driven 101"));
 * }</pre>
 * </p>
 */
public final class module_3 {

    private static final Logger LOGGER = Logger.getLogger(module_3.class.getName());

    /* ───────────────────────── Dispatcher Singleton ───────────────────────── */

    /**
     * Shared dispatcher instance used application-wide.  Acts as a thin façade
     * around an {@link ExecutorService}-backed, non-blocking event bus.
     */
    private static final EventDispatcher DISPATCHER =
            new EventDispatcher(Runtime.getRuntime().availableProcessors());

    private module_3() {
        /* static-only class */
    }

    /**
     * Obtains the singleton {@link EventDispatcher}.
     */
    public static EventDispatcher dispatcher() {
        return DISPATCHER;
    }

    /* ──────────────────────────── Domain Event API ─────────────────────────── */

    /**
     * Marker interface for immutable domain events.
     */
    public interface Event {
        UUID id();

        Instant occurredAt();

        /**
         * Human-readable type, defaults to concrete class name.
         */
        String type();
    }

    /**
     * Base class supplying common event metadata.
     */
    public abstract static class AbstractEvent implements Event {
        private final UUID id = UUID.randomUUID();
        private final Instant occurredAt = Instant.now();

        @Override
        public UUID id() {
            return id;
        }

        @Override
        public Instant occurredAt() {
            return occurredAt;
        }

        @Override
        public String type() {
            return getClass().getSimpleName();
        }
    }

    /* ────────────────────────── Concrete Event Types ───────────────────────── */

    /**
     * Raised when a learner publishes a new “pulse”.
     */
    public static final class PulseCreatedEvent extends AbstractEvent {
        private final UUID pulseId;
        private final UUID authorId;
        private final String title;

        public PulseCreatedEvent(UUID pulseId, UUID authorId, String title) {
            this.pulseId = Objects.requireNonNull(pulseId, "pulseId must not be null");
            this.authorId = Objects.requireNonNull(authorId, "authorId must not be null");
            this.title = Objects.requireNonNull(title, "title must not be null");
        }

        public UUID getPulseId() {
            return pulseId;
        }

        public UUID getAuthorId() {
            return authorId;
        }

        public String getTitle() {
            return title;
        }

        @Override
        public String toString() {
            return String.format("PulseCreatedEvent{id=%s, pulseId=%s, authorId=%s, title='%s'}",
                                 id(), pulseId, authorId, title);
        }
    }

    /**
     * Raised when a user starts a payment flow.
     */
    public static final class PaymentInitiatedEvent extends AbstractEvent {
        private final UUID paymentId;
        private final UUID userId;
        private final double amount;
        private final String currency;

        public PaymentInitiatedEvent(UUID paymentId,
                                     UUID userId,
                                     double amount,
                                     String currency) {
            if (amount <= 0) {
                throw new IllegalArgumentException("amount must be positive");
            }
            this.paymentId = Objects.requireNonNull(paymentId, "paymentId");
            this.userId = Objects.requireNonNull(userId, "userId");
            this.amount = amount;
            this.currency = Objects.requireNonNull(currency, "currency");
        }

        public UUID getPaymentId() {
            return paymentId;
        }

        public UUID getUserId() {
            return userId;
        }

        public double getAmount() {
            return amount;
        }

        public String getCurrency() {
            return currency;
        }

        @Override
        public String toString() {
            return String.format("PaymentInitiatedEvent{id=%s, paymentId=%s, userId=%s, amount=%.2f %s}",
                                 id(), paymentId, userId, amount, currency);
        }
    }

    /* ───────────────────────── Listener & Dispatcher ───────────────────────── */

    /**
     * Functional interface for event handlers.
     *
     * @param <T> concrete {@link Event} subtype
     */
    @FunctionalInterface
    public interface EventListener<T extends Event> {
        void onEvent(T event) throws Exception;
    }

    /**
     * Central asynchronous dispatcher; listeners are invoked on a managed
     * thread-pool with back-pressure provided by a bounded queue.
     */
    public static final class EventDispatcher implements AutoCloseable {

        private final ConcurrentMap<Class<? extends Event>,
                                    CopyOnWriteArrayList<EventListener<?>>> listeners =
                new ConcurrentHashMap<>();

        private final ExecutorService executor;

        private EventDispatcher(int parallelism) {
            final int core = Math.max(2, parallelism);
            final int max  = core * 2;

            this.executor = new ThreadPoolExecutor(
                    core,
                    max,
                    60L,
                    TimeUnit.SECONDS,
                    new LinkedBlockingQueue<>(10_000),
                    new NamedDaemonThreadFactory("edupulse-event"),
                    new ThreadPoolExecutor.CallerRunsPolicy());
        }

        /**
         * Registers a listener for the specified {@code eventType}.
         */
        public <T extends Event> void registerListener(Class<T> eventType,
                                                       EventListener<T> listener) {
            Objects.requireNonNull(eventType, "eventType");
            Objects.requireNonNull(listener, "listener");

            listeners
                    .computeIfAbsent(eventType, ignored -> new CopyOnWriteArrayList<>())
                    .add(listener);

            LOGGER.info(() -> String.format("Listener %s registered for %s",
                                            listener, eventType.getSimpleName()));
        }

        /**
         * Publishes an event asynchronously. If no listener is present,
         * a warning is logged but the call still succeeds.
         */
        public void publish(Event event) {
            Objects.requireNonNull(event, "event");

            var eventType = event.getClass();
            var registered = listeners.getOrDefault(eventType,
                                                    new CopyOnWriteArrayList<>());

            if (registered.isEmpty()) {
                LOGGER.warning(() -> "No listeners registered for " + eventType.getSimpleName());
                return;
            }

            registered.forEach(listener -> dispatch(listener, event));
        }

        @SuppressWarnings({"unchecked", "rawtypes"})
        private void dispatch(EventListener listener, Event event) {
            executor.submit(() -> {
                try {
                    listener.onEvent(event);
                    LOGGER.fine(() -> String.format("Event %s handled by %s",
                                                    event.type(), listener));
                } catch (Exception ex) {
                    LOGGER.log(Level.SEVERE,
                               String.format("Listener %s failed to process %s",
                                             listener, event),
                               ex);
                }
            });
        }

        /**
         * Flushes queued tasks and stops the dispatcher gracefully.
         */
        public void flushAndAwaitTermination(Duration timeout) {
            executor.shutdown();
            try {
                if (!executor.awaitTermination(timeout.toMillis(), TimeUnit.MILLISECONDS)) {
                    LOGGER.warning("Timed out waiting for event dispatcher to shut down");
                    executor.shutdownNow();
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                executor.shutdownNow();
            }
        }

        @Override
        public void close() {
            flushAndAwaitTermination(Duration.ofSeconds(10));
        }
    }

    /* ─────────────────────────── Example Listeners ─────────────────────────── */

    /**
     * Updates learner and content analytics upon new pulse creation.
     */
    public static final class AnalyticsListener implements EventListener<PulseCreatedEvent> {

        private static final Logger LOGGER = Logger.getLogger(AnalyticsListener.class.getName());

        @Override
        public void onEvent(PulseCreatedEvent event) {
            // Simulate I/O or DB call
            LOGGER.info(() -> "Updating analytics for pulse " + event.getPulseId());
        }
    }

    /**
     * Routes payments to the external gateway.
     */
    public static final class PaymentListener implements EventListener<PaymentInitiatedEvent> {

        private static final Logger LOGGER = Logger.getLogger(PaymentListener.class.getName());

        @Override
        public void onEvent(PaymentInitiatedEvent event) {
            LOGGER.info(() -> "Processing payment " + event.getPaymentId()
                               + " for user " + event.getUserId());
            // Integration point: external payment SDK / REST call
        }
    }

    /* ────────────────────────── Bootstrap Convenience ──────────────────────── */

    /**
     * Registers default listeners used by the core EduPulse services.
     * Call once at application startup.
     */
    public static void bootstrap() {
        var d = dispatcher();
        d.registerListener(PulseCreatedEvent.class, new AnalyticsListener());
        d.registerListener(PaymentInitiatedEvent.class, new PaymentListener());
    }

    /* ───────────────────────────── Demo Main ──────────────────────────────── */

    public static void main(String[] args) {
        bootstrap();

        var d = dispatcher();
        d.publish(new PulseCreatedEvent(
                UUID.randomUUID(),
                UUID.randomUUID(),
                "Event-Driven Architecture 101"));

        d.publish(new PaymentInitiatedEvent(
                UUID.randomUUID(),
                UUID.randomUUID(),
                99.99,
                "USD"));

        d.flushAndAwaitTermination(Duration.ofSeconds(5));
    }

    /* ────────────────────────── Helper ThreadFactory ───────────────────────── */

    private static final class NamedDaemonThreadFactory implements ThreadFactory {
        private final AtomicInteger seq = new AtomicInteger();
        private final String           prefix;

        private NamedDaemonThreadFactory(String prefix) {
            this.prefix = prefix;
        }

        @Override
        public Thread newThread(Runnable r) {
            Thread t = new Thread(r, prefix + "-" + seq.incrementAndGet());
            t.setDaemon(true);
            return t;
        }
    }
}