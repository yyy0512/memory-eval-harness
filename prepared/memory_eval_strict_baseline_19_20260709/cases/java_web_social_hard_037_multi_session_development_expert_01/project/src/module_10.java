package com.circleconnect.nexus.module10;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import javax.annotation.PostConstruct;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.stripe.Stripe;
import com.stripe.exception.StripeException;
import com.stripe.model.PaymentIntent;
import com.stripe.param.PaymentIntentCaptureParams;

/**
 * module_10.java
 *
 * This file bundles all Spring–managed components that deal with
 * Stripe-based pledge capture and reconciliation.  A scheduled job
 * periodically attempts to capture pending pledges that have aged
 * beyond a configurable threshold.
 *
 * NOTE: Only one public class is allowed per compilation unit;
 * therefore, the functional types live as nested static classes
 * inside the marker class {@link Module10}.
 */
public final class Module10 {

    /**
     * Private constructor prevents accidental instantiation.
     */
    private Module10() {
        /* no-op */
    }

    /* ------------------------------------------------------------------
     *                      ─── DOMAIN TYPES ───
     * ------------------------------------------------------------------ */

    /**
     * Simple life-cycle indicator for pledges.
     */
    public enum PledgeStatus {
        PENDING,
        CAPTURED,
        FAILED
    }

    /**
     * Aggregate-root for an individual pledge in the CircleConnect
     * eco-system.  Mapped columns/relations live in the JPA entity
     * counterpart – here we only expose the core attributes needed
     * by the reconciliation workflow.
     */
    public static class Pledge {

        private Long id;
        private String stripePaymentIntentId;
        private PledgeStatus status;
        private Instant createdAt;
        private Instant capturedAt;
        /**
         * Amount in the platform’s smallest currency unit (cents).
         */
        private Long amount;

        /* Constructors */

        public Pledge() {
        }

        public Pledge(
                Long id,
                String stripePaymentIntentId,
                PledgeStatus status,
                Instant createdAt,
                Long amount
        ) {
            this.id = id;
            this.stripePaymentIntentId = stripePaymentIntentId;
            this.status = status;
            this.createdAt = createdAt;
            this.amount = amount;
        }

        /* Accessors */

        public Long getId() {
            return id;
        }

        public void setId(Long id) {
            this.id = id;
        }

        public String getStripePaymentIntentId() {
            return stripePaymentIntentId;
        }

        public void setStripePaymentIntentId(String stripePaymentIntentId) {
            this.stripePaymentIntentId = stripePaymentIntentId;
        }

        public PledgeStatus getStatus() {
            return status;
        }

        public void setStatus(PledgeStatus status) {
            this.status = status;
        }

        public Instant getCreatedAt() {
            return createdAt;
        }

        public void setCreatedAt(Instant createdAt) {
            this.createdAt = createdAt;
        }

        public Instant getCapturedAt() {
            return capturedAt;
        }

        public void setCapturedAt(Instant capturedAt) {
            this.capturedAt = capturedAt;
        }

        public Long getAmount() {
            return amount;
        }

        public void setAmount(Long amount) {
            this.amount = amount;
        }
    }

    /* ------------------------------------------------------------------
     *                      ─── REPOSITORY PORT ───
     * ------------------------------------------------------------------ */

    /**
     * Repository abstraction – implemented elsewhere (JPA, MyBatis, etc.).
     * Only the methods required by the reconciliation logic are defined.
     */
    public interface PledgeRepository {

        /**
         * Retrieves all pledges in the given {@link PledgeStatus}.
         */
        List<Pledge> findByStatus(PledgeStatus status);

        /**
         * Stores the provided pledges in batch fashion.
         */
        void saveAll(Iterable<Pledge> pledges);
    }

    /* ------------------------------------------------------------------
     *                      ─── SERVICE LAYER ───
     * ------------------------------------------------------------------ */

    /**
     * Component in charge of talking to Stripe and mutating pledge state.
     */
    @Service
    public static class PledgeReconciliationService {

        private static final Logger LOG =
                LoggerFactory.getLogger(PledgeReconciliationService.class);

        private final PledgeRepository pledgeRepository;
        private final Clock clock;

        @Value("${circleconnect.payment.stripe.secret-key}")
        private String stripeSecretKey;

        public PledgeReconciliationService(PledgeRepository pledgeRepository, Clock clock) {
            this.pledgeRepository = Objects.requireNonNull(pledgeRepository, "pledgeRepository");
            this.clock = Objects.requireNonNull(clock, "clock");
        }

        /**
         * Wire Stripe API key only once after the Spring context is ready.
         */
        @PostConstruct
        void initStripe() {
            Stripe.apiKey = stripeSecretKey;
            LOG.info("Stripe API key initialised for pledge reconciliation");
        }

        /**
         * Captures all open pledges that are at least {@code maxAge} old.
         *
         * @param maxAge Minimum age required to attempt capture.
         * @return Number of pledges that were successfully captured.
         */
        @Transactional
        public int captureOutstandingPledges(Duration maxAge) {
            final Instant now = clock.instant();
            final List<Pledge> pending =
                    new ArrayList<>(pledgeRepository.findByStatus(PledgeStatus.PENDING));

            int successCounter = 0;

            for (Iterator<Pledge> iterator = pending.iterator(); iterator.hasNext(); ) {
                Pledge pledge = iterator.next();

                /* Skip pledges that are not old enough. */
                if (Duration.between(pledge.getCreatedAt(), now).compareTo(maxAge) < 0) {
                    continue;
                }

                try {
                    if (captureViaStripe(pledge)) {
                        pledge.setStatus(PledgeStatus.CAPTURED);
                        pledge.setCapturedAt(now);
                        successCounter++;

                        LOG.info("Captured pledge id={} amount={}c",
                                 pledge.getId(),
                                 pledge.getAmount());
                    } else {
                        pledge.setStatus(PledgeStatus.FAILED);
                        LOG.warn("Stripe capture returned unsuccessful status for pledge id={}",
                                 pledge.getId());
                    }
                } catch (Exception ex) {
                    pledge.setStatus(PledgeStatus.FAILED);
                    LOG.error("Error while capturing pledge id=" + pledge.getId(), ex);
                }
            }

            /* Persist mutated pledges in a single DB round-trip. */
            pledgeRepository.saveAll(pending);

            return successCounter;
        }

        /**
         * Retrieves and captures a PaymentIntent. Returns {@code true} iff the intent
         * ends up in the {@code succeeded} state.
         */
        private boolean captureViaStripe(Pledge pledge) throws StripeException {
            if (pledge.getStripePaymentIntentId() == null ||
                pledge.getStripePaymentIntentId().isEmpty()) {
                throw new IllegalStateException(
                        "Stripe PaymentIntent ID missing for pledge " + pledge.getId());
            }

            PaymentIntent intent =
                    PaymentIntent.retrieve(pledge.getStripePaymentIntentId());

            /* Only capture when Stripe still expects us to do so. */
            if (!"requires_capture".equals(intent.getStatus())) {
                LOG.debug("PaymentIntent {} for pledge {} is in status {} – capture skipped.",
                          intent.getId(),
                          pledge.getId(),
                          intent.getStatus());
                return "succeeded".equals(intent.getStatus());
            }

            PaymentIntentCaptureParams params =
                    PaymentIntentCaptureParams.builder().build();

            intent = intent.capture(params);

            return "succeeded".equals(intent.getStatus());
        }
    }

    /* ------------------------------------------------------------------
     *                      ─── SCHEDULER ───
     * ------------------------------------------------------------------ */

    /**
     * CRON-based driver that invokes the reconciliation service.
     */
    @Component
    public static class PledgeReconciliationScheduler {

        private static final Logger LOG =
                LoggerFactory.getLogger(PledgeReconciliationScheduler.class);

        private final PledgeReconciliationService reconciliationService;

        public PledgeReconciliationScheduler(PledgeReconciliationService reconciliationService) {
            this.reconciliationService = reconciliationService;
        }

        /**
         * Executes every 5 minutes by default. Override via
         * {@code circleconnect.payment.pledgeReconciliation.cron}.
         */
        @Scheduled(cron = "${circleconnect.payment.pledgeReconciliation.cron:0 */5 * * * *}")
        public void trigger() {
            LOG.debug("Starting scheduled pledge reconciliation job…");
            try {
                int captured =
                        reconciliationService.captureOutstandingPledges(Duration.ofHours(1));
                LOG.info("Pledge reconciliation done – captured {} pledges.", captured);
            } catch (Exception ex) {
                LOG.error("Unexpected failure in pledge reconciliation scheduler", ex);
            }
        }
    }
}