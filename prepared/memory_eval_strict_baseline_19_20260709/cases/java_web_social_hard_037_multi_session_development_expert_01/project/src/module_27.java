package com.circleconnect.nexus.payment;

import com.stripe.exception.StripeException;
import com.stripe.model.PaymentIntent;
import com.stripe.param.PaymentIntentCreateParams;
import jakarta.validation.constraints.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.util.Currency;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * module_27 – Pledge charge orchestration layer.
 *
 * This service is responsible for taking an outstanding pledge, collecting funds via the
 * configured {@link PaymentGateway} (Stripe by default), persisting the new state,
 * and broadcasting a {@link PledgePaidEvent} for downstream observers (feed updates,
 * influence-score recalculation, etc.).
 *
 * NOTE: This file defines multiple package-private helper classes/interfaces so the
 *       entire module fits into a single compilation unit as required by build tooling.
 */
@Service
public class PledgePaymentService {

    private static final Logger log = LoggerFactory.getLogger(PledgePaymentService.class);

    private final PledgeRepository pledgeRepository;
    private final CircleRepository circleRepository;
    private final PaymentGateway paymentGateway;
    private final ApplicationEventPublisher eventPublisher;
    private final Clock clock;

    public PledgePaymentService(
            PledgeRepository pledgeRepository,
            CircleRepository circleRepository,
            PaymentGateway paymentGateway,
            ApplicationEventPublisher eventPublisher,
            Clock clock) {

        this.pledgeRepository = Objects.requireNonNull(pledgeRepository);
        this.circleRepository = Objects.requireNonNull(circleRepository);
        this.paymentGateway = Objects.requireNonNull(paymentGateway);
        this.eventPublisher = Objects.requireNonNull(eventPublisher);
        this.clock = Objects.requireNonNull(clock);
    }

    /**
     * Attempts to capture payment for a pledge.
     *
     * @param pledgeId         The UUID of the pledge.
     * @param paymentMethodId  A payment method reference obtained from the client-side SDK.
     *
     * @return A {@link PaymentResult} describing the outcome.
     *
     * @throws PledgeNotFoundException    If no pledge exists with the supplied ID.
     * @throws InvalidPledgeStateException If the pledge is not in a payable state.
     */
    @Transactional
    public PaymentResult processPledge(
            @NotNull UUID pledgeId,
            @NotNull String paymentMethodId)
            throws PledgeNotFoundException, InvalidPledgeStateException {

        final Pledge pledge = pledgeRepository
                .findById(pledgeId)
                .orElseThrow(() -> new PledgeNotFoundException(pledgeId));

        if (!pledge.isPayable()) {
            throw new InvalidPledgeStateException(
                    "Pledge " + pledgeId + " is in state '" + pledge.getStatus() + "', cannot be charged.");
        }

        final BigDecimal amount = pledge.getAmount();
        final Currency currency = pledge.getCurrency();

        PaymentResult result;
        try {
            final PaymentIntent intent = paymentGateway.charge(
                    amount,
                    currency,
                    paymentMethodId,
                    pledge.getUserReference(),
                    "Circle pledge " + pledgeId);

            pledge.markPaid(intent.getId(), Instant.now(clock));
            pledgeRepository.save(pledge);

            // Broadcast event
            eventPublisher.publishEvent(new PledgePaidEvent(this, pledge));

            result = PaymentResult.success(intent.getId(), intent.getStatus());
            log.info("Pledge {} successfully charged. StripeIntent: {}", pledgeId, intent.getId());
        } catch (PaymentGatewayException ex) {
            // Increment failure counters, notify observability stack, etc.
            pledge.markFailed(ex.getFailureCode(), Instant.now(clock));
            pledgeRepository.save(pledge);

            log.warn("Unable to charge pledge {} – {}", pledgeId, ex.getMessage());
            result = PaymentResult.failure(ex.getFailureCode(), ex.getMessage());
        }
        return result;
    }
}

/* ========================================================================== */
/* === Domain Layer Stubs (Repository, Aggregate, Events, Gateway, etc.) ==== */
/* ========================================================================== */

/**
 * Repository abstraction for pledge aggregates.
 */
interface PledgeRepository {

    Optional<Pledge> findById(UUID id);

    Pledge save(Pledge pledge);
}

/**
 * Repository abstraction for circles (not used directly here,
 * but injected for potential future cross-aggregate invariants).
 */
interface CircleRepository {
    // ... Methods omitted
}

/**
 * Payment gateway abstraction allowing alternative providers (e.g., PayPal)
 * without touching the business service.
 */
interface PaymentGateway {

    /**
     * Charges an amount on a specific payment method.
     *
     * @param amount          The amount to charge (major currency units).
     * @param currency        The ISO currency.
     * @param paymentMethodId The provider-specific payment method identifier.
     * @param customerRef     An opaque reference that identifies the customer.
     * @param description     A human-readable charge description.
     * @return Provider-specific result object.
     * @throws PaymentGatewayException If the charge fails for any reason.
     */
    PaymentIntent charge(BigDecimal amount,
                         Currency currency,
                         String paymentMethodId,
                         String customerRef,
                         String description) throws PaymentGatewayException;
}

/**
 * Stripe implementation of {@link PaymentGateway}.
 */
@Component
class StripePaymentGateway implements PaymentGateway {

    private static final Logger log = LoggerFactory.getLogger(StripePaymentGateway.class);

    public StripePaymentGateway() {
        // Read from vault/env-vars, never commit secret keys to VCS.
        String stripeApiKey = System.getenv("STRIPE_SECRET_KEY");
        com.stripe.Stripe.apiKey = stripeApiKey;
    }

    @Override
    public PaymentIntent charge(BigDecimal amount,
                                Currency currency,
                                String paymentMethodId,
                                String customerRef,
                                String description) throws PaymentGatewayException {

        long amountInMinorUnits = amount.multiply(BigDecimal.valueOf(100)).longValueExact();

        PaymentIntentCreateParams params = PaymentIntentCreateParams.builder()
                .setAmount(amountInMinorUnits)
                .setCurrency(currency.getCurrencyCode().toLowerCase())
                .setPaymentMethod(paymentMethodId)
                .setConfirm(true)
                .setDescription(description)
                .putMetadata("customerRef", customerRef)
                .build();

        try {
            PaymentIntent intent = PaymentIntent.create(params);
            if ("succeeded".equalsIgnoreCase(intent.getStatus())) {
                return intent;
            }
            log.error("Stripe charge did not succeed. Status: {} – {}", intent.getStatus(), intent.toJson());
            throw new PaymentGatewayException(intent.getLastPaymentError() != null
                    ? intent.getLastPaymentError().getCode()
                    : "unknown_failure", "Charge status: " + intent.getStatus());
        } catch (StripeException ex) {
            log.error("Stripe error while creating payment intent", ex);
            throw new PaymentGatewayException("stripe_exception", ex.getMessage(), ex);
        }
    }
}

/**
 * Local wrapper around checked/unchecked errors coming from payment providers.
 */
class PaymentGatewayException extends Exception {

    private final String failureCode;

    PaymentGatewayException(String failureCode, String message) {
        super(message);
        this.failureCode = failureCode;
    }

    PaymentGatewayException(String failureCode, String message, Throwable cause) {
        super(message, cause);
        this.failureCode = failureCode;
    }

    public String getFailureCode() {
        return failureCode;
    }
}

/**
 * Domain aggregate root representing a pledge.
 *
 * NOTE: Only a minimal subset of behaviour/properties is declared here to
 *       keep the example self-contained.
 */
class Pledge {

    private final UUID id;
    private BigDecimal amount;
    private Currency currency;
    private PledgeStatus status;
    private String providerChargeId;
    private Instant chargedAt;
    private Instant failedAt;
    private String failureCode;
    private final String userReference;

    Pledge(UUID id,
           BigDecimal amount,
           Currency currency,
           PledgeStatus status,
           String userReference) {

        this.id = id;
        this.amount = amount;
        this.currency = currency;
        this.status = status;
        this.userReference = userReference;
    }

    public UUID getId() {
        return id;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public Currency getCurrency() {
        return currency;
    }

    public PledgeStatus getStatus() {
        return status;
    }

    public boolean isPayable() {
        return status == PledgeStatus.CREATED || status == PledgeStatus.PAYMENT_FAILED;
    }

    public String getUserReference() {
        return userReference;
    }

    void markPaid(String providerChargeId, Instant chargedAt) {
        this.status = PledgeStatus.PAID;
        this.providerChargeId = providerChargeId;
        this.chargedAt = chargedAt;
        this.failedAt = null;
        this.failureCode = null;
    }

    void markFailed(String failureCode, Instant failedAt) {
        this.status = PledgeStatus.PAYMENT_FAILED;
        this.failedAt = failedAt;
        this.failureCode = failureCode;
    }
}

enum PledgeStatus {
    CREATED,
    PAID,
    PAYMENT_FAILED,
    CANCELED
}

/**
 * Immutable result object returned by {@link PledgePaymentService}.
 */
record PaymentResult(boolean success,
                     String reference,
                     String statusOrError) {

    static PaymentResult success(String providerRef, String providerStatus) {
        return new PaymentResult(true, providerRef, providerStatus);
    }

    static PaymentResult failure(String errorCode, String errorMessage) {
        return new PaymentResult(false, errorCode, errorMessage);
    }
}

/**
 * ApplicationEvent emitted after a pledge has been successfully charged.
 */
class PledgePaidEvent extends ApplicationEvent {

    private final Pledge pledge;

    PledgePaidEvent(Object source, Pledge pledge) {
        super(source);
        this.pledge = pledge;
    }

    public Pledge getPledge() {
        return pledge;
    }
}

/* ========================================================================== */
/* =========================== Service Exceptions =========================== */
/* ========================================================================== */

class PledgeNotFoundException extends RuntimeException {
    PledgeNotFoundException(UUID id) {
        super("Pledge with id " + id + " not found");
    }
}

class InvalidPledgeStateException extends RuntimeException {
    InvalidPledgeStateException(String message) {
        super(message);
    }
}