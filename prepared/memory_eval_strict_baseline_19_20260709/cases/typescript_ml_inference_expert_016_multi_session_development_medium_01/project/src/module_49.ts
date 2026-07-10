```typescript
/***************************************************************************************************
 *  InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 *  File:        src/module_49.ts
 *  Responsibility:
 *      - Provide SLA-aware inference pricing as a domain service inside the hexagon.
 *      - Expose Strategy & Factory patterns so product teams can switch revenue models at runtime.
 *      - Publish pricing events to observers (dashboards, billing, anomaly-detection, etc.).
 *
 *  NOTE: All I/O concerns (databases, HTTP, message queues) live in separate adapter modules. This
 *        file contains pure business logic and is therefore easily unit-testable.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import Big from 'big.js';

/* =================================================================================================
 *  Domain primitives & helpers
 * ===============================================================================================*/

/**
 * Wrapper around Big.js to keep arithmetic decimal-safe.
 */
export class Money {
    private readonly amount: Big;

    constructor(value: number | string | Big) {
        this.amount = new Big(value);
    }

    public plus(other: Money): Money {
        return new Money(this.amount.plus(other.amount));
    }

    public times(multiplier: number | string | Big): Money {
        return new Money(this.amount.times(multiplier));
    }

    public toNumber(): number {
        return Number(this.amount.toFixed(6));
    }

    public toString(): string {
        return `$${this.amount.toFixed(4)}`;
    }
}

/**
 * Immutable description of a single inference request.
 */
export interface InferenceRequest {
    readonly modelName: string;
    /** ISO-8601 timestamp */
    readonly timestamp: string;
    /** In milliseconds */
    readonly latencyMs: number;
    /** Size of the input payload in kilobytes */
    readonly payloadKb: number;
    /** Subscription plan of the consumer (e.g., FREE, STANDARD, ENTERPRISE) */
    readonly userTier: 'FREE' | 'STANDARD' | 'ENTERPRISE';
    /** Flag indicating whether the request required a premium SLA */
    readonly premiumSla: boolean;
}

/**
 * PricingEvent is emitted whenever the system calculates a price for an inference request.
 */
export interface PricingEvent {
    readonly request: InferenceRequest;
    readonly price: Money;
    readonly strategyId: string;
    readonly issuedAt: string; // ISO-8601
}

/**
 * Observer for PricingEvent. Hexagon only knows the interface; adapters will implement it.
 */
export interface PricingEventObserver {
    onPriceCalculated(event: PricingEvent): void;
}

/* =================================================================================================
 *  Strategy Pattern — SLA-aware inference pricing
 * ===============================================================================================*/

/**
 * PricingStrategy encapsulates the algorithm used to calculate price for a given inference.
 * Implementations must be stateless and side-effect-free.
 */
export interface PricingStrategy {
    /**
     * Unique identifier for audit / registry purposes.
     */
    readonly id: string;

    /**
     * Calculate price for a given inference request.
     * Must never throw. In catastrophic cases, return Money(0) and rely on monitoring.
     */
    calculatePrice(request: InferenceRequest): Money;
}

/**
 * Usage-based pricing: pay per invocation, payload size, and SLA multipliers.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
    public readonly id = 'usage_based_v1';

    private static readonly BASE_PRICE_PER_CALL = new Money(0.0025); // $0.0025 per call
    private static readonly PRICE_PER_KB = new Money(0.00002);       // $0.00002 per KB
    private static readonly PREMIUM_SLA_MULTIPLIER = 2.0;            // 2x for premium SLA

    calculatePrice(request: InferenceRequest): Money {
        try {
            const callCost = UsageBasedPricingStrategy.BASE_PRICE_PER_CALL;
            const sizeCost = UsageBasedPricingStrategy.PRICE_PER_KB.times(request.payloadKb);
            const subtotal = callCost.plus(sizeCost);

            const multiplier = request.premiumSla
                ? UsageBasedPricingStrategy.PREMIUM_SLA_MULTIPLIER
                : 1;

            const total = subtotal.times(multiplier);

            // Guardrail to avoid negative or NaN pricing.
            if (!Number.isFinite(total.toNumber()) || total.toNumber() < 0) {
                // Gracefully degrade
                return new Money(0);
            }

            return total;
        } catch (error) {
            // Log via observer pattern (implemented in adapter layer)
            return new Money(0);
        }
    }
}

/**
 * Subscription pricing: flat monthly fee covers all calls; $0 price per inference.
 * SLA premium still applies to discourage abuse.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
    public readonly id = 'subscription_v1';

    private static readonly PREMIUM_SLA_FEE = new Money(0.01); // $0.01 per premium call

    calculatePrice(request: InferenceRequest): Money {
        const fee = request.premiumSla
            ? SubscriptionPricingStrategy.PREMIUM_SLA_FEE
            : new Money(0);

        return fee;
    }
}

/* =================================================================================================
 *  Factory Pattern — choose pricing strategy based on runtime config or request metadata
 * ===============================================================================================*/

export interface PricingStrategyFactoryOptions {
    /** Global default revenue model */
    defaultStrategy: 'USAGE' | 'SUBSCRIPTION';
    /**
     * Optional override per user tier.
     * Example: { FREE: 'USAGE', STANDARD: 'SUBSCRIPTION', ENTERPRISE: 'SUBSCRIPTION' }
     */
    perTierOverride?: Partial<Record<InferenceRequest['userTier'], 'USAGE' | 'SUBSCRIPTION'>>;
}

/**
 * Provides the correct PricingStrategy for each inference request without leaking implementation
 * details to the caller.
 */
export class PricingStrategyFactory {
    private readonly options: PricingStrategyFactoryOptions;

    private readonly usageStrategy = new UsageBasedPricingStrategy();
    private readonly subscriptionStrategy = new SubscriptionPricingStrategy();

    constructor(options: PricingStrategyFactoryOptions) {
        this.options = Object.freeze({ ...options });
    }

    public resolve(request: InferenceRequest): PricingStrategy {
        const override = this.options.perTierOverride?.[request.userTier];
        const mode = override ?? this.options.defaultStrategy;

        switch (mode) {
            case 'USAGE':
                return this.usageStrategy;
            case 'SUBSCRIPTION':
                return this.subscriptionStrategy;
            default:
                // Should never happen, but we fallback safely.
                return this.usageStrategy;
        }
    }
}

/* =================================================================================================
 *  Observer Pattern — lightweight in-process event bus
 * ===============================================================================================*/

/**
 * Simple event bus using Node.js EventEmitter for in-process delivery. Out-of-process distribution
 * (Kafka, SNS, etc.) is handled by adapters listening to these events.
 */
export class PricingEventBus {
    private readonly emitter = new EventEmitter();

    public subscribe(observer: PricingEventObserver): () => void {
        const handler = (event: PricingEvent): void => observer.onPriceCalculated(event);
        this.emitter.on('pricing_event', handler);

        // Return unsubscribe function.
        return () => this.emitter.off('pricing_event', handler);
    }

    public publish(event: PricingEvent): void {
        this.emitter.emit('pricing_event', event);
    }
}

/* =================================================================================================
 *  Domain Service — PriceCalculator
 * ===============================================================================================*/

/**
 * Calculates price for inference requests and publishes result to observers.
 */
export class PriceCalculatorService {
    constructor(
        private readonly factory: PricingStrategyFactory,
        private readonly eventBus: PricingEventBus
    ) {}

    /**
     * Entry point called by application services (e.g., REST adapter, Kafka consumer).
     */
    public handleRequest(request: InferenceRequest): Money {
        const strategy = this.factory.resolve(request);
        const price = strategy.calculatePrice(request);

        const event: PricingEvent = {
            request,
            price,
            strategyId: strategy.id,
            issuedAt: new Date().toISOString()
        };

        this.eventBus.publish(event);
        return price;
    }
}

/* =================================================================================================
 *  Example Usage (would normally live in an adapter layer)
 * ===============================================================================================*/

// Below code is here for completeness; remove or move to adapter during integration.
/*
const factory = new PricingStrategyFactory({
    defaultStrategy: 'USAGE',
    perTierOverride: { ENTERPRISE: 'SUBSCRIPTION' }
});
const eventBus = new PricingEventBus();

eventBus.subscribe({
    onPriceCalculated: (e) => console.log(`[PricingEvent] ${e.strategyId} → ${e.price.toString()}`)
});

const service = new PriceCalculatorService(factory, eventBus);

const demoRequest: InferenceRequest = {
    modelName: 'churn_predictor_v2',
    timestamp: new Date().toISOString(),
    latencyMs: 120,
    payloadKb: 15.3,
    userTier: 'STANDARD',
    premiumSla: true
};

service.handleRequest(demoRequest);
*/
```