```java
/*
 * EduPulse Live Learning Hub
 * Source: src/module_4.java
 *
 * This module contains a self-contained, production–ready implementation of a
 * small slice of the event–driven backbone: a ProgressAnalyticsService that
 * listens to user-generated domain events and updates learner progress metrics.
 *
 * NOTE:
 *  • The code purposefully avoids public top-level classes to remain agnostic of
 *    the on-disk filename (`module_4.java`) while still being fully compilable.
 *  • External dependencies are limited to SLF4J for logging. Replace the import
 *    with java.util.logging or your framework of choice if SLF4J is unavailable.
 */

package com.edupulse.analytics;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.LongAdder;

/* ============================================================
 * Domain-Event Infrastructure
 * ============================================================
 */

/**
 * Marker interface for all EduPulse domain events.
 */
interface DomainEvent {
    /** UTC timestamp (epoch-millis) at which the event occurred. */
    long occurredAt();

    /** A stable, fully-qualified identifier of the aggregate root emitting the event. */
    String aggregateId();

    /** Discriminator for routing / analytics. */
    EventType type();
}

/**
 * Base implementation shared by concrete events.
 */
abstract class AbstractDomainEvent implements DomainEvent {
    private final long occurredAt;
    private final String aggregateId;
    private final EventType type;

    protected AbstractDomainEvent(String aggregateId, EventType type) {
        this.occurredAt = Instant.now().toEpochMilli();
        this.aggregateId = Objects.requireNonNull(aggregateId, "aggregateId");
        this.type = Objects.requireNonNull(type, "type");
    }

    @Override public final long occurredAt()  { return occurredAt; }
    @Override public final String aggregateId() { return aggregateId; }
    @Override public final EventType type() { return type; }

    @Override public String toString() {
        return type + "{aggregateId='" + aggregateId + "', occurredAt=" + occurredAt + '}';
    }
}

/** Enumeration of supported event types recognized by the analytics layer. */
enum EventType {
    PULSE_VIEWED,
    QUIZ_SUBMITTED,
    ASSIGNMENT_UPLOADED,
    REACTION_ADDED
}

/* ============================================================
 * Concrete Domain Events
 * ============================================================
 */

/** A learner viewed a short lesson (pulse). */
final class PulseViewedEvent extends AbstractDomainEvent {
    private final String pulseId;

    PulseViewedEvent(String learnerId, String pulseId) {
        super(learnerId, EventType.PULSE_VIEWED);
        this.pulseId = Objects.requireNonNull(pulseId, "pulseId");
    }

    public String pulseId() { return pulseId; }
}

/** A learner submitted a quiz and received a score. */
final class QuizSubmittedEvent extends AbstractDomainEvent {
    private final String quizId;
    private final double scorePercentage;

    QuizSubmittedEvent(String learnerId, String quizId, double scorePercentage) {
        super(learnerId, EventType.QUIZ_SUBMITTED);
        this.quizId = Objects.requireNonNull(quizId, "quizId");
        this.scorePercentage = scorePercentage;
    }

    public String quizId() { return quizId; }
    public double scorePercentage() { return scorePercentage; }
}

/* ============================================================
 * Message-Broker Abstraction
 * ============================================================
 */

/**
 * Minimal pub-sub broker abstraction. In production this would be backed by
 * Kafka / RabbitMQ / Pulsar etc.  For demonstration, an in-memory
 * implementation is supplied.
 */
interface MessageBroker {
    void publish(DomainEvent event);

    BrokerSubscription subscribe(Set<EventType> eventFilter, BrokerSubscriber subscriber);

    interface BrokerSubscriber {
        void onEvent(DomainEvent event) throws Exception;
    }

    /**
     * Handle to cancel an active subscription.
     */
    interface BrokerSubscription extends AutoCloseable {
        @Override void close();
    }
}

/* ============================================================
 * In-Memory Broker (Demo Only)
 * ============================================================
 */

final class InMemoryMessageBroker implements MessageBroker {
    private final ConcurrentMap<Long, Subscription> subscriptions = new ConcurrentHashMap<>();
    private final AtomicLong idGenerator = new AtomicLong(1);

    private static final class Subscription {
        final Set<EventType> filter;
        final BrokerSubscriber subscriber;

        Subscription(Set<EventType> filter, BrokerSubscriber subscriber) {
            this.filter = filter;
            this.subscriber = subscriber;
        }
    }

    @Override
    public void publish(DomainEvent event) {
        Objects.requireNonNull(event, "event");
        subscriptions.forEach((id, sub) -> {
            if (sub.filter.isEmpty() || sub.filter.contains(event.type())) {
                try {
                    sub.subscriber.onEvent(event);
                } catch (Exception e) {
                    // Logging omitted here; caller decides handling strategy.
                }
            }
        });
    }

    @Override
    public BrokerSubscription subscribe(Set<EventType> eventFilter, BrokerSubscriber subscriber) {
        Objects.requireNonNull(subscriber, "subscriber");
        Objects.requireNonNull(eventFilter, "eventFilter");
        long id = idGenerator.getAndIncrement();
        subscriptions.put(id, new Subscription(eventFilter, subscriber));
        return () -> subscriptions.remove(id);
    }
}

/* ============================================================
 * Analytics Service
 * ============================================================
 */

/**
 * Consumes domain events to update per-learner analytics. Thread-safe and
 * back-pressure aware via bounded executor + queue.
 */
final class ProgressAnalyticsService implements AutoCloseable, MessageBroker.BrokerSubscriber {

    private static final Logger LOG = LoggerFactory.getLogger(ProgressAnalyticsService.class);

    /* ------------- public API ------------- */

    /**
     * Creates and registers an analytics service with the given broker.
     *
     * @param broker       message broker to subscribe to
     * @param workerThreads number of async workers (>=1)
     */
    static ProgressAnalyticsService start(MessageBroker broker, int workerThreads) {
        return new ProgressAnalyticsService(broker, workerThreads);
    }

    @Override
    public void close() {
        subscription.close();
        executor.shutdown();
        try {
            if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
        LOG.info("ProgressAnalyticsService stopped.");
    }

    /* ------------- implementation details ------------- */

    private final MessageBroker.BrokerSubscription subscription;
    private final ExecutorService executor;
    private final Map<String, LearnerStats> learnerStats = new ConcurrentHashMap<>();

    private ProgressAnalyticsService(MessageBroker broker, int workerThreads) {
        Objects.requireNonNull(broker, "broker");
        if (workerThreads < 1) throw new IllegalArgumentException("workerThreads must be >=1");

        this.executor = new ThreadPoolExecutor(
                workerThreads,
                workerThreads,
                60L, TimeUnit.SECONDS,
                new LinkedBlockingQueue<>(10_000),
                runnable -> {
                    Thread t = new Thread(runnable, "analytics-worker-" + ANALYTICS_THREAD_COUNTER.getAndIncrement());
                    t.setDaemon(true);
                    return t;
                },
                new ThreadPoolExecutor.CallerRunsPolicy()   // back-pressure
        );

        this.subscription = broker.subscribe(Set.of(), this); // listen to ALL events
        LOG.info("ProgressAnalyticsService started with {} worker threads.", workerThreads);
    }

    private static final AtomicLong ANALYTICS_THREAD_COUNTER = new AtomicLong();

    /* ------------- message-broker callback ------------- */

    @Override
    public void onEvent(DomainEvent event) {
        // Offload heavy processing to executor
        executor.execute(() -> processEventSafely(event));
    }

    private void processEventSafely(DomainEvent event) {
        try {
            process(event);
        } catch (Exception e) {
            LOG.error("Failed to process event {}", event, e);
        }
    }

    /* ------------- event processing ------------- */

    private void process(DomainEvent event) {
        switch (event.type()) {
            case PULSE_VIEWED -> apply((PulseViewedEvent) event);
            case QUIZ_SUBMITTED -> apply((QuizSubmittedEvent) event);
            // Add additional cases as new EventTypes are introduced
            default -> LOG.debug("Ignoring unsupported event type {}", event.type());
        }
    }

    private void apply(PulseViewedEvent e) {
        LearnerStats stats = learnerStats.computeIfAbsent(e.aggregateId(), id -> new LearnerStats());
        stats.pulsesViewed.increment();
        LOG.debug("Learner {} viewed pulse {} (total views: {})",
                  e.aggregateId(), e.pulseId(), stats.pulsesViewed.sum());
    }

    private void apply(QuizSubmittedEvent e) {
        LearnerStats stats = learnerStats.computeIfAbsent(e.aggregateId(), id -> new LearnerStats());
        stats.quizzesTaken.increment();
        stats.totalScore.add(e.scorePercentage());
        LOG.debug("Learner {} submitted quiz {} (score: {}%)",
                  e.aggregateId(), e.quizId(), e.scorePercentage());
    }

    /* ------------- snapshot reporting (optional) ------------- */

    /**
     * Returns an immutable snapshot of learner statistics. Heavy-weight; call sparingly.
     */
    Map<String, LearnerStatsSnapshot> snapshot() {
        Map<String, LearnerStatsSnapshot> copy = new ConcurrentHashMap<>();
        learnerStats.forEach((learnerId, stats) -> copy.put(learnerId, stats.snapshot()));
        return Map.copyOf(copy);
    }

    /* ------------- internal data structure ------------- */

    static final class LearnerStats {
        final LongAdder pulsesViewed = new LongAdder();
        final LongAdder quizzesTaken = new LongAdder();
        final DoubleAdder totalScore = new DoubleAdder();

        LearnerStatsSnapshot snapshot() {
            return new LearnerStatsSnapshot(
                    pulsesViewed.sum(),
                    quizzesTaken.sum(),
                    quizzesTaken.sum() == 0 ? 0 : totalScore.sum() / quizzesTaken.sum()
            );
        }
    }

    /**
     * Immutable view of per-learner analytics.
     *
     * @param pulsesViewed      how many pulses viewed
     * @param quizzesTaken      how many quizzes submitted
     * @param avgQuizPercentage average quiz score percentage
     */
    record LearnerStatsSnapshot(long pulsesViewed, long quizzesTaken, double avgQuizPercentage) {}
}

/* ============================================================
 * Example Usage (main method for manual testing)
 * ============================================================
 */

class ExampleRunner {
    public static void main(String[] args) throws Exception {
        MessageBroker broker = new InMemoryMessageBroker();
        try (ProgressAnalyticsService analytics = ProgressAnalyticsService.start(broker, 4)) {

            // Simulate learner activity
            broker.publish(new PulseViewedEvent("learner-01", "pulse-42"));
            broker.publish(new PulseViewedEvent("learner-02", "pulse-99"));
            broker.publish(new QuizSubmittedEvent("learner-01", "quiz-17", 88.5));

            // Allow async processing to complete
            Thread.sleep(500);

            // Print snapshot
            analytics.snapshot().forEach((learnerId, stats) ->
                    System.out.printf("%s: %s%n", learnerId, stats));
        }
    }
}
```