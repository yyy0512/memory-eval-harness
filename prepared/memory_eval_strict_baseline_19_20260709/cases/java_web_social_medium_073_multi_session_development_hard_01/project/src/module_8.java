```java
package com.edupulse.web_social.module8;

import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import javax.mail.internet.AddressException;
import javax.mail.internet.InternetAddress;
import javax.validation.ConstraintViolation;
import javax.validation.Validation;
import javax.validation.Validator;
import javax.validation.constraints.NotBlank;
import javax.validation.constraints.NotNull;
import javax.validation.constraints.Size;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Module 8 – A lightweight, in-process event bus and reference implementation that
 *            wires together pulse creation, asynchronous fan-out, e-mail notification,
 *            and basic analytics recording without the need for an external broker.
 *
 * This code is NOT meant to replace a fully-fledged message broker such as Kafka or
 * RabbitMQ in production; the goal is to illustrate how events are emitted, validated,
 * handled, and safely retried while adhering to the project’s architectural patterns.
 *
 * All classes (domain events, listeners, services, etc.) are co-located in a single
 * source file for demonstration purposes.
 */
public final class Module8 {

    private static final Logger LOG = LoggerFactory.getLogger(Module8.class);

    private final ExecutorService executor;      // Thread-pool for async dispatching
    private final EventBus eventBus;
    private final PulseService pulseService;

    public Module8() {
        this.executor     = Executors.newCachedThreadPool(new NamedThreadFactory("module8-dispatcher"));
        this.eventBus     = new EventBus(executor);
        this.pulseService = new PulseService(eventBus);

        /*
         * Register listeners. In a real Spring-Boot application you would probably rely
         * on @Component scanning or auto-configuration instead of manual registration.
         */
        this.eventBus
            .register(new NotificationListener())
            .register(new AnalyticsListener());
    }

    /**
     * Entry point for demo & basic smoke testing. In production, this class would be
     * wired through Spring or a dependency-injection container, not invoked directly.
     */
    public static void main(String[] args) throws Exception {
        Module8 module = new Module8();

        PulseCreateRequest request = new PulseCreateRequest(
                42L,
                "Understanding Polymorphism in Java",
                "Polymorphism is a powerful OOP concept that allows objects to be treated as instances of their parent class..."
        );
        long pulseId = module.pulseService.createPulse(request);
        LOG.info("Pulse {} was successfully created.", pulseId);

        /* Give asynchronous listeners time to finish before shutting down. */
        Thread.sleep(1_000);
        module.shutdown();
    }

    public void shutdown() {
        executor.shutdown();
    }

    /* ----------------------------------------------------------------------
     * Event Bus Infrastructure
     * -------------------------------------------------------------------- */

    /**
     * Simple generic event-bus implementation with async fan-out.
     */
    public static final class EventBus {

        private final ExecutorService executor;
        private final ConcurrentMap<Class<?>, CopyOnWriteArrayList<EventListener<?>>> registry = new ConcurrentHashMap<>();

        EventBus(ExecutorService executor) {
            this.executor = Objects.requireNonNull(executor, "executor");
        }

        /**
         * Registers a listener for a specific event type (inferred from generics).
         */
        public <E extends Event> EventBus register(EventListener<E> listener) {
            Class<?> eventType = listener.supports();
            registry
                .computeIfAbsent(eventType, x -> new CopyOnWriteArrayList<>())
                .add(listener);
            LOG.debug("Registered listener {} for event type {}", listener, eventType.getSimpleName());
            return this;
        }

        /**
         * Publish an event to all registered listeners. Non-blocking.
         */
        public <E extends Event> void publish(E event) {
            Objects.requireNonNull(event, "event");
            List<EventListener<?>> listeners = registry.getOrDefault(event.getClass(), new CopyOnWriteArrayList<>());
            LOG.debug("Dispatching {} to {} listener(s).", event, listeners.size());

            for (EventListener<?> l : listeners) {
                @SuppressWarnings("unchecked")
                EventListener<E> listener = (EventListener<E>) l;

                executor.submit(() -> {
                    try {
                        listener.onEvent(event);
                    } catch (Exception ex) {
                        LOG.error("Listener {} failed for event {} – will retry.", listener, event, ex);
                        retry(listener, event, 3, 500);
                    }
                });
            }
        }

        /* Simple bounded retry with back-off */
        private <E extends Event> void retry(EventListener<E> listener, E event, int attempts, long backOffMillis) {
            for (int i = 1; i <= attempts; i++) {
                try {
                    Thread.sleep(backOffMillis * i);       // naïve linear back-off
                    listener.onEvent(event);
                    LOG.info("Retry #{} succeeded for listener {}", i, listener);
                    return;
                } catch (Exception ex) {
                    LOG.error("Retry #{} failed for listener {}", i, listener, ex);
                }
            }
            LOG.error("All retries exhausted for listener {} and event {}", listener, event);
        }
    }

    /* ----------------------------------------------------------------------
     * Domain Event Abstractions
     * -------------------------------------------------------------------- */

    public interface Event { }

    public interface EventListener<E extends Event> {

        /**
         * @return The event type supported by this listener. Allows single-file simplicity
         *         without resorting to reflection sorcery.
         */
        Class<E> supports();

        /**
         * Handle the event. Any thrown exception will be caught by the dispatcher
         * and retried according to its strategy.
         */
        void onEvent(E event) throws Exception;
    }

    /* ----------------------------------------------------------------------
     * Domain Model & Validation
     * -------------------------------------------------------------------- */

    /**
     * Immutable request object for pulse creation.
     */
    public static final class PulseCreateRequest {

        @NotNull(message = "Author Id is mandatory")
        private final Long authorId;

        @NotBlank(message = "Title must not be blank")
        @Size(max = 120, message = "Title must be <= 120 characters")
        private final String title;

        @NotBlank(message = "Content must not be blank")
        private final String content;

        public PulseCreateRequest(Long authorId, String title, String content) {
            this.authorId = authorId;
            this.title    = title;
            this.content  = content;
        }

        public Long   getAuthorId() { return authorId; }
        public String getTitle()    { return title; }
        public String getContent()  { return content; }
    }

    /**
     * Aggregate-root for a learning ‘pulse’.
     */
    public static final class Pulse {

        private static final AtomicLong SEQ = new AtomicLong(1);

        private final long    id;
        private final long    authorId;
        private final String  title;
        private final String  content;
        private final Instant createdAt;

        Pulse(long authorId, String title, String content) {
            this.id        = SEQ.getAndIncrement();
            this.authorId  = authorId;
            this.title     = title;
            this.content   = content;
            this.createdAt = Instant.now();
        }

        public long    getId()        { return id; }
        public long    getAuthorId()  { return authorId; }
        public String  getTitle()     { return title; }
        public String  getContent()   { return content; }
        public Instant getCreatedAt() { return createdAt; }

        @Override public String toString() { return "Pulse#" + id; }
    }

    /* ----------------------------------------------------------------------
     * Domain Events
     * -------------------------------------------------------------------- */

    public static final class PulseCreatedEvent implements Event {

        private final Pulse pulse;

        PulseCreatedEvent(Pulse pulse) {
            this.pulse = Objects.requireNonNull(pulse, "pulse");
        }

        public Pulse getPulse() { return pulse; }

        @Override public String toString() {
            return "PulseCreatedEvent{pulse=" + pulse + '}';
        }
    }

    /* ----------------------------------------------------------------------
     * Services
     * -------------------------------------------------------------------- */

    /**
     * Application service responsible for pulse lifecycle. Performs validation,
     * persistence (in-memory for demo), and event emission.
     */
    public static final class PulseService {

        private static final Logger LOG = LoggerFactory.getLogger(PulseService.class);

        private final Validator             validator = Validation.buildDefaultValidatorFactory().getValidator();
        private final ConcurrentMap<Long, Pulse> inMemoryStore = new ConcurrentHashMap<>();
        private final EventBus              eventBus;

        PulseService(EventBus eventBus) {
            this.eventBus = Objects.requireNonNull(eventBus, "eventBus");
        }

        public long createPulse(PulseCreateRequest request) {
            Objects.requireNonNull(request, "request");
            validate(request);

            Pulse pulse = new Pulse(request.getAuthorId(), request.getTitle(), request.getContent());
            inMemoryStore.put(pulse.getId(), pulse);
            LOG.info("Persisted {}", pulse);

            /* Publish domain event AFTER successful ‘persistence’. */
            eventBus.publish(new PulseCreatedEvent(pulse));
            return pulse.getId();
        }

        private void validate(PulseCreateRequest request) {
            Set<ConstraintViolation<PulseCreateRequest>> violations = validator.validate(request);
            if (!violations.isEmpty()) {
                ConstraintViolation<PulseCreateRequest> v = violations.iterator().next();
                throw new IllegalArgumentException(v.getPropertyPath() + " – " + v.getMessage());
            }
        }
    }

    /**
     * Listener that dispatches e-mail notifications when a pulse is created.
     */
    public static final class NotificationListener implements EventListener<PulseCreatedEvent> {

        private static final Logger LOG = LoggerFactory.getLogger(NotificationListener.class);

        private final EmailService emailService = new EmailService();

        @Override public Class<PulseCreatedEvent> supports() {
            return PulseCreatedEvent.class;
        }

        @Override
        public void onEvent(PulseCreatedEvent event) throws Exception {
            Pulse pulse = event.getPulse();
            LOG.debug("NotificationListener handling {}", pulse);

            String subject = "New Pulse by User#" + pulse.getAuthorId() + ": " + truncate(pulse.getTitle(), 50);
            String body    = pulse.getContent();

            /* For demo purposes, send to a static mailing list. */
            emailService.sendEmail("classroom@edupulse.com", subject, body);
            LOG.info("Notification e-mail sent for {}", pulse);
        }

        private String truncate(String s, int max) {
            return s.length() <= max ? s : s.substring(0, max - 3) + "...";
        }
    }

    /**
     * Listener that records analytics for pulse creations.
     */
    public static final class AnalyticsListener implements EventListener<PulseCreatedEvent> {

        private static final Logger LOG = LoggerFactory.getLogger(AnalyticsListener.class);

        private final AnalyticsService analyticsService = new AnalyticsService();

        @Override public Class<PulseCreatedEvent> supports() {
            return PulseCreatedEvent.class;
        }

        @Override
        public void onEvent(PulseCreatedEvent event) {
            Pulse pulse = event.getPulse();
            analyticsService.recordPulseCreated(pulse);
            LOG.info("Analytics recorded for {}", pulse);
        }
    }

    /* ----------------------------------------------------------------------
     * Infrastructure Services (stubs for demo – replace with real ones)
     * -------------------------------------------------------------------- */

    public static final class EmailService {

        private static final Logger LOG = LoggerFactory.getLogger(EmailService.class);

        /**
         * Synchronously send an e-mail. In production you would integrate with
         * SES, SendGrid, etc., and perform I/O asynchronously.
         *
         * @throws AddressException If the e-mail address is invalid.
         */
        public void sendEmail(String to, String subject, String body) throws AddressException {
            validateEmail(to);
            /* Simulate network latency */
            try { Thread.sleep(150); } catch (InterruptedException ignored) { }

            LOG.debug("Sending e-mail -> To: {} | Subject: {} | Body: {}", to, subject, body);
            // … actual SMTP / API call omitted …
        }

        private void validateEmail(String email) throws AddressException {
            new InternetAddress(email, true);   // throws if invalid
        }
    }

    public static final class AnalyticsService {

        private static final Logger LOG = LoggerFactory.getLogger(AnalyticsService.class);

        public void recordPulseCreated(Pulse pulse) {
            // In reality this would push a record into a data warehouse / Kafka topic.
            LOG.debug("Recorded analytic event for pulse {}", pulse.getId());
        }
    }

    /* ----------------------------------------------------------------------
     * Utilities
     * -------------------------------------------------------------------- */

    /**
     * Named threads make debugging thread dumps MUCH easier.
     */
    private static final class NamedThreadFactory implements ThreadFactory {

        private final ThreadFactory delegate = Executors.defaultThreadFactory();
        private final String        baseName;
        private final AtomicLong    seq = new AtomicLong(1);

        NamedThreadFactory(String baseName) {
            this.baseName = baseName;
        }

        @Override public Thread newThread(Runnable r) {
            Thread t = delegate.newThread(r);
            t.setName(baseName + "-" + seq.getAndIncrement());
            t.setDaemon(true);
            return t;
        }
    }
}
```