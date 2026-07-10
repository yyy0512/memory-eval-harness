```typescript
/**************************************************************************************************
 * File:         src/module_66.ts
 * Project:      InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description:  Pricing & Billing domain services (hexagon core).
 *
 *               This module provides an extensible pricing engine that determines how much to
 *               charge for a single inference request.  The implementation follows the
 *               Strategy-, Factory-, and Observer-Patterns in order to keep the domain logic
 *               independent from technical concerns (billing adapters, payment gateways, etc.).
 *
 *               High-level flow:
 *                 1. PricingEngine receives an InferenceRequestContext.
 *                 2. Engine delegates price calculation to a PricingStrategy chosen by the factory.
 *                 3. Resulting PricingEvent is emitted to observers (dashboards, alerts, ledgers).
 *
 *               NOTE:  External adapters (e.g., Stripe, SAP) subscribe via PricingObserver to
 *                      perform IO outside this core hexagon.
 **************************************************************************************************/

//#region Imports ──────────────────────────────────────────────────────────────────────────────────
import { v4 as uuid } from 'uuid';
//#endregion

//#region Public Types ─────────────────────────────────────────────────────────────────────────────

/**
 * Immutable information describing the inference request that needs pricing.
 */
export interface InferenceRequestContext {
    readonly requestId: string;          // Unique identifier for the inference request.
    readonly modelId: string;            // Model that served the prediction.
    readonly userId: string;             // End-customer / tenant.
    readonly timestamp: Date;            // When the inference happened.
    readonly cpuMs: number;              // CPU-time consumed (milliseconds).
    readonly gpuMs: number;              // GPU-time consumed (milliseconds).
    readonly inputBytes: number;         // Size of the request payload.
    readonly outputBytes: number;        // Size of the prediction output.
    readonly slaTier: 'STANDARD' | 'PREMIUM';
}

/**
 * Money with minor units (e.g., cents) to avoid floating-point imprecision.
 */
export interface Money {
    readonly currency: 'USD' | 'EUR';
    readonly amountMinor: number; // e.g., $12.34 => 1234
}

/**
 * Pricing result emitted after a calculation.
 */
export interface PricingResult {
    readonly price: Money;
    readonly appliedStrategy: string;
    readonly meta: Record<string, unknown>;
}

//#endregion

//#region Strategy Pattern ─────────────────────────────────────────────────────────────────────────

/**
 * Strategy interface for different pricing models.
 */
export interface PricingStrategy {
    /**
     * Calculates the price of an inference request.
     * @param ctx   – immutable request metadata.
     * @returns     – result containing price and extra metadata.
     */
    calculate(ctx: InferenceRequestContext): PricingResult;
}

/**
 * Usage-based pricing: charge proportional to compute & bandwidth usage.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {

    private readonly cpuRatePerSecondMinor: number;  // e.g., 0.2¢ per CPU-second
    private readonly gpuRatePerSecondMinor: number;  // e.g., 1.5¢ per GPU-second
    private readonly dataRatePerMBMinor: number;     // e.g., 0.05¢ per MB transfer

    constructor(
        cpuRatePerSecondMinor = 20,
        gpuRatePerSecondMinor = 150,
        dataRatePerMBMinor = 5
    ) {
        this.cpuRatePerSecondMinor = cpuRatePerSecondMinor;
        this.gpuRatePerSecondMinor = gpuRatePerSecondMinor;
        this.dataRatePerMBMinor = dataRatePerMBMinor;
    }

    calculate(ctx: InferenceRequestContext): PricingResult {
        const cpuSeconds = ctx.cpuMs / 1000;
        const gpuSeconds = ctx.gpuMs / 1000;
        const mbTransferred = (ctx.inputBytes + ctx.outputBytes) / (1024 * 1024);

        // SLA multiplier for premium tier
        const slaMultiplier = ctx.slaTier === 'PREMIUM' ? 1.25 : 1.0;

        const priceMinor = Math.round(
            (
                cpuSeconds * this.cpuRatePerSecondMinor +
                gpuSeconds * this.gpuRatePerSecondMinor +
                mbTransferred * this.dataRatePerMBMinor
            ) * slaMultiplier
        );

        return {
            price: {
                currency: 'USD',
                amountMinor: priceMinor
            },
            appliedStrategy: 'USAGE_BASED',
            meta: {
                cpuSeconds,
                gpuSeconds,
                mbTransferred,
                slaMultiplier
            }
        };
    }
}

/**
 * Subscription pricing: flat monthly fee, zero marginal cost per request.
 * Still returns a per-request cost of $0.00 for traceability.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
    calculate(ctx: InferenceRequestContext): PricingResult {
        return {
            price: { currency: 'USD', amountMinor: 0 },
            appliedStrategy: 'SUBSCRIPTION',
            meta: { note: 'Covered by flat monthly subscription.' }
        };
    }
}

//#endregion

//#region Factory Pattern ──────────────────────────────────────────────────────────────────────────

/**
 * Factory responsible for instantiating PricingStrategy based on tenant configuration.
 * For the purpose of this core module, configuration is passed in directly; in a real system
 * the adapter layer would fetch from Snowflake, DynamoDB, etc.
 */
export class PricingStrategyFactory {

    constructor(
        private readonly cfgProvider: BillingConfigProvider
    ) { }

    /**
     * Returns the correct strategy instance for the given user.
     * @throws Error when configuration is missing or invalid.
     */
    public getStrategyForUser(userId: string): PricingStrategy {
        const cfg = this.cfgProvider.getBillingConfig(userId);
        switch (cfg.plan) {
            case 'USAGE':
                return new UsageBasedPricingStrategy(
                    cfg.cpuRateMinor,
                    cfg.gpuRateMinor,
                    cfg.dataRateMinor
                );
            case 'SUBSCRIPTION':
                return new SubscriptionPricingStrategy();
            default:
                throw new Error(
                    `Unsupported billing plan '${(cfg as any).plan}' for user '${userId}'.`
                );
        }
    }
}

/**
 * Minimal contract satisfied by configuration providers inside the hexagon.
 */
export interface BillingConfigProvider {
    getBillingConfig(userId: string): BillingConfig;
}

/**
 * DTO representing billing configuration for a tenant.
 */
export type BillingPlan = 'USAGE' | 'SUBSCRIPTION';

export interface BillingConfig {
    readonly userId: string;
    readonly plan: BillingPlan;
    readonly cpuRateMinor: number;
    readonly gpuRateMinor: number;
    readonly dataRateMinor: number;
}

//#endregion

//#region Observer Pattern ─────────────────────────────────────────────────────────────────────────

/**
 * Domain event emitted whenever a pricing calculation is performed.
 */
export interface PricingEvent {
    readonly eventId: string;
    readonly occurredAt: Date;
    readonly requestContext: InferenceRequestContext;
    readonly pricingResult: PricingResult;
}

/**
 * Observer interface – implemented by out-of-hexagon adapters.
 */
export interface PricingObserver {
    onPricingCalculated(event: PricingEvent): void | Promise<void>;
}

/**
 * Simple synchronous event bus for pricing events.
 * Can be replaced/extended with a proper pub-sub (Kafka, RabbitMQ, …) adapter.
 */
export class PricingEventBus {

    private readonly observers = new Set<PricingObserver>();

    subscribe(observer: PricingObserver): void {
        this.observers.add(observer);
    }

    unsubscribe(observer: PricingObserver): void {
        this.observers.delete(observer);
    }

    emit(event: PricingEvent): void {
        for (const obs of this.observers) {
            // Allow both sync & async observers
            try {
                const result = obs.onPricingCalculated(event);
                if (result instanceof Promise) {
                    // Detach promise; production code may add timeout/logging.
                    result.catch(err => console.error('PricingObserver failed:', err));
                }
            } catch (err) {
                console.error('PricingObserver threw:', err);
            }
        }
    }
}

//#endregion

//#region Pricing Engine (Domain Service) ─────────────────────────────────────────────────────────

/**
 * Domain service that orchestrates pricing strategies and event emission.
 */
export class PricingEngine {

    constructor(
        private readonly strategyFactory: PricingStrategyFactory,
        private readonly eventBus: PricingEventBus
    ) { }

    /**
     * Calculates the price for an inference request.  Emits PricingEvent to all observers.
     */
    public priceRequest(ctx: Omit<InferenceRequestContext, 'requestId' | 'timestamp'>): PricingResult {
        // Enrich context with guaranteed fields
        const fullCtx: InferenceRequestContext = {
            ...ctx,
            requestId: ctx.requestId ?? uuid(),
            timestamp: new Date()
        };

        // Acquire strategy
        const strategy = this.strategyFactory.getStrategyForUser(fullCtx.userId);

        // Calculate price with robust error handling
        let result: PricingResult;
        try {
            result = strategy.calculate(fullCtx);
        } catch (err) {
            // Enrich and re-throw
            throw new PricingEngineError(
                `Failed to calculate price for request '${fullCtx.requestId}'`,
                fullCtx,
                err as Error
            );
        }

        // Emit domain event
        const event: PricingEvent = {
            eventId: uuid(),
            occurredAt: new Date(),
            requestContext: fullCtx,
            pricingResult: result
        };
        this.eventBus.emit(event);

        return result;
    }
}

/**
 * Custom domain-level error type for troubleshooting.
 */
export class PricingEngineError extends Error {
    constructor(
        public readonly message: string,
        public readonly context: InferenceRequestContext,
        public readonly cause?: Error
    ) {
        super(message);
        this.name = 'PricingEngineError';
        if (cause) {
            // Node.js v16+ supports cause natively; keep fallback for older runtimes
            (this as any).cause = cause;
        }
    }
}

//#endregion

//#region Example In-Memory Config Provider ────────────────────────────────────────────────────────

/**
 * Basic in-memory implementation of BillingConfigProvider to keep hexagon runnable
 * without external persistence.  Test harnesses and demos can use this directly.
 */
export class InMemoryBillingConfigProvider implements BillingConfigProvider {

    private readonly db: Map<string, BillingConfig> = new Map();

    constructor(initialConfigs: BillingConfig[] = []) {
        for (const cfg of initialConfigs) {
            this.db.set(cfg.userId, cfg);
        }
    }

    getBillingConfig(userId: string): BillingConfig {
        const cfg = this.db.get(userId);
        if (!cfg) {
            throw new Error(`No BillingConfig found for user '${userId}'.`);
        }
        return cfg;
    }

    upsertConfig(cfg: BillingConfig): void {
        this.db.set(cfg.userId, cfg);
    }
}

//#endregion
```