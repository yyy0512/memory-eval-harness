package com.vitalpulse.cloudcare.ingestion.service;

import com.vitalpulse.cloudcare.ingestion.domain.model.VitalSign;
import com.vitalpulse.cloudcare.ingestion.domain.repository.VitalSignWriteRepository;
import com.vitalpulse.cloudcare.ingestion.metrics.MetricsPublisher;
import com.vitalpulse.cloudcare.ingestion.model.VitalSignDTO;
import com.vitalpulse.cloudcare.ingestion.rate.RateLimiter;
import com.vitalpulse.cloudcare.ingestion.validation.ValidationException;
import com.vitalpulse.cloudcare.ingestion.validation.VitalSignValidator;
import com.vitalpulse.commons.audit.AuditEvent;
import com.vitalpulse.commons.audit.AuditPublisher;
import com.vitalpulse.commons.idempotency.IdempotencyService;
import com.vitalpulse.commons.idempotency.IdempotencyViolationException;
import com.vitalpulse.commons.tracing.Trace;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import javax.annotation.Nonnull;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * Service responsible for validating, persisting, auditing, and metering
 * incoming vital-sign messages.
 *
 * <p>
 * This class represents the <b>command</b> side of the CQRS split; no read-path logic
 * is implemented here.  The implementation purposefully avoids direct
 * exposure of the persistence technology (DynamoDB) in order to stay
 * storage-agnostic and allow future migration to Timestream without touching
 * higher layers.
 * </p>
 */
@Slf4j
@RequiredArgsConstructor
public class VitalIngestionService {

    private final VitalSignWriteRepository repository;
    private final VitalSignValidator validator;
    private final RateLimiter rateLimiter;
    private final MetricsPublisher metricsPublisher;
    private final AuditPublisher auditPublisher;
    private final IdempotencyService idempotencyService;

    /**
     * Ingest a batch of vital-sign DTOs for a given patient/device combination.
     *
     * @param tenantId   HIPAA tenant (aka hospital or clinic) identifier.
     * @param patientId  FHIR R4 resource id (Patient.id) associated with the vitals.
     * @param deviceId   Device identifier that produced the vitals.
     * @param requestId  Caller-supplied idempotency key. Must be globally unique for a 24-h window.
     * @param payload    List of unvalidated DTOs to persist.
     *
     * @throws ValidationException           If any DTO fails structural/content validation.
     * @throws RateLimiter.RateLimitExceeded If the tenant/device pair exceeds the permitted TPS.
     * @throws IdempotencyViolationException If the same requestId has already been processed.
     * @throws VitalIngestionException       For unrecoverable persistence errors.
     */
    @Trace(operation = "VitalIngestionService#ingestVitals") // distributed tracing
    public void ingestVitals(
            @Nonnull String tenantId,
            @Nonnull String patientId,
            @Nonnull String deviceId,
            @Nonnull String requestId,
            @Nonnull List<VitalSignDTO> payload
    ) throws ValidationException, VitalIngestionException {

        Objects.requireNonNull(tenantId, "tenantId is required");
        Objects.requireNonNull(patientId, "patientId is required");
        Objects.requireNonNull(deviceId, "deviceId is required");
        Objects.requireNonNull(requestId, "requestId is required");
        Objects.requireNonNull(payload, "payload must not be null");

        if (payload.isEmpty()) {
            log.warn("Ignoring empty ingestion payload (tenant={}, patient={}, device={})",
                    tenantId, patientId, deviceId);
            return;
        }

        // 1. Enforce write-path idempotency to protect downstream analytics from duplicate records.
        try {
            idempotencyService.assertIdempotentRequest("INGEST_VITALS", requestId);
        } catch (IdempotencyViolationException e) {
            metricsPublisher.increment("vitals.idempotent.duplicate");
            log.info("Duplicate ingestion requestId={}, ignoring", requestId);
            return;
        }

        // 2. Rate-limit at [tenant, device] granularity.
        rateLimiter.acquire(tenantId, deviceId, payload.size());

        // 3. Validate each DTO according to FHIR constraints (units, value ranges, etc.).
        for (VitalSignDTO dto : payload) {
            validator.validate(dto);
        }

        // 4. Map DTO -> domain entity.
        final List<VitalSign> vitals = payload.stream()
                .map(dto -> VitalSign.builder()
                        .tenantId(tenantId)
                        .patientId(patientId)
                        .deviceId(deviceId)
                        .type(dto.getType())
                        .value(dto.getValue())
                        .unit(dto.getUnit())
                        .timestamp(dto.getTimestamp())
                        .ingestedAt(Instant.now())
                        .build())
                .collect(Collectors.toUnmodifiableList());

        // 5. Persist batch.  The repository implementation is expected to delegate
        //    to DynamoDB TransactWriteItems for atomicity.
        try {
            repository.saveAll(vitals);
        } catch (Exception e) {
            log.error("Unable to persist vital signs (requestId={}): {}", requestId, e.getMessage(), e);
            metricsPublisher.increment("vitals.ingest.persistenceError");
            throw new VitalIngestionException("Unable to persist vitals", e);
        }

        // 6. Publish audit and metrics asynchronously; no need to block client.
        //    Failure to send audit should be logged but not propagated to caller.
        auditAsync(tenantId, requestId, patientId, deviceId, vitals.size());
        metricsPublisher.count("vitals.ingest.success", vitals.size());

        // 7. Mark idempotency success after transactional persistence & side-effects.
        idempotencyService.markSucceeded("INGEST_VITALS", requestId);

        log.debug("Successfully ingested {} vital(s) for patient={} device={}", vitals.size(), patientId, deviceId);
    }

    /* *********************************************************************************************
     *  Private helpers
     * *********************************************************************************************/

    private void auditAsync(String tenantId,
                            String requestId,
                            String patientId,
                            String deviceId,
                            int count) {

        AuditEvent event = new AuditEvent.Builder()
                .tenantId(tenantId)
                .eventType("VITALS_INGEST")
                .entityId(patientId)
                .requestId(requestId)
                .details("device=" + deviceId + ", rows=" + count)
                .build();

        auditPublisher.publishAsync(event)
                .exceptionally(throwable -> {
                    log.error("Failed to publish audit event for requestId={}: {}", requestId, throwable.getMessage(), throwable);
                    return null;
                });
    }

    /* *********************************************************************************************
     *  Custom exception that encapsulates unrecoverable ingestion failures.
     * *********************************************************************************************/

    public static class VitalIngestionException extends Exception {
        public VitalIngestionException(String message, Throwable cause) { super(message, cause); }
    }
}