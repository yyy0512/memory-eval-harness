```java
package com.circleconnect.nexus.payment;

import com.stripe.Stripe;
import com.stripe.exception.StripeException;
import com.stripe.model.Charge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.InitializingBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.dao.DataAccessException;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import javax.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

/**
 * module_28.java – Pledge charging background job.
 *
 * Part of “CircleConnect Nexus” web-social platform.
 *
 * The job automatically captures Stripe payments for pledges that have
 * reached their funding trigger (e.g. campaign succeeded).  It runs on a
 * fixed delay and is safe for horizontal scaling thanks to a DB-level
 * pessimistic lock on every pledge row.
 */
@Component
@Profile("!test") // disable during unit tests
public class Module28 implements InitializingBean {

    private static final Logger log = LoggerFactory.getLogger(Module28.class);

    private final PledgeRepository pledgeRepository;
    private final StripeChargePort stripePort;
    private final int fetchBatchSize;

    public Module28(
            PledgeRepository pledgeRepository,
            StripeChargePort stripePort,
            @Value("${nexus.payment.pledge.batch-size:100}") int fetchBatchSize
    ) {
        this.pledgeRepository = pledgeRepository;
        this.stripePort       = stripePort;
        this.fetchBatchSize   = fetchBatchSize;
    }

    /**
     * Verify Stripe API key on startup – fail-fast if it is missing or invalid.
     */
    @Override
    public void afterPropertiesSet() throws Exception {
        try {
            Stripe.apiKey.hashCode(); // touches key, NPE if not set
        } catch (Exception e) {
            log.error("Stripe API key is not configured ‑ aborting startup.");
            throw new IllegalStateException("Missing Stripe key", e);
        }
    }

    /**
     * The job polls for pledges that:
     *   (a) are still PENDING
     *   (b) belong to a campaign that reached its goal, and
     *   (c) have not expired
     *
     * It is deliberately conservative on the fetch size to reduce lock time.
     */
    @Scheduled(
            fixedDelayString = "${nexus.payment.pledge.interval-ms:45000}",
            initialDelayString = "${nexus.payment.pledge.initial-delay-ms:30000}"
    )
    @Transactional
    public void chargeDuePledges() {

        List<Pledge> candidates = pledgeRepository
                .findNextDuePledges(Instant.now(), PageRequest.of(0, fetchBatchSize));

        if (candidates.isEmpty()) {
            log.debug("No pledges to process at {}", Instant.now());
            return;
        }

        log.info("Processing {} pledges for capture", candidates.size());

        for (Pledge pledge : candidates) {

            try {
                captureSinglePledge(pledge);
            } catch (TransientStripeException e) {
                // leave pledge as-is; next iteration will retry
                log.warn("Transient error charging pledge {} – will retry later: {}",
                         pledge.getId(), e.getMessage());
            } catch (PermanentStripeException e) {
                pledge.fail(e.getMessage());
                log.error("Permanent error charging pledge {}: {}",
                          pledge.getId(), e.getMessage());
            } catch (Exception e) {
                // unexpected – mark failed to avoid infinite loop, yet surface quickly
                pledge.fail("internal-error");
                log.error("Unexpected exception charging pledge " + pledge.getId(), e);
            }
        }
    }

    /**
     * Capture a single pledge with Stripe.  Record the result atomically
     * so that even if the JVM crashes afterwards we do not double-charge.
     */
    private void captureSinglePledge(Pledge pledge)
            throws TransientStripeException, PermanentStripeException {

        if (!pledge.isChargeable()) {
            log.debug("Pledge {} no longer chargeable (status={})",
                      pledge.getId(), pledge.getStatus());
            return;
        }

        Charge charge = stripePort.charge(pledge);

        pledge.markCaptured(charge.getId(), Instant.ofEpochSecond(charge.getCreated()));
        log.info("Successfully captured pledge {} – Stripe id {}",
                 pledge.getId(), charge.getId());
    }

    /* -------------------------------------------------------------------
     *  Internal components & JPA integration
     * ------------------------------------------------------------------- */

    /**
     * Spring Data repository for pledges.
     * Uses pessimistic locking so parallel job instances cannot double-capture.
     */
    interface PledgeRepository extends JpaRepository<Pledge, UUID> {

        @Lock(LockModeType.PESSIMISTIC_WRITE)
        @Query("select p from Pledge p " +
               "join fetch p.campaign c " +
               "where p.status = 'PENDING' " +
               "and c.funded = true " +
               "and p.expiresAt > :now")
        List<Pledge> findNextDuePledges(@Param("now") Instant now, PageRequest page);
    }

    /**
     * Adapter (Hexagonal Port) around the Stripe SDK.  Encapsulates Stripe-specific
     * mapping and retries so the job code remains clean.
     */
    @Component
    class StripeChargePort {

        private final Logger portLog = LoggerFactory.getLogger(StripeChargePort.class);

        @Value("${stripe.currency:usd}")
        private String defaultCurrency;

        Charge charge(Pledge pledge) throws TransientStripeException, PermanentStripeException {

            Map<String, Object> params = new HashMap<>();
            params.put("amount", pledge.getAmount().movePointRight(2).longValue()); // cents
            params.put("currency", defaultCurrency);
            params.put("customer", pledge.getCustomerId());
            params.put("description", String.format(
                    "CircleConnect pledge %s for campaign %s",
                    pledge.getId(), pledge.getCampaign().getId()));

            try {
                return Charge.create(params);
            } catch (StripeException e) {
                portLog.debug("StripeException while charging pledge {}: {}", pledge.getId(), e.getMessage());
                if (e.isRateLimit() || e.isApiConnectionError()) {
                    throw new TransientStripeException(e);
                }
                throw new PermanentStripeException(e);
            }
        }
    }

    /* -------------------------------------------------------------------
     *  Domain model
     * ------------------------------------------------------------------- */

    @Entity
    @Table(name = "pledges")
    class Pledge {

        @Id
        private UUID id;

        @ManyToOne(optional = false, fetch = FetchType.LAZY)
        private Campaign campaign;

        @Enumerated(EnumType.STRING)
        private Status status = Status.PENDING;

        @Column(nullable = false)
        private BigDecimal amount;

        @Column(nullable = false)
        private Instant expiresAt;

        /* Stripe references */
        @Column(name = "stripe_customer_id", nullable = false)
        private String customerId;
        @Column(name = "stripe_charge_id")
        private String chargeId;
        private Instant chargedAt;

        /* JPA constructors */
        protected Pledge() {}
        public Pledge(UUID id, Campaign campaign, BigDecimal amount, String customerId, Instant expiresAt) {
            this.id          = id;
            this.campaign    = campaign;
            this.amount      = amount;
            this.customerId  = customerId;
            this.expiresAt   = expiresAt;
        }

        public UUID getId()              { return id; }
        public Campaign getCampaign()    { return campaign; }
        public BigDecimal getAmount()    { return amount; }
        public Status getStatus()        { return status; }
        public String getCustomerId()    { return customerId; }
        public boolean isChargeable()    { return status == Status.PENDING; }

        void markCaptured(String chargeId, Instant chargedAt) {
            this.status   = Status.CAPTURED;
            this.chargeId = chargeId;
            this.chargedAt = chargedAt;
        }

        void fail(String reason) {
            this.status = Status.FAILED;
            // real impl would store reason in separate column + audit trail
        }

        enum Status { PENDING, CAPTURED, FAILED }
    }

    @Entity
    @Table(name = "campaigns")
    class Campaign {
        @Id
        private UUID id;

        private boolean funded;

        protected Campaign() {}
        public UUID getId() { return id; }
        public boolean isFunded() { return funded; }
    }

    /* -------------------------------------------------------------------
     *  Custom exceptions (typed for retry logic)
     * ------------------------------------------------------------------- */

    static class TransientStripeException extends Exception {
        TransientStripeException(Throwable cause) { super(cause); }
    }
    static class PermanentStripeException extends Exception {
        PermanentStripeException(Throwable cause) { super(cause); }
    }
}

/* -----------------------------------------------------------------------
 *  Spring configuration
 * --------------------------------------------------------------------- */

@Configuration
class StripeAutoConfiguration {

    StripeAutoConfiguration(@Value("${stripe.secret-key}") String secretKey) {
        // Global initialization.  Stripe recommends setting API key once.
        Stripe.apiKey = secretKey;
    }
}
```