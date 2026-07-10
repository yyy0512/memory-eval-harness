```typescript
/**
 * InsightHexaAI
 * File: src/module_44.ts
 *
 * Domain-level “PricingEngine” service demonstrating a Strategy + Observer combo
 * within the hexagonal architecture.  The engine selects a RevenueStrategy at
 * run-time, computes per-inference cost, and publishes pricing events to any
 * interested adapters (e.g., BI dashboards, alerting systems, billing ledgers).
 *
 * NOTE:
 * • All types/interfaces imported from “@insighthexa/core” are expected to live
 *   in their respective domain or shared modules and are therefore *not*
 *   re-declared here.  Replace those imports with real paths in your monorepo.
 * • External dependency “uuid” is used for correlation IDs (npm i uuid).
 */

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Shared Types & Value Objects
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface InferenceRequest {
  readonly tenantId: string;
  readonly modelId: string;
  readonly inputs: number;          // How many rows / items sent for inference
  readonly slaTier: 'standard' | 'premium';
  readonly timestamp: Date;
}

export interface CostBreakdown {
  readonly tenantId: string;
  readonly inferenceId: string;     // Correlation / trace id
  readonly strategy: string;        // Strategy name
  readonly totalCost: number;
  readonly currency: Currency;
  readonly unitsConsumed: number;
  readonly details: Record<string, number>;
  readonly computedAt: Date;
}

export enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
}

/**
 * Domain-specific error to capture any pricing anomalies.
 */
export class PricingError extends Error {
  public readonly code: string;
  public readonly inferenceId?: string;

  constructor(message: string, code = 'PRICING_ERROR', inferenceId?: string) {
    super(message);
    this.code = code;
    this.inferenceId = inferenceId;
    Object.setPrototypeOf(this, PricingError.prototype);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Event System with Strong Typing
////////////////////////////////////////////////////////////////////////////////////////////////////

type PricingEventPayloads = {
  'pricing:computed': CostBreakdown;
  'pricing:error': PricingError;
};

class TypedEventEmitter<T extends Record<string, any>> extends EventEmitter {
  // Typed “on” listener
  public override on<K extends keyof T>(
    eventName: K,
    listener: (payload: T[K]) => void,
  ): this {
    return super.on(eventName as string, listener);
  }

  // Typed “emit”
  public emitTyped<K extends keyof T>(eventName: K, payload: T[K]): boolean {
    return super.emit(eventName as string, payload);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Revenue Strategy Pattern
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Strategy interface for computing per-inference cost.
 */
export interface RevenueStrategy {
  readonly name: string;
  computeCost(request: InferenceRequest): CostBreakdown;
}

/**
 * Usage-based strategy:
 * • Cost = inputs × rate
 * • Rate differs by SLA tier
 */
export class UsageBasedStrategy implements RevenueStrategy {
  public readonly name = 'usage_based';

  private readonly rateCard: Record<InferenceRequest['slaTier'], number> = {
    standard: 0.000_2, // $0.0002 per input
    premium: 0.000_5,
  };

  computeCost(request: InferenceRequest): CostBreakdown {
    const rate = this.rateCard[request.slaTier];
    const totalCost = request.inputs * rate;

    return {
      tenantId: request.tenantId,
      inferenceId: uuid(),
      strategy: this.name,
      totalCost,
      currency: Currency.USD,
      unitsConsumed: request.inputs,
      details: { rate },
      computedAt: new Date(),
    };
  }
}

/**
 * Subscription strategy:
 * • Fixed monthly fee amortized per request for reporting purposes
 * • Still tracks units consumed for analytics, but totalCost here is zero
 */
export class SubscriptionStrategy implements RevenueStrategy {
  public readonly name = 'subscription';

  computeCost(request: InferenceRequest): CostBreakdown {
    return {
      tenantId: request.tenantId,
      inferenceId: uuid(),
      strategy: this.name,
      totalCost: 0,
      currency: Currency.USD,
      unitsConsumed: request.inputs,
      details: {},
      computedAt: new Date(),
    };
  }
}

/**
 * Tiered strategy:
 * • First N inputs free, then usage-based afterward
 * • Example: 10k free inputs each month
 */
export class TieredStrategy implements RevenueStrategy {
  public readonly name = 'tiered';
  private static readonly FREE_TIER = 10_000;
  private static readonly RATE = 0.000_15;

  // Internal usage ledger (kept in-memory for demo; persist in production)
  private readonly monthlyUsage: Map<string, number> = new Map();

  computeCost(request: InferenceRequest): CostBreakdown {
    const key = `${request.tenantId}:${request.timestamp.getUTCFullYear()}-${request.timestamp.getUTCMonth()}`;
    const priorUsage = this.monthlyUsage.get(key) ?? 0;
    const projectedTotal = priorUsage + request.inputs;

    const billableUnits = Math.max(
      0,
      projectedTotal - TieredStrategy.FREE_TIER,
    );

    // Persist usage for subsequent calls
    this.monthlyUsage.set(key, projectedTotal);

    const totalCost = billableUnits * TieredStrategy.RATE;

    return {
      tenantId: request.tenantId,
      inferenceId: uuid(),
      strategy: this.name,
      totalCost,
      currency: Currency.USD,
      unitsConsumed: request.inputs,
      details: {
        freeTierRemaining: Math.max(
          0,
          TieredStrategy.FREE_TIER - priorUsage,
        ),
        billableUnits,
      },
      computedAt: new Date(),
    };
  }
}

/**
 * Factory for RevenueStrategy instantiation.
 * Decouples selection logic from consumers (hexagonal principle).
 */
export class RevenueStrategyFactory {
  static create(strategyKey: string): RevenueStrategy {
    switch (strategyKey) {
      case 'usage_based':
        return new UsageBasedStrategy();
      case 'subscription':
        return new SubscriptionStrategy();
      case 'tiered':
        return new TieredStrategy();
      default:
        throw new PricingError(`Unknown strategy "${strategyKey}"`, 'UNKNOWN_STRATEGY');
    }
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Pricing Engine (Domain Service) — Orchestrates strategy + eventing
////////////////////////////////////////////////////////////////////////////////////////////////////

export interface PricingEngineOptions {
  readonly strategyKey: string;
  readonly eventBus?: TypedEventEmitter<PricingEventPayloads>; // Optional external bus
}

export class PricingEngine {
  private readonly strategy: RevenueStrategy;
  private readonly events: TypedEventEmitter<PricingEventPayloads>;

  constructor(private readonly opts: PricingEngineOptions) {
    this.strategy = RevenueStrategyFactory.create(opts.strategyKey);
    // Reuse provided bus or create our own
    this.events =
      opts.eventBus ?? new TypedEventEmitter<PricingEventPayloads>();
  }

  /**
   * Computes cost for a given inference request and publishes result.
   */
  public compute(request: InferenceRequest): CostBreakdown {
    try {
      const breakdown = this.strategy.computeCost(request);
      this.events.emitTyped('pricing:computed', breakdown);
      return breakdown;
    } catch (err) {
      const pricingErr =
        err instanceof PricingError
          ? err
          : new PricingError((err as Error).message);

      pricingErr.inferenceId ??= uuid(); // Ensure ID for traceability
      this.events.emitTyped('pricing:error', pricingErr);
      throw pricingErr;
    }
  }

  /**
   * Allow external adapters to subscribe to pricing events.
   */
  public on<K extends keyof PricingEventPayloads>(
    event: K,
    listener: (payload: PricingEventPayloads[K]) => void,
  ): void {
    this.events.on(event, listener);
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Sample Observer Implementations (Adapters)
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Simple observer that logs pricing events; replace with real adapters
 * (e.g., Kafka producer, Snowflake loader, PowerBI push dataset, etc.).
 */
export class ConsoleBillingObserver {
  constructor(engine: PricingEngine) {
    engine.on('pricing:computed', this.handleComputed);
    engine.on('pricing:error', this.handleError);
  }

  private handleComputed = (breakdown: CostBreakdown): void => {
    /* eslint-disable no-console */
    console.info(
      `[BillingDashboard] Cost computed | tenant=${breakdown.tenantId} | ` +
        `cost=${breakdown.totalCost.toFixed(4)} ${breakdown.currency} | ` +
        `strategy=${breakdown.strategy}`,
    );
    /* eslint-enable no-console */
  };

  private handleError = (err: PricingError): void => {
    /* eslint-disable no-console */
    console.error(
      `[BillingDashboard] Pricing error | code=${err.code} | msg=${err.message}`,
    );
    /* eslint-enable no-console */
  };
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Usage Example (would sit in an adapter/controller)
////////////////////////////////////////////////////////////////////////////////////////////////////

// The following block is strictly for illustration and should be deleted
// or moved to an integration test in real codebases.

if (process.env.NODE_ENV === 'development') {
  const engine = new PricingEngine({ strategyKey: 'tiered' });
  // Attach console observer
  // eslint-disable-next-line no-new
  new ConsoleBillingObserver(engine);

  const fakeRequest: InferenceRequest = {
    tenantId: 'acme-corp',
    modelId: 'clv-forecast:v7',
    inputs: 2_500,
    slaTier: 'standard',
    timestamp: new Date(),
  };

  engine.compute(fakeRequest);
}
```