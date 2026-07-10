```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_20.ts
 * Responsibility:
 *   Core-domain service that computes SLA-aware, revenue-impacting inference pricing.  The service
 *   demonstrates Strategy-Pattern + Factory-Pattern inside the hexagon and publishes domain events
 *   (Observer-Pattern) to the rest of the platform whenever a billable inference is requested.
 *
 *   External infrastructure (Kafka, S3, etc.) is *not* referenced here; those are implemented as
 *   adapters in other layers.  This module is 100 % business logic and therefore testable without
 *   IO.
 *
 * -----------------------------------------------------------------------------------------------
 * Public exports:
 *   • PricingService         – Facade used by application-level ports / controllers.
 *   • PricingStrategyFactory – Factory that materialises a concrete strategy from a plan id.
 *   • PricingStrategies      – Re-export of concrete strategies for unit testing purposes.
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Value Objects / Types
 * -----------------------------------------------------------------------------------------------*/

/**
 * Enumeration of currently-supported commercial models.  New entries can be added without touching
 * existing strategies thanks to the Factory-Pattern.
 */
export enum CommercialPlanType {
    USAGE = 'USAGE',
    SUBSCRIPTION = 'SUBSCRIPTION',
    TIERED = 'TIERED',
}

/**
 * Immutable description of an enterprise plan.  Application services (adapters) typically deserialize
 * this object from a DB record or configuration file before injecting it into PricingService.
 */
export interface CommercialPlan {
    id: string;                       // Human-readable plan identifier (“enterprise-plus” …)
    type: CommercialPlanType;         // Determines which strategy the factory will provide.
    currency: string;                 // ISO-4217 code, e.g. “USD”
    parameters: Record<string, any>;  // Strategy-specific parameters, validated by each strategy.
}

/**
 * Input information for a single inference request in the system.  Kept intentionally small; the
 * hexagon should not depend on concrete transport (REST, gRPC, …).
 */
export interface InferenceMeta {
    tenantId: string;                 // UUID or slug of the tenant calling the inference API
    modelName: string;                // Name of the model that produced the inference
    predictionCount: number;          // Number of individual predictions requested
}

/**
 * Result object returned when `PricingService.price()` is called.
 */
export interface PricingQuote {
    readonly tenantId: string;
    readonly modelName: string;
    readonly currency: string;
    readonly totalAmount: number;     // Final price, already rounded to the smallest currency unit
    readonly unitAmount: number;      // Per-prediction price
    readonly appliedPlan: CommercialPlan;
    readonly calculatedAt: Date;
}

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Events (Observer-Pattern)
 * -----------------------------------------------------------------------------------------------*/

/**
 * Domain event base interface.  Additional properties are allowed, but these are mandatory.
 */
export interface DomainEvent<TPayload = any> {
    readonly type: string;
    readonly payload: TPayload;
    readonly occurredAt: Date;
}

/**
 * Concrete event emitted whenever we successfully produce a `PricingQuote`.
 */
export interface PricingCalculatedEvent extends DomainEvent<PricingQuote> {
    readonly type: 'PricingCalculated';
}

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Event Bus (Simple in-memory implementation; production adapters can forward to Kafka)
 * -----------------------------------------------------------------------------------------------*/

export interface EventBus {
    publish<T extends DomainEvent>(event: T): void;
    subscribe<T extends DomainEvent = DomainEvent>(
        eventType: T['type'],
        listener: (event: T) => void,
    ): () => void; // Unsubscribe function
}

/**
 * In-memory, synchronous EventBus.  Sufficient for unit tests and local dev; adapters can bridge it
 * to async message brokers in upper layers.
 */
export class SimpleEventBus implements EventBus {
    private readonly emitter = new EventEmitter({ captureRejections: true });

    publish<T extends DomainEvent>(event: T): void {
        this.emitter.emit(event.type, event);
    }

    subscribe<T extends DomainEvent = DomainEvent>(
        eventType: T['type'],
        listener: (event: T) => void,
    ): () => void {
        this.emitter.on(eventType, listener);
        return () => this.emitter.off(eventType, listener);
    }
}

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Strategy-Pattern ▸ PricingStrategy interface
 * -----------------------------------------------------------------------------------------------*/

export interface PricingStrategy {
    /**
     * Computes the unit (per-prediction) and total cost for an inference request.
     * Implementations must never mutate arguments; they should also remain pure for predictability.
     */
    calculate(plan: CommercialPlan, request: InferenceMeta): Pick<PricingQuote, 'unitAmount' | 'totalAmount'>;
}

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Strategy-Pattern ▸ Concrete Strategies
 * -----------------------------------------------------------------------------------------------*/

class UsageBasedPricingStrategy implements PricingStrategy {
    /**
     * `parameters` contract:
     * {
     *   unitPrice: number  // price per prediction, in plan.currency (e.g. 0.0023 USD)
     * }
     */
    calculate(plan: CommercialPlan, request: InferenceMeta) {
        const unitPrice = Number(plan.parameters.unitPrice);
        if (isNaN(unitPrice) || unitPrice < 0) {
            throw new DomainValidationError(
                `Invalid UsageBased plan parameter "unitPrice": ${plan.parameters.unitPrice}`,
            );
        }
        const total = roundCurrency(unitPrice * request.predictionCount);
        return { unitAmount: unitPrice, totalAmount: total };
    }
}

class SubscriptionPricingStrategy implements PricingStrategy {
    /**
     * `parameters` contract:
     * {
     *   includedPredictions: number,  // predictions included in monthly fee
     *   overageUnitPrice: number      // price per prediction beyond quota
     *   monthlyFee: number            // fixed monthly price
     * }
     */
    calculate(plan: CommercialPlan, request: InferenceMeta) {
        const { includedPredictions, overageUnitPrice, monthlyFee } = plan.parameters;
        assertPositiveNumber(includedPredictions, 'includedPredictions');
        assertPositiveNumber(overageUnitPrice, 'overageUnitPrice');
        assertPositiveNumber(monthlyFee, 'monthlyFee');

        const overage = Math.max(0, request.predictionCount - includedPredictions);
        const overageCost = roundCurrency(overage * overageUnitPrice);
        // Monthly fee is accounted elsewhere (invoicing cycle) – we still include it for completeness
        const total = roundCurrency(overageCost); // Only variable component returned
        return { unitAmount: overageUnitPrice, totalAmount: total };
    }
}

class TieredPricingStrategy implements PricingStrategy {
    /**
     * `parameters` contract:
     * {
     *   tiers: Array<{ upTo: number, unitPrice: number }>
     * }
     * Example:
     *   tiers: [
     *     { upTo: 1_000_000, unitPrice: 0.0020 },
     *     { upTo: 10_000_000, unitPrice: 0.0015 },
     *     { upTo: Infinity,   unitPrice: 0.0010 }
     *   ]
     */
    calculate(plan: CommercialPlan, request: InferenceMeta) {
        const tiers: Array<{ upTo: number; unitPrice: number }> = plan.parameters.tiers;
        if (!Array.isArray(tiers) || tiers.length === 0) {
            throw new DomainValidationError(`Tiered plan must define a non-empty "tiers" array`);
        }

        // Sort tiers to guarantee ascending `upTo`
        const sorted = tiers.slice().sort((a, b) => a.upTo - b.upTo);

        // Determine applicable tier for unit price, and sum across tiers for total
        let remaining = request.predictionCount;
        let total = 0;
        for (const { upTo, unitPrice } of sorted) {
            assertPositiveNumber(unitPrice, 'unitPrice');
            const tierSize = Math.min(remaining, upTo === Infinity ? remaining : upTo);
            total += tierSize * unitPrice;
            remaining -= tierSize;
            if (remaining <= 0) break;
        }
        const effectiveUnitPrice =
            request.predictionCount > 0 ? total / request.predictionCount : 0;

        return { unitAmount: roundCurrency(effectiveUnitPrice), totalAmount: roundCurrency(total) };
    }
}

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Factory-Pattern ▸ PricingStrategyFactory
 * -----------------------------------------------------------------------------------------------*/

export class PricingStrategyFactory {
    /**
     * Returns an immutable, stateless strategy instance for the provided plan.
     * @throws DomainValidationError if `plan.type` is not supported.
     */
    static getStrategyFor(plan: CommercialPlan): PricingStrategy {
        switch (plan.type) {
            case CommercialPlanType.USAGE:
                return usageStrategySingleton;
            case CommercialPlanType.SUBSCRIPTION:
                return subscriptionStrategySingleton;
            case CommercialPlanType.TIERED:
                return tieredStrategySingleton;
            default:
                throw new DomainValidationError(
                    `Unsupported CommercialPlanType "${(plan as any).type}"`,
                );
        }
    }
}

// Eager singletons (strategies are stateless, so reuse them)
const usageStrategySingleton = new UsageBasedPricingStrategy();
const subscriptionStrategySingleton = new SubscriptionPricingStrategy();
const tieredStrategySingleton = new TieredPricingStrategy();

/* -------------------------------------------------------------------------------------------------
 * Domain ▸ Service ▸ PricingService
 * -----------------------------------------------------------------------------------------------*/

/**
 * Primary entry point used by controllers / application services.  Stateless and therefore safe to
 * be a singleton as well.
 */
export class PricingService {
    constructor(
        private readonly eventBus: EventBus = defaultEventBus, // Allows caller to supply a mock
    ) {}

    /**
     * Computes the price for a batch of predictions and publishes `PricingCalculated` domain event.
     */
    price(plan: CommercialPlan, request: InferenceMeta): PricingQuote {
        // Guards
        if (request.predictionCount <= 0) {
            throw new DomainValidationError(
                `predictionCount must be positive, got ${request.predictionCount}`,
            );
        }

        // Strategy retrieval & calculation
        const strategy = PricingStrategyFactory.getStrategyFor(plan);
        const { unitAmount, totalAmount } = strategy.calculate(plan, request);

        const quote: PricingQuote = {
            tenantId: request.tenantId,
            modelName: request.modelName,
            currency: plan.currency,
            unitAmount,
            totalAmount,
            appliedPlan: plan,
            calculatedAt: new Date(),
        };

        // Emit domain event (synchronous – can be bridged to async by an adapter)
        const event: PricingCalculatedEvent = {
            type: 'PricingCalculated',
            occurredAt: new Date(),
            payload: quote,
        };
        this.eventBus.publish(event);

        return quote;
    }
}

/* -------------------------------------------------------------------------------------------------
 * Helper ▸ Domain Errors & Validation
 * -----------------------------------------------------------------------------------------------*/

/**
 * Minimal domain-level error to express invalid input or illegal business state.
 */
export class DomainValidationError extends Error {
    constructor(message: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

function assertPositiveNumber(value: any, field: string): void {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        throw new DomainValidationError(`"${field}" must be a positive number, got ${value}`);
    }
}

function roundCurrency(amount: number): number {
    // Round to the fourth decimal place (0.0001) to support sub-cent unit prices
    return Math.round(amount * 10_000) / 10_000;
}

/* -------------------------------------------------------------------------------------------------
 * Default EventBus Singleton (used when caller doesn’t provide one)
 * -----------------------------------------------------------------------------------------------*/

const defaultEventBus = new SimpleEventBus();

/* -------------------------------------------------------------------------------------------------
 * Re-exports for downstream modules
 * -----------------------------------------------------------------------------------------------*/

export const PricingStrategies = {
    UsageBased: usageStrategySingleton,
    Subscription: subscriptionStrategySingleton,
    Tiered: tieredStrategySingleton,
};

```