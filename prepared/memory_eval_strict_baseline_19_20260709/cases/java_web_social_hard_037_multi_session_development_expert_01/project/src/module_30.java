```java
package com.circleconnect.nexus.logging;

import com.circleconnect.nexus.logging.Module30.LogSeverity;
import com.circleconnect.nexus.logging.exception.RateLimitExceededException;
import com.circleconnect.nexus.logging.model.ActivityLogEntry;
import com.circleconnect.nexus.logging.repository.ActivityLogRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.google.common.util.concurrent.RateLimiter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.core.task.TaskExecutor;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;
import org.springframework.util.Assert;

import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Centralized Activity Logging & Audit service.
 *
 * <p>This component acts as the gateway between runtime events and persistent audit trails,
 * providing structured logging, per-user rate limiting, asynchronous persistence,
 * and optional publication to an external observability bus.</p>
 *
 * <p>All methods that potentially block (e.g. I/O to the database or network)
 * are executed on the {@link TaskExecutor} supplied via Spring’s async
 * infrastructure.</p>
 */
@Service
public class Module30 implements InitializingBean { // File name equals class name

    private static final Logger log = LoggerFactory.getLogger(Module30.class);

    // Fallback correlation-key when executing outside HTTP scope
    private static final String FALLBACK_CID = "N/A";

    private final ActivityLogRepository logRepository;
    private final ApplicationEventPublisher eventPublisher;
    private final TaskExecutor loggingExecutor;
    private final ObjectMapper objectMapper;

    /** Global limiter for accidental noisy loops. */
    private final RateLimiter globalRateLimiter;
    /** Per-user dynamic limiters (“moving bucket” style). */
    private final Map<UUID, RateLimiter> userLimiters = new ConcurrentHashMap<>();

    @Value("${circleconnect.logging.per-user-permits-per-second:5}")
    private double userPermitsPerSecond;

    @Value("${circleconnect.logging.external-sink.enabled:false}")
    private boolean externalSinkEnabled;

    public Module30(ActivityLogRepository logRepository,
                    ApplicationEventPublisher eventPublisher,
                    TaskExecutor loggingExecutor,
                    ObjectMapper objectMapper,
                    @Value("${circleconnect.logging.global-permits-per-second:50}") double globalPermitsPerSecond) {

        this.logRepository = Objects.requireNonNull(logRepository, "logRepository");
        this.eventPublisher = Objects.requireNonNull(eventPublisher, "eventPublisher");
        this.loggingExecutor = Objects.requireNonNull(loggingExecutor, "loggingExecutor");
        this.objectMapper = Objects.requireNonNull(objectMapper, "objectMapper");
        this.globalRateLimiter = RateLimiter.create(globalPermitsPerSecond);
    }

    @Override
    public void afterPropertiesSet() {
        Assert.isTrue(userPermitsPerSecond > 0.0d, "per-user rate must be positive");
    }

    /**
     * Log a user-initiated action.
     *
     * @param actorId   id of the acting user
     * @param action    human-friendly action (e.g. “CIRCLE_CREATE”)
     * @param severity  severity tag (INFO, WARN, ERROR, SECURITY)
     * @param meta      arbitrary key/value meta data (nullable)
     *
     * @throws RateLimitExceededException if the caller or system is currently rate-limited
     */
    public void logUserAction(UUID actorId,
                              String action,
                              LogSeverity severity,
                              Map<String, Object> meta) throws RateLimitExceededException {

        Objects.requireNonNull(actorId, "actorId");
        Objects.requireNonNull(action, "action");
        Objects.requireNonNull(severity, "severity");

        enforceRateLimits(actorId);

        String correlationId = currentCorrelationId();

        ActivityLogEntry entry = ActivityLogEntry.builder()
                .id(UUID.randomUUID())
                .actorId(actorId)
                .action(action)
                .severity(severity)
                .meta(meta)
                .correlationId(correlationId)
                .timestamp(Instant.now())
                .build();

        // fire-and-forget – the heavy lifting happens asynchronously
        persistAsync(entry);
    }

    /**
     * Handles internal system events that are already aggregated into {@link ActivityLogEntry}s.
     */
    @EventListener
    public void onActivityLogEntry(ActivityLogEntry entry) {
        persistAsync(entry);
    }

    // ----------------------------------------------------------------------
    // Helpers
    // ----------------------------------------------------------------------

    private void enforceRateLimits(UUID actorId) {
        // Global limit first
        if (!globalRateLimiter.tryAcquire()) {
            throw new RateLimitExceededException("Global activity log rate exceeded");
        }

        // Per-user limiter (created lazily)
        userLimiters
            .computeIfAbsent(actorId, id -> RateLimiter.create(userPermitsPerSecond))
            .acquire(); // blocks momentarily; can also use tryAcquire() for harder limits
    }

    /**
     * Resolve current correlation ID from SLF4J MDC (set by interceptors)
     * or return a static fallback value.
     */
    private String currentCorrelationId() {
        String cid = MDC.get("CID");
        return cid != null ? cid : FALLBACK_CID;
    }

    /**
     * Asynchronous persistence to repository and optional propagation
     * to external monitoring sink.
     */
    @Async
    protected void persistAsync(ActivityLogEntry entry) {
        try {
            logRepository.save(entry);

            if (externalSinkEnabled) {
                // Non-blocking publication to monitoring infrastructure
                sendToExternalSink(entry);
            }

            if (log.isDebugEnabled()) {
                log.debug("Persisted activity log entry: {}", entry.getId());
            }
        } catch (Exception ex) {
            log.error("Failed to persist or publish activity log entry {}", entry.getId(), ex);
        }
    }

    private void sendToExternalSink(ActivityLogEntry entry) {
        try {
            String jsonPayload = objectMapper.writeValueAsString(entry);
            // publish the JSON payload as ApplicationEvent
            eventPublisher.publishEvent(new ExternalAuditEvent(this, jsonPayload));
        } catch (JsonProcessingException e) {
            log.warn("Cannot serialize activity log entry {} for external sink", entry.getId(), e);
        }
    }

    // ----------------------------------------------------------------------
    // Nested types
    // ----------------------------------------------------------------------

    /**
     * Severity tags recognized by the audit subsystem.
     */
    public enum LogSeverity {
        INFO,
        WARN,
        ERROR,
        SECURITY
    }

    /**
     * Spring {@link org.springframework.context.ApplicationEvent} that signals
     * a JSON payload targeted at an external observability pipeline.
     */
    public static final class ExternalAuditEvent {
        private final Object source;
        private final String payload;

        public ExternalAuditEvent(Object source, String payload) {
            this.source = source;
            this.payload = payload;
        }

        public Object getSource() {
            return source;
        }

        public String getPayload() {
            return payload;
        }
    }
}
```
