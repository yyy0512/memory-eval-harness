```typescript
/***************************************************************************************************
 * File:        src/module_38.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Revenue-centric Pricing Engine that applies Strategy- and Factory-Patterns to
 *              calculate SLA-aware inference costs and emits observable KPI events when thresholds
 *              are breached. Fits neatly into the hexagonal architecture’s core domain layer.
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------- */
/*                              Domain-Level Types                            */
/* -------------------------------------------------------------------------- */

/**
 * Monetary amount expressed in smallest denomination of a given currency.
 * Using an object over primitive reduces risk of currency/amount mismatch.
 */
export interface Money {
    readonly amount: number;   // e.g. 123.45 USD → 12345 cents
    readonly currency: string; // ISO-4217 code, e.g. “USD”
}

/**
 * Immutable input required to price an inference request.
 */
export interface PricingContext {
    readonly customerId: string;
    readonly modelKey: string;          // “churn-rf:v42”
    readonly inferences: number;        // number of predictions requested
    readonly slaTier: 'bronze' | 'silver' | 'gold' | 'platinum';
    readonly timestamp: Date;           // server-side, not client-side
}

/* -------------------------------------------------------------------------- */
/*                                  Errors                                    */
/* -------------------------------------------------------------------------- */

/** Thrown when an unsupported pricing strategy is requested. */
export class UnknownPricingStrategyError extends Error {
    constructor(strategyName: string) {
        super(`Pricing strategy "${strategyName}" is not recognized.`);
        this.name = 'UnknownPricingStrategyError';
    }
}

/** Thrown when the cost engine cannot complete due to invalid values. */
export class PricingCalculationError extends Error {
    constructor(message: string, public readonly context?: PricingContext) {
        super(`Pricing calculation failed: ${message}`);
        this.name = 'PricingCalculationError';
    }
}

/* -------------------------------------------------------------------------- */
/*                          Strategy Pattern – Contracts                      */
/* -------------------------------------------------------------------------- */

/**
 * Contract that any pricing strategy must honour.
 * A strategy must be side-effect-free – i.e. pure function of inputs.
 */
export interface PricingStrategy {
    readonly name: string;
    computeCost(context: PricingContext): Money;
}

/* -------------------------------------------------------------------------- */
/*                          Strategy Pattern – Concrete                       */
/* -------------------------------------------------------------------------- */

/**
 * Simple subscription model: flat monthly cost, unlimited inferences.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
    readonly name = 'subscription';

    constructor(
        private readonly monthlyFee: Money,
        private readonly monthsCovered: number = 1
    ) {}

    computeCost(_: PricingContext): Money {
        // Flat fee, ignore context
        return this.monthlyFee;
    }
}

/**
 * Usage-based model: customer pays per 1 000 inferences.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
    readonly name = 'usage';

    constructor(
        private readonly pricePerThousand: Money,
        private readonly freeTierLimit: number = 0
    ) {}

    computeCost(context: PricingContext): Money {
        if (context.inferences <= this.freeTierLimit) {
            return { amount: 0, currency: this.pricePerThousand.currency };
        }

        const thousandBlocks = Math.ceil(
            (context.inferences - this.freeTierLimit) / 1_000
        );

        return {
            amount: thousandBlocks * this.pricePerThousand.amount,
            currency: this.pricePerThousand.currency
        };
    }
}

/**
 * Hybrid model: subscription covers a quota, extra usage is charged.
 */
export class HybridPricingStrategy implements PricingStrategy {
    readonly name = 'hybrid';

    constructor(
        private readonly baseFee: Money,
        private readonly quota: number, // inferences included
        private readonly overagePrice: Money
    ) {}

    computeCost(context: PricingContext): Money {
        if (context.inferences <= this.quota) {
            return this.baseFee;
        }

        const excess = context.inferences - this.quota;
        const thousandBlocks = Math.ceil(excess / 1_000);

        return {
            amount: this.baseFee.amount + thousandBlocks * this.overagePrice.amount,
            currency: this.baseFee.currency
        };
    }
}

/* -------------------------------------------------------------------------- */
/*                        Factory Pattern – Strategy Picker                   */
/* -------------------------------------------------------------------------- */

export interface StrategyInitOptions {
    monthlyFee?: Money;
    pricePerThousand?: Money;
    freeTierLimit?: number;
    baseFee?: Money;
    quota?: number;
    overagePrice?: Money;
}

/**
 * Centralised factory: sequence of if-branches keeps IoC simple; could be
 * replaced by reflection or DI container if codebase scales further.
 */
export class PricingStrategyFactory {
    static create(
        strategyName: string,
        options: StrategyInitOptions
    ): PricingStrategy {
        switch (strategyName) {
            case 'subscription':
                if (!options.monthlyFee) {
                    throw new PricingCalculationError(
                        'monthlyFee option required for subscription strategy'
                    );
                }
                return new SubscriptionPricingStrategy(options.monthlyFee);
            case 'usage':
                if (!options.pricePerThousand) {
                    throw new PricingCalculationError(
                        'pricePerThousand option required for usage strategy'
                    );
                }
                return new UsageBasedPricingStrategy(
                    options.pricePerThousand,
                    options.freeTierLimit ?? 0
                );
            case 'hybrid':
                if (
                    !options.baseFee ||
                    !options.quota ||
                    !options.overagePrice
                ) {
                    throw new PricingCalculationError(
                        'baseFee, quota and overagePrice options required for hybrid strategy'
                    );
                }
                return new HybridPricingStrategy(
                    options.baseFee,
                    options.quota,
                    options.overagePrice
                );
            default:
                throw new UnknownPricingStrategyError(strategyName);
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                 Observer Pattern – KPI Event Definitions                   */
/* -------------------------------------------------------------------------- */

/**
 * Event payload when cost breaches an alert threshold (defined by finance).
 */
export interface CostAlertEvent {
    readonly customerId: string;
    readonly totalCost: Money;
    readonly threshold: Money;
    readonly context: PricingContext;
}

type PricingEngineEvents = {
    'cost:calculated': (cost: Money, ctx: PricingContext) => void;
    'cost:alert': (event: CostAlertEvent) => void;
};

declare interface PricingEngine {
    on<U extends keyof PricingEngineEvents>(
        event: U,
        listener: PricingEngineEvents[U]
    ): this;

    emit<U extends keyof PricingEngineEvents>(
        event: U,
        ...args: Parameters<PricingEngineEvents[U]>
    ): boolean;
}

/* -------------------------------------------------------------------------- */
/*                     Pricing Engine – Observable Service                    */
/* -------------------------------------------------------------------------- */

export class PricingEngine extends EventEmitter {
    // Finance team defines alerts (e.g., 50k USD/day per customer)
    private readonly alertThreshold: Money;

    constructor(
        private strategy: PricingStrategy,
        alertThreshold: Money = { amount: 50_000_00, currency: 'USD' } // $50 000.00
    ) {
        super();
        this.alertThreshold = alertThreshold;
    }

    /**
     * Swap strategy at runtime – useful for A/B tests or contract upgrades.
     */
    public setStrategy(strategy: PricingStrategy): void {
        this.strategy = strategy;
    }

    /**
     * Calculate cost and emit observability events.
     * Error handling is delegated up: callers decide on retry/compensation.
     */
    public calculateCost(context: PricingContext): Money {
        try {
            const cost = this.strategy.computeCost(context);

            // Notify any subsystem listening (billing, dashboards, etc.)
            this.emit('cost:calculated', cost, context);

            // Alert only if in same currency – production code would convert
            if (
                cost.currency === this.alertThreshold.currency &&
                cost.amount >= this.alertThreshold.amount
            ) {
                const event: CostAlertEvent = {
                    customerId: context.customerId,
                    totalCost: cost,
                    threshold: this.alertThreshold,
                    context
                };
                this.emit('cost:alert', event);
            }

            return cost;
        } catch (err) {
            // Wrap unknown errors
            if (err instanceof PricingCalculationError) throw err;
            throw new PricingCalculationError(
                err instanceof Error ? err.message : String(err),
                context
            );
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                      Example Usage (would live in adapter)                 */
/* -------------------------------------------------------------------------- */

// NOTE: Example code is kept for clarity but should be removed or moved to
//       unit tests / integration adapters in production environments.
/*
const engine = new PricingEngine(
    PricingStrategyFactory.create('usage', {
        pricePerThousand: { amount: 150, currency: 'USD' }, // $1.50
        freeTierLimit: 10_000
    })
);

engine.on('cost:calculated', (cost) => {
    console.log(`Cost calculated: $${cost.amount / 100}`);
});

engine.on('cost:alert', (evt) => {
    console.error(
        `ALERT – Customer ${evt.customerId} cost $${evt.totalCost.amount / 100
        } exceeded threshold`
    );
});

const cost = engine.calculateCost({
    customerId: 'acme-corp',
    modelKey: 'churn-rf:v42',
    inferences: 1_250_000,
    slaTier: 'gold',
    timestamp: new Date()
});

console.log('Final cost (cents):', cost.amount);
*/
```