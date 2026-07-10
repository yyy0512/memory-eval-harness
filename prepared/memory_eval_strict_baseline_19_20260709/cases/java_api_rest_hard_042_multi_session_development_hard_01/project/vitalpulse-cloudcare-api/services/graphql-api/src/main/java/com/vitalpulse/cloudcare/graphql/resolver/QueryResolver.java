package com.vitalpulse.cloudcare.graphql.resolver;

import com.coxautodev.graphql.tools.GraphQLQueryResolver;
import com.vitalpulse.cloudcare.core.auth.AuthContext;
import com.vitalpulse.cloudcare.core.auth.AuthContextProvider;
import com.vitalpulse.cloudcare.core.error.AccessDeniedException;
import com.vitalpulse.cloudcare.core.error.InvalidInputException;
import com.vitalpulse.cloudcare.core.model.MedicationEvent;
import com.vitalpulse.cloudcare.core.model.Patient;
import com.vitalpulse.cloudcare.core.model.pagination.CursorPage;
import com.vitalpulse.cloudcare.core.model.pagination.CursorPageInput;
import com.vitalpulse.cloudcare.core.model.pagination.OffsetPage;
import com.vitalpulse.cloudcare.core.model.pagination.OffsetPageInput;
import com.vitalpulse.cloudcare.core.model.vitals.VitalSign;
import com.vitalpulse.cloudcare.core.service.MedicationReadService;
import com.vitalpulse.cloudcare.core.service.PatientReadService;
import com.vitalpulse.cloudcare.core.service.VitalSignReadService;
import graphql.schema.DataFetchingEnvironment;
import jakarta.inject.Singleton;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * GraphQL query resolver for CloudCare.  All read-only operations exposed by the GraphQL
 * schema are funneled through this component, which acts as a thin adapter between the
 * GraphQL execution engine and the domain/service layer.
 *
 * Responsibilities:
 *  • Field-level authorization & context extraction
 *  • Input validation and business-centric error translation
 *  • Pagination orchestration (offset and cursor-based)
 *  • Delegation to domain services
 *
 * Note: write/command operations live in MutationResolver (not shown).
 */
@Singleton
public class QueryResolver implements GraphQLQueryResolver {

    private static final Logger LOG = LoggerFactory.getLogger(QueryResolver.class);

    /**
     * Allows uppercase alpha-numerics plus dashes between 8 and 64 chars.
     * Keeps PHI identifiers opaque while still basic sanity checking.
     */
    private static final Pattern PATIENT_ID_PATTERN = Pattern.compile("^[A-Z0-9\\-]{8,64}$");

    private final PatientReadService patientReadService;
    private final MedicationReadService medicationReadService;
    private final VitalSignReadService vitalSignReadService;
    private final AuthContextProvider authContextProvider;

    public QueryResolver(PatientReadService patientReadService,
                         MedicationReadService medicationReadService,
                         VitalSignReadService vitalSignReadService,
                         AuthContextProvider authContextProvider) {
        this.patientReadService = Objects.requireNonNull(patientReadService);
        this.medicationReadService = Objects.requireNonNull(medicationReadService);
        this.vitalSignReadService = Objects.requireNonNull(vitalSignReadService);
        this.authContextProvider = Objects.requireNonNull(authContextProvider);
    }

    // -----------------------------------------------------------------------------------------
    // GraphQL Schema Mappings
    // -----------------------------------------------------------------------------------------

    /**
     * Fetch a single patient record by opaque identifier.
     */
    public Patient patient(String patientId, DataFetchingEnvironment env) {
        validatePatientId(patientId);
        AuthContext auth = authContextProvider.from(env);
        authorize(auth, "patient:read", patientId);

        LOG.debug("GraphQL `patient` query for id={} by sub={}", patientId, auth.getSubject());

        return patientReadService
                .findById(patientId)
                .orElseThrow(() -> new InvalidInputException("Patient not found: " + patientId));
    }

    /**
     * Retrieve a pageable list of medication events for a patient.
     *
     * This uses offset-based pagination because the underlying DynamoDB table
     * is sorted by event time and rarely experiences out-of-band inserts.
     */
    public OffsetPage<MedicationEvent> medicationEvents(
            String patientId,
            OffsetPageInput page,
            DataFetchingEnvironment env) {

        validatePatientId(patientId);
        AuthContext auth = authContextProvider.from(env);
        authorize(auth, "medication:read", patientId);

        OffsetPageInput safePage = sanitize(page, 50);
        LOG.debug("GraphQL `medicationEvents` query pid={} limit={} offset={} sub={}",
                patientId, safePage.getLimit(), safePage.getOffset(), auth.getSubject());

        return medicationReadService.findEvents(patientId, safePage);
    }

    /**
     * Retrieve vital-sign stream for a patient using cursor-based pagination.
     * This is suitable for high frequency telemetry where new records appear
     * multiple times per second.
     */
    public CursorPage<VitalSign> vitalSigns(
            String patientId,
            CursorPageInput page,
            List<String> types,
            DataFetchingEnvironment env) {

        validatePatientId(patientId);
        AuthContext auth = authContextProvider.from(env);
        authorize(auth, "telemetry:read", patientId);

        CursorPageInput safePage = sanitize(page, Duration.ofMinutes(15));
        LOG.debug("GraphQL `vitalSigns` query pid={} cursor={} window={} types={} sub={}",
                patientId, safePage.getCursor(), safePage.getWindow(), types, auth.getSubject());

        return vitalSignReadService.stream(patientId, types, safePage);
    }

    // -----------------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------------

    private void validatePatientId(String patientId) {
        if (patientId == null || !PATIENT_ID_PATTERN.matcher(patientId).matches()) {
            throw new InvalidInputException("Invalid patient identifier");
        }
    }

    /**
     * Basic ABAC check — verifies both scope and attribute (patient) level access.
     */
    private void authorize(AuthContext context, String scope, String patientId) {
        if (!context.hasScope(scope) || !context.canAccessPatient(patientId)) {
            throw new AccessDeniedException("Access to patient resource denied");
        }
    }

    /**
     * Ensure sane offset pagination defaults.
     */
    private OffsetPageInput sanitize(OffsetPageInput input, int maxLimit) {
        if (input == null) {
            return new OffsetPageInput(0, Math.min(20, maxLimit));
        }
        int limit = Math.min(input.getLimit(), maxLimit);
        int offset = Math.max(input.getOffset(), 0);
        return new OffsetPageInput(offset, limit);
    }

    /**
     * Ensure sane cursor pagination defaults.
     */
    private CursorPageInput sanitize(CursorPageInput input, Duration maxWindow) {
        if (input == null) {
            return new CursorPageInput(null, Duration.ofMinutes(5));
        }
        Duration window = input.getWindow() == null
                ? Duration.ofMinutes(5)
                : input.getWindow().compareTo(maxWindow) > 0 ? maxWindow : input.getWindow();
        return new CursorPageInput(input.getCursor(), window);
    }
}