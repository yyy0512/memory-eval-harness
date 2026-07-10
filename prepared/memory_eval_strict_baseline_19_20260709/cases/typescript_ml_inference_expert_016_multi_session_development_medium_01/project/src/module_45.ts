```typescript
/**
 * InsightHexaAI
 * File: src/module_45.ts
 *
 * Domain-level implementation of SLA-aware inference pricing strategies.
 *
 *  • Strictly “inside the hexagon” – no IO, DB, HTTP, or cloud SDK calls.
 *  • Strategy Pattern: swap pricing algorithms at runtime (subscription vs. usage-based, etc.).
 *  • Factory Pattern: determine correct strategy from (mutable) enterprise contract.
 *  • Observer Pattern: broadcast pricing decisions for audit & monitoring adapters.
 */

import { EventEmitter } from 'events';

/**
 * Value object representing money.
 *
 * Enforces currency consistency and prohibits arithmetic on raw numbers,
 * preventing “USD vs EUR” mix-ups across bounded contexts.
 */
export class Money {
    readonly amount: number;
    readonly currency: Currency;

    constructor(amount: number, currency: Currency = 'USD') {
        if (!Number.isFinite(amount) || amount < 0) {
            throw new DomainError(`Money amount must be a non-negative finite number. Received: ${amount}`);
        }
        this.amount = Number(amount.toFixed(4)); // store with 4-decimal precision
        this.currency = currency;
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.amount + other.amount, this.currency);
    }

    multiply(factor: number): Money {
        if (!Number.isFinite(factor) || factor < 0) {
            throw new DomainError(`Multiply factor must be a non-negative finite number. Received: ${factor}`);
        }
        return new Money(this.amount * factor, this.currency);
    }

    toString(): string {
        return `${this.currency} ${this.amount.toFixed(4)}`;
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency) {
            throw new DomainError(
                `Currency mismatch: ${this.currency} cannot be combined with ${other.currency}`,
            );
        }
    }
}

export type Currency = 'USD' | 'EUR' | 'GBP';

/**
 * Enterprise SLA tiers.
 */
export enum SlaTier {
    BASIC = 'BASIC',
    STANDARD = 'STANDARD',
    PREMIUM = 'PREMIUM',
}

/**
 * Pricing model types understood by the Factory.
 */
export enum PricingModelType {
    USAGE_BASED = 'USAGE_BASED',
    SUBSCRIPTION = 'SUBSCRIPTION',
}

/**
 * Core domain event Emitter for this module.
 *
 * NOTE: Concrete adapters (Kafka, SNS, etc.) subscribe to this emitter from
 *       their infrastructure layer, converting local events into transport-level
 *       messages without polluting domain logic.
 */
export const pricingDomainEmitter = new EventEmitter();

/**
 * Event names for `pricingDomainEmitter`.
 */
export const PricingDomainEvent = {
    PRICING_CALCULATED: 'PRICING_CALCULATED',
} as const;

/**
 * Domain exception for predictable runtime errors.
 */
export class DomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DomainError';
    }
}

/**
 * Strategy interface for inference pricing algorithms.
 */
export interface InferencePricingStrategy {
    /**
     * Calculates the price of model inference under the strategy.
     *
     * @param inferenceCount          Number of inferences (per billing window)
     * @param modelComplexityScore    Relative complexity in [0.0, 1.0] – e.g., large vision transformer ≈ 1.0
     * @param slaTier                 Enterprise SLA tier
     */
    calculateCost(
        inferenceCount: number,
        modelComplexityScore: number,
        slaTier: SlaTier,
    ): Money;
}

/**
 * Usage-based pricing algorithm.
 *
 * Cost = (BASE + COMPLEXITY) × SLA_MULTIPLIER × inferenceCount
 */
export class UsageBasedPricingStrategy implements InferencePricingStrategy {
    private readonly BASE_PRICE = new Money(0.0004);
    private readonly COMPLEXITY_FACTOR = 0.0012; // additional $ per inference * complexity score

    calculateCost(
        inferenceCount: number,
        modelComplexityScore: number,
        slaTier: SlaTier,
    ): Money {
        this.validateInputs(inferenceCount, modelComplexityScore);
        const complexityCost = this.COMPLEXITY_FACTOR * modelComplexityScore;
        const unitPrice = this.BASE_PRICE
            .add(new Money(complexityCost))
            .multiply(this.getSlaMultiplier(slaTier));

        const totalCost = unitPrice.multiply(inferenceCount);
        this.emitPricingCalculated(
            PricingModelType.USAGE_BASED,
            inferenceCount,
            modelComplexityScore,
            slaTier,
            totalCost,
        );
        return totalCost;
    }

    private getSlaMultiplier(tier: SlaTier): number {
        switch (tier) {
            case SlaTier.BASIC:
                return 1;
            case SlaTier.STANDARD:
                return 1.2;
            case SlaTier.PREMIUM:
                return 1.5;
            default:
                return 1;
        }
    }

    private validateInputs(inferenceCount: number, complexity: number): void {
        if (!Number.isInteger(inferenceCount) || inferenceCount < 0) {
            throw new DomainError(
                `inferenceCount must be a non-negative integer. Received: ${inferenceCount}`,
            );
        }
        if (!Number.isFinite(complexity) || complexity < 0 || complexity > 1) {
            throw new DomainError(
                `modelComplexityScore must be in [0, 1]. Received: ${complexity}`,
            );
        }
    }

    private emitPricingCalculated(
        model: PricingModelType,
        count: number,
        complexity: number,
        tier: SlaTier,
        cost: Money,
    ): void {
        pricingDomainEmitter.emit(PricingDomainEvent.PRICING_CALCULATED, {
            model,
            count,
            complexity,
            tier,
            cost,
            timestamp: new Date().toISOString(),
        });
    }
}

/**
 * Subscription-based pricing algorithm.
 *
 * Enterprises pre-purchase “credits” that expire monthly. Overages fall back
 * to usage-based pricing of <UsageBasedPricingStrategy>.
 */
export class SubscriptionBasedPricingStrategy implements InferencePricingStrategy {
    // These would be injected via configuration/constructor in real code
    private readonly CREDIT_TABLE: Record<SlaTier, number> = {
        [SlaTier.BASIC]: 250_000,
        [SlaTier.STANDARD]: 1_000_000,
        [SlaTier.PREMIUM]: 5_000_000,
    };
    private readonly MONTHLY_SUBSCRIPTION_FEE: Record<SlaTier, Money> = {
        [SlaTier.BASIC]: new Money(999),
        [SlaTier.STANDARD]: new Money(4_999),
        [SlaTier.PREMIUM]: new Money(12_999),
    };

    private readonly overageStrategy = new UsageBasedPricingStrategy();

    calculateCost(
        inferenceCount: number,
        modelComplexityScore: number,
        slaTier: SlaTier,
    ): Money {
        if (!Number.isInteger(inferenceCount) || inferenceCount < 0) {
            throw new DomainError(
                `inferenceCount must be a non-negative integer. Received: ${inferenceCount}`,
            );
        }

        const monthlyCredits = this.CREDIT_TABLE[slaTier];
        const subscriptionFee = this.MONTHLY_SUBSCRIPTION_FEE[slaTier];

        // No overage – flat subscription fee
        if (inferenceCount <= monthlyCredits) {
            this.emitPricingCalculated(
                subscriptionFee,
                slaTier,
                inferenceCount,
                modelComplexityScore,
                0,
            );
            return subscriptionFee;
        }

        // Overage path
        const overageCount = inferenceCount - monthlyCredits;
        const overageCost = this.overageStrategy.calculateCost(
            overageCount,
            modelComplexityScore,
            slaTier,
        );
        const total = subscriptionFee.add(overageCost);

        this.emitPricingCalculated(
            total,
            slaTier,
            inferenceCount,
            modelComplexityScore,
            overageCount,
        );
        return total;
    }

    private emitPricingCalculated(
        totalCost: Money,
        slaTier: SlaTier,
        inferenceCount: number,
        complexityScore: number,
        overageCount: number,
    ): void {
        pricingDomainEmitter.emit(PricingDomainEvent.PRICING_CALCULATED, {
            model: PricingModelType.SUBSCRIPTION,
            slaTier,
            inferenceCount,
            complexityScore,
            overageCount,
            totalCost,
            timestamp: new Date().toISOString(),
        });
    }
}

/**
 * Factory: picks a pricing strategy at runtime based on the enterprise contract.
 */
export class PricingStrategyFactory {
    /**
     * Returns an InferencePricingStrategy for the requested model type.
     *
     * @throws DomainError if the type is unsupported
     */
    static getStrategy(type: PricingModelType): InferencePricingStrategy {
        switch (type) {
            case PricingModelType.USAGE_BASED:
                return new UsageBasedPricingStrategy();
            case PricingModelType.SUBSCRIPTION:
                return new SubscriptionBasedPricingStrategy();
            default:
                throw new DomainError(`Unsupported pricing model type: ${type}`);
        }
    }
}

/**
 * Convenience facade for callers inside the domain.
 *
 * NOTE: Keeps resource lifetimes/instantiation hidden from application layer.
 */
export class PricingService {
    calculatePrice(
        type: PricingModelType,
        inferenceCount: number,
        modelComplexityScore: number,
        slaTier: SlaTier,
    ): Money {
        const strategy = PricingStrategyFactory.getStrategy(type);
        return strategy.calculateCost(inferenceCount, modelComplexityScore, slaTier);
    }
}

/**
 * Register default event listeners for debugging (no side effects in prod).
 *
 * Infrastructure layer is responsible for swapping these with proper adapters.
 */
if (process.env.NODE_ENV === 'development') {
    pricingDomainEmitter.on(PricingDomainEvent.PRICING_CALCULATED, (payload) => {
        // eslint-disable-next-line no-console
        console.debug('[DomainEvent] pricing_calculated', payload);
    });
}
```