package com.vitalpulse.cloudcare.query.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.vitalpulse.cloudcare.common.exception.RateLimitExceededException;
import com.vitalpulse.cloudcare.common.exception.ResourceNotFoundException;
import com.vitalpulse.cloudcare.common.model.Page;
import com.vitalpulse.cloudcare.common.model.PaginationCursor;
import com.vitalpulse.cloudcare.common.model.RequestContext;
import com.vitalpulse.cloudcare.query.dto.MedicationEventDto;
import com.vitalpulse.cloudcare.query.dto.PatientDto;
import com.vitalpulse.cloudcare.query.dto.VitalSignDto;
import com.vitalpulse.cloudcare.query.repository.MedicationEventRepository;
import com.vitalpulse.cloudcare.query.repository.PatientRepository;
import com.vitalpulse.cloudcare.query.repository.VitalSignRepository;
import com.vitalpulse.cloudcare.security.AccessControlService;
import com.vitalpulse.cloudcare.security.AuthorizationException;
import com.vitalpulse.cloudcare.telemetry.Tracer;
import io.github.bucket4j.Bucket;
import org.hibernate.validator.HibernateValidator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.inject.Singleton;
import javax.validation.ConstraintViolation;
import javax.validation.Validation;
import javax.validation.Validator;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Service layer responsible for *read‐only* operations on patient‐centric data.
 * <p>
 * The class adheres to the CQRS principle: it does not modify any state but
 * delegates to repositories optimized for query workloads (e.g. DynamoDB GSIs,
 * ElasticSearch aggregations).  Each public method:
 * <ul>
 *     <li>Validates input parameters (&amp; FHIR‐compat schemas where relevant)</li>
 *     <li>Performs coarse rate-limiting (Bucket4j) on a per‐caller basis</li>
 *     <li>Delegates ACL checks to {@link AccessControlService}</li>
 *     <li>Publishes tracing spans for distributed observability</li>
 * </ul>
 *
 * NOTE: Implementations of repository/ACL/tracing are supplied elsewhere in the
 * microservice; only the orchestration logic is shown here.
 */
@Singleton
public class PatientQueryService {

    private static final Logger LOG = LoggerFactory.getLogger(PatientQueryService.class);

    private final PatientRepository patientRepository;
    private final VitalSignRepository vitalSignRepository;
    private final MedicationEventRepository medicationEventRepository;

    private final AccessControlService aclService;
    private final Tracer tracer;
    private final Bucket rateLimitBucket;
    private final Validator validator;
    private final ObjectMapper objectMapper;

    public PatientQueryService(PatientRepository patientRepository,
                               VitalSignRepository vitalSignRepository,
                               MedicationEventRepository medicationEventRepository,
                               AccessControlService aclService,
                               Tracer tracer,
                               Bucket rateLimitBucket,
                               ObjectMapper objectMapper) {
        this.patientRepository = patientRepository;
        this.vitalSignRepository = vitalSignRepository;
        this.medicationEventRepository = medicationEventRepository;
        this.aclService = aclService;
        this.tracer = tracer;
        this.rateLimitBucket = rateLimitBucket;
        this.objectMapper = objectMapper;
        this.validator = Validation.byProvider(HibernateValidator.class)
                .configure()
                .buildValidatorFactory()
                .getValidator();
    }

    /**
     * Retrieve the demographic summary for a single patient (FHIR R4 {@code Patient} resource).
     *
     * @param patientId FHIR logical identifier
     * @param ctx       Request context containing auth metadata, correlation id, etc.
     * @return Hydrated {@link PatientDto}
     * @throws AuthorizationException     when caller is not allowed to access the patient
     * @throws RateLimitExceededException when caller exceeded SLA quotas
     * @throws ResourceNotFoundException  when the patient does not exist
     */
    public PatientDto getPatientById(String patientId, RequestContext ctx)
            throws AuthorizationException, RateLimitExceededException, ResourceNotFoundException {

        guardRateLimit(ctx);
        guardAcl(ctx, patientId);

        var span = tracer.startSpan("PatientQueryService#getPatientById");
        span.setTag("patientId", patientId);

        try {
            validate(patientId, "patientId");

            return patientRepository.findById(patientId)
                    .map(PatientDto::fromEntity)
                    .orElseThrow(() -> new ResourceNotFoundException("Patient " + patientId + " not found"));
        } finally {
            span.finish();
        }
    }

    /**
     * Cursor-based paginated retrieval of a patient’s vital-sign time-series.
     *
     * @param patientId patient identifier
     * @param from      inclusive range start
     * @param to        exclusive range end
     * @param cursor    last evaluated cursor (may be {@code null})
     * @param pageSize  max number of items to return (1–1 000)
     * @param ctx       request context
     * @return Page of {@link VitalSignDto} items, including a next cursor when more data are available
     */
    public Page<VitalSignDto> getPatientVitals(String patientId,
                                               Instant from,
                                               Instant to,
                                               PaginationCursor cursor,
                                               int pageSize,
                                               RequestContext ctx)
            throws AuthorizationException, RateLimitExceededException {

        guardRateLimit(ctx);
        guardAcl(ctx, patientId);

        var span = tracer.startSpan("PatientQueryService#getPatientVitals")
                .setTag("patientId", patientId)
                .setTag("from", from)
                .setTag("to", to);

        try {
            validate(patientId, "patientId");
            validate(from, "from");
            validate(to, "to");

            Page<VitalSignDto> results = vitalSignRepository
                    .queryByPatientAndTimeRange(patientId, from, to, cursor, pageSize)
                    .map(VitalSignDto::fromEntity);

            span.setTag("itemCount", results.getItems().size());
            return results;
        } finally {
            span.finish();
        }
    }

    /**
     * Returns active medication orders for the given patient.
     *
     * @param patientId fhir patient id
     * @param ctx       request context
     * @return list of medication events
     */
    public List<MedicationEventDto> getActiveMedications(String patientId,
                                                         RequestContext ctx)
            throws AuthorizationException, RateLimitExceededException {

        guardRateLimit(ctx);
        guardAcl(ctx, patientId);

        var span = tracer.startSpan("PatientQueryService#getActiveMedications")
                .setTag("patientId", patientId);

        try {
            validate(patientId, "patientId");

            return medicationEventRepository.findActiveByPatient(patientId)
                    .stream()
                    .map(MedicationEventDto::fromEntity)
                    .collect(Collectors.toList());
        } finally {
            span.finish();
        }
    }

    // ---------------------------------------------------------------------
    // ---------------  Helper / Guard Methods  ----------------------------
    // ---------------------------------------------------------------------

    private void guardRateLimit(RequestContext ctx) throws RateLimitExceededException {
        if (!rateLimitBucket.tryConsume(1)) {
            LOG.warn("Rate limit exceeded for principal={}", ctx.getPrincipalId());
            throw new RateLimitExceededException("Rate limit exceeded");
        }
    }

    private void guardAcl(RequestContext ctx, String patientId) throws AuthorizationException {
        if (!aclService.mayReadPatient(ctx.getPrincipalId(), patientId)) {
            LOG.warn("ACL denied patient access. principal={}, patient={}", ctx.getPrincipalId(), patientId);
            throw new AuthorizationException("Access denied for patient " + patientId);
        }
    }

    private void validate(Object value, String fieldName) {
        Set<ConstraintViolation<Object>> violations = validator.validate(value);
        if (!violations.isEmpty()) {
            String msg = violations.stream()
                    .map(ConstraintViolation::getMessage)
                    .collect(Collectors.joining(", "));
            throw new IllegalArgumentException("Invalid value for " + fieldName + ": " + msg);
        }
    }
}