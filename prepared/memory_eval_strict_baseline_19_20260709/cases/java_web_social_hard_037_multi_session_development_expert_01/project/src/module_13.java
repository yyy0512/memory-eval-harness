```java
package com.circleconnect.nexus.pledge;

import com.stripe.Stripe;
import com.stripe.exception.SignatureVerificationException;
import com.stripe.exception.StripeException;
import com.stripe.model.Event;
import com.stripe.model.PaymentIntent;
import com.stripe.net.Webhook;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PostConstruct;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Repository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.EnumSet;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Module 13 – Pledge payment orchestration for CircleConnect Nexus.
 *
 * This single file keeps all classes package-private except the {@code Module_13}
 * wrapper so that the {@code src/module_13.java} file name constraint is met
 * while complying with Java’s “one public class per file” rule.
 *
 * Responsibilities
 * – Create Stripe PaymentIntents on user pledge initiation
 * – Persist pledge state transitions in a transactional, idempotent way
 * – Publish Spring application events so the rest of the platform can react
 * – Feed metrics into Micrometer/Prometheus for observability
 * – Perform signature verification for incoming Stripe web-hooks
 *
 * NOTE: This file deliberately avoids advanced JPA mappings and externalised
 * configuration classes to remain self-contained for demonstration purposes.
 */
public final class Module_13 {

    private Module_13() {
        /* utility class – no instances */
    }

    /* ─────────────────────────  SERVICE LAYER ─────────────────────────── */

    @Service
    public static class PledgePaymentCoordinator {

        private static final Logger log = LoggerFactory.getLogger(PledgePaymentCoordinator.class);

        private final PledgeRepository pledgeRepository;
        private final StripeClient stripeClient;
        private final ApplicationEventPublisher publisher;
        private final TransactionTemplate txTemplate;
        private final Timer pledgeTimer;
        private final Timer webhookTimer;

        public PledgePaymentCoordinator(PledgeRepository pledgeRepository,
                                        StripeClient stripeClient,
                                        ApplicationEventPublisher publisher,
                                        TransactionTemplate txTemplate,
                                        MeterRegistry meterRegistry) {
            this.pledgeRepository = pledgeRepository;
            this.stripeClient = stripeClient;
            this.publisher = publisher;
            this.txTemplate = txTemplate;
            this.pledgeTimer = meterRegistry.timer("pledge.initiate");
            this.webhookTimer = meterRegistry.timer("pledge.webhook");
        }

        /**
         * Initiates a pledge and returns a client secret for front-end confirmation.
         */
        @Transactional
        public PledgeResponse initiatePledge(PledgeRequest req) {
            return pledgeTimer.record(() -> {

                log.debug("Initiating pledge for user={} circle={} amount={}",
                        req.memberId(), req.circleId(), req.amount());

                Pledge pledge = new Pledge();
                pledge.setMemberId(req.memberId());
                pledge.setCircleId(req.circleId());
                pledge.setAmount(req.amount());
                pledge.setCreatedAt(OffsetDateTime.now());
                pledge.setStatus(PledgeStatus.PENDING);

                // Persist early so we have an ID for domain events
                pledge = pledgeRepository.save(pledge);

                PaymentIntent pi = stripeClient.createPaymentIntent(pledge);
                pledge.setPaymentIntentId(pi.getId());

                pledgeRepository.save(pledge); // update with PI id

                publisher.publishEvent(new PledgeCreatedEvent(pledge));

                return new PledgeResponse(
                        pledge.getId(),
                        pledge.getPaymentIntentId(),
                        pi.getClientSecret(),
                        pledge.getStatus()
                );
            });
        }

        /**
         * Handles raw JSON coming from Stripe web-hook endpoint.
         */
        public void handleStripeWebhook(String payload, String sigHeader) {
            webhookTimer.record(() -> {
                Event event = stripeClient.verifyAndDeserializeWebhook(payload, sigHeader);
                log.debug("Stripe webhook type={}", event.getType());

                switch (event.getType()) {
                    case "payment_intent.succeeded" -> handleSucceeded(event);
                    case "payment_intent.payment_failed" -> handleFailed(event);
                    default -> log.trace("Ignoring irrelevant webhook event={}", event.getType());
                }
            });
        }

        /* ────────────────  PRIVATE HELPERs  ─────────────────────────── */

        private void handleSucceeded(Event event) {
            PaymentIntent pi = (PaymentIntent) event.getDataObjectDeserializer()
                                                   .getObject()
                                                   .orElseThrow(() -> new IllegalStateException("PI missing"));
            txTemplate.executeWithoutResult(status -> {
                Optional<Pledge> opt = pledgeRepository.findByPaymentIntentId(pi.getId());
                if (opt.isEmpty()) {
                    log.warn("Stripe PI={} not mapped to pledge – possibly out-of-band", pi.getId());
                    return;
                }
                Pledge pledge = opt.get();
                if (EnumSet.of(PledgeStatus.SETTLED, PledgeStatus.FAILED).contains(pledge.getStatus())) {
                    log.debug("Pledge={} already terminal (status={}) – skipping", pledge.getId(), pledge.getStatus());
                    return; // idempotency
                }
                pledge.setStatus(PledgeStatus.SETTLED);
                pledge.setSettledAt(OffsetDateTime.now());
                pledgeRepository.save(pledge);
                publisher.publishEvent(new PledgeSettledEvent(pledge));
                log.info("Pledge={} settled successfully", pledge.getId());
            });
        }

        private void handleFailed(Event event) {
            PaymentIntent pi = (PaymentIntent) event.getDataObjectDeserializer()
                                                   .getObject()
                                                   .orElseThrow(() -> new IllegalStateException("PI missing"));
            txTemplate.executeWithoutResult(status -> {
                pledgeRepository.findByPaymentIntentId(pi.getId()).ifPresent(pledge -> {
                    pledge.setStatus(PledgeStatus.FAILED);
                    pledgeRepository.save(pledge);
                    publisher.publishEvent(new PledgeFailedEvent(pledge));
                    log.info("Pledge={} marked as FAILED", pledge.getId());
                });
            });
        }
    }

    /* ─────────────────────────  INPUT / OUTPUT DTOs ──────────────────── */

    public record PledgeRequest(
            @NotBlank String circleId,
            @NotBlank String memberId,
            @NotNull BigDecimal amount
    ) {}

    public record PledgeResponse(
            Long pledgeId,
            String paymentIntentId,
            String clientSecret,
            PledgeStatus status
    ) {}

    /* ────────────────────────────  DOMAIN  ──────────────────────────── */

    enum PledgeStatus {
        PENDING,
        SETTLED,
        FAILED
    }

    /**
     * Simple POJO representation of a pledge. In the real code-base this would
     * be a Jakarta Persistence entity with mappings to {@code circles} and
     * {@code members} tables.
     */
    static class Pledge {

        private static long idSequence = 0; // placeholder for DB identity column

        private Long id;
        private String circleId;
        private String memberId;
        private BigDecimal amount;
        private OffsetDateTime createdAt;
        private OffsetDateTime settledAt;
        private PledgeStatus status;
        private String paymentIntentId;

        public Pledge() {
            this.id = ++idSequence;
        }

        /* ––– getters & setters ––– */

        public Long getId() { return id; }

        public String getCircleId() { return circleId; }

        public void setCircleId(String circleId) { this.circleId = circleId; }

        public String getMemberId() { return memberId; }

        public void setMemberId(String memberId) { this.memberId = memberId; }

        public BigDecimal getAmount() { return amount; }

        public void setAmount(BigDecimal amount) { this.amount = amount; }

        public OffsetDateTime getCreatedAt() { return createdAt; }

        public void setCreatedAt(OffsetDateTime createdAt) { this.createdAt = createdAt; }

        public OffsetDateTime getSettledAt() { return settledAt; }

        public void setSettledAt(OffsetDateTime settledAt) { this.settledAt = settledAt; }

        public PledgeStatus getStatus() { return status; }

        public void setStatus(PledgeStatus status) { this.status = status; }

        public String getPaymentIntentId() { return paymentIntentId; }

        public void setPaymentIntentId(String paymentIntentId) { this.paymentIntentId = paymentIntentId; }
    }

    /* ────────────────────────  REPOSITORY  ───────────────────────────── */

    @Repository
    interface PledgeRepository {
        Pledge save(Pledge pledge);

        Optional<Pledge> findById(Long id);

        Optional<Pledge> findByPaymentIntentId(String paymentIntentId);
    }

    /* ───────────────────────  STRIPE CLIENT  ─────────────────────────── */

    @Component
    static class StripeClient {

        private static final Logger log = LoggerFactory.getLogger(StripeClient.class);

        private final String webhookSecret;

        @PostConstruct
        void init() {
            log.info("Stripe client initialized – key starts with {}", Stripe.apiKey.substring(0, 4));
        }

        StripeClient(@Value("${stripe.secret-key}") String apiKey,
                     @Value("${stripe.webhook-signature}") String webhookSecret) {
            Stripe.apiKey = Objects.requireNonNull(apiKey, "Stripe secret key must be configured");
            this.webhookSecret = webhookSecret;
        }

        PaymentIntent createPaymentIntent(Pledge pledge) {
            try {
                Map<String, Object> params = Map.of(
                        "amount", pledge.getAmount().multiply(BigDecimal.valueOf(100)).longValue(),  // cents
                        "currency", "usd",
                        "metadata", Map.of(
                                "pledgeId", String.valueOf(pledge.getId()),
                                "circleId", pledge.getCircleId(),
                                "memberId", pledge.getMemberId()
                        )
                );
                PaymentIntent pi = PaymentIntent.create(params);
                log.debug("Created PI={} for pledge={}", pi.getId(), pledge.getId());
                return pi;
            } catch (StripeException e) {
                throw new PaymentGatewayException("Unable to create Stripe PaymentIntent", e);
            }
        }

        Event verifyAndDeserializeWebhook(String payload, String sigHeader) {
            try {
                return Webhook.constructEvent(payload, sigHeader, webhookSecret);
            } catch (SignatureVerificationException e) {
                log.warn("Invalid Stripe signature", e);
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Stripe signature");
            }
        }
    }

    /* ─────────────────────── EVENTS & ERRORS ─────────────────────────── */

    static class PledgeCreatedEvent {
        private final Pledge pledge;

        PledgeCreatedEvent(Pledge pledge) { this.pledge = pledge; }

        public Pledge getPledge() { return pledge; }
    }

    static class PledgeSettledEvent {
        private final Pledge pledge;

        PledgeSettledEvent(Pledge pledge) { this.pledge = pledge; }

        public Pledge getPledge() { return pledge; }
    }

    static class PledgeFailedEvent {
        private final Pledge pledge;

        PledgeFailedEvent(Pledge pledge) { this.pledge = pledge; }

        public Pledge getPledge() { return pledge; }
    }

    static class PaymentGatewayException extends RuntimeException {
        PaymentGatewayException(String msg, Throwable cause) {
            super(msg, cause);
        }
    }
}
```