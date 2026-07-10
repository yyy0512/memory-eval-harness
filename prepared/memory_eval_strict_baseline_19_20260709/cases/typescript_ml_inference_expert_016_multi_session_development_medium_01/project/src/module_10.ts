```typescript
/**************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 *  FILE:           src/module_10.ts
 *  RESPONSIBILITY: Core-domain implementation of SLA-aware inference pricing.
 *
 *  Architectural notes
 *  -------------------
 *  • Hexagonal Architecture (Ports & Adapters): The code below lives *inside* the hexagon; no
 *    external dependencies are touched directly (databases, queues, http, …).
 *  • Strategy Pattern: Multiple PricingStrategy implementations can be swapped at runtime.
 *  • Factory Pattern: PricingStrategyFactory instantiates the correct strategy based on
 *    configuration delivered from outside the hexagon (e.g., YAML, env-vars, feature flag).
 *  • Observer Pattern (mini-impl): KPIEventBus notifies interested observers whenever a price is
 *    decided. (Adapters for logging, APM, billing-ledger live **outside** the hexagon.)
 *
 *  All numbers/logic are purely illustrative but representative for real-world codebases.
 **************************************************************************************************/

import { EventEmitter } from 'events';

/* ----------------------------------------------------------------------------
 * Domain types
 * ------------------------------------------------------------------------- */

/**
 * Context information used by a PricingStrategy to determine the final price
 * to be charged for a single inference request.
 */
export interface PricingContext {
  /** Unique identifier for the tenant/company owning the request. */
  readonly tenantId: string;

  /** The model that served the request (e.g. “churn_v2.4”). */
  readonly modelName: string;

  /** Total wall-clock time taken (ms) – includes pre/post-processing. */
  readonly latencyMs: number;

  /** How many vCPU-seconds were billed by the execution backend. */
  readonly computeSeconds: number;

  /** Optional: number of tokens or records processed. */
  readonly unitsProcessed?: number;

  /** Optional SLA tier, used by certain strategies for discounts/penalties. */
  readonly slaTier?: 'gold' | 'silver' | 'bronze';
}

/**
 * When a final price has been computed we propagate an event
 * so observers (e.g. billing service, APM dashboards) can react.
 */
export interface PriceDecidedEvent {
  readonly tenantId: string;
  readonly modelName: string;
  readonly priceCents: number;
  readonly strategyType: PricingStrategyType;
  readonly contextSnapshot: PricingContext;
  readonly timestamp: Date;
}

/* ----------------------------------------------------------------------------
 * Strategy Pattern
 * ------------------------------------------------------------------------- */

/** Known, first-class strategy identifiers */
export enum PricingStrategyType {
  USAGE_BASED = 'USAGE_BASED',
  SUBSCRIPTION = 'SUBSCRIPTION',
  TIERED = 'TIERED'
}

/** Interface every pricing strategy must adhere to. */
export interface PricingStrategy {
  readonly type: PricingStrategyType;

  /**
   * Calculate the final price in **cents** for a given inference context.
   * Implementations MUST be side-effect free – no DB writes, no network.
   */
  calculatePrice(context: PricingContext): number;
}

/* ----------------------------------------------------------------------------
 * Concrete strategy implementations
 * ------------------------------------------------------------------------- */

/**
 * Simple “pay for what you use” strategy.
 *   -  $0.0004  per vCPU-second
 *   -  $0.00001 per token/row   (first 1k free)
 *   -  2x multiplier if latency > 95th percentile target (hard-coded 500ms)
 */
class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly type = PricingStrategyType.USAGE_BASED;

  private static readonly PRICE_PER_CPU_SECOND_CENTS = 0.04;   // $0.0004
  private static readonly PRICE_PER_UNIT_CENTS = 0.001;        // $0.00001
  private static readonly UNITS_FREE_TIER = 1000;
  private static readonly LATENCY_PENALTY_THRESHOLD_MS = 500;
  private static readonly LATENCY_PENALTY_MULTIPLIER = 2;

  calculatePrice({ latencyMs, computeSeconds, unitsProcessed = 0 }: PricingContext): number {
    let cents =
      computeSeconds * UsageBasedPricingStrategy.PRICE_PER_CPU_SECOND_CENTS +
      Math.max(0, unitsProcessed - UsageBasedPricingStrategy.UNITS_FREE_TIER) *
        UsageBasedPricingStrategy.PRICE_PER_UNIT_CENTS;

    if (latencyMs > UsageBasedPricingStrategy.LATENCY_PENALTY_THRESHOLD_MS) {
      cents *= UsageBasedPricingStrategy.LATENCY_PENALTY_MULTIPLIER;
    }

    // Round to 2 decimals (cents), using bankers-rounding for fairness.
    return Math.round(cents);
  }
}

/**
 * Flat subscription fee – every inference is “free” until customer exceeds
 * allocation; after that we charge overage using UsageBasedPricingStrategy.
 */
class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly type = PricingStrategyType.SUBSCRIPTION;

  constructor(
    private readonly monthlyFlatCents: number,
    private readonly includedCpuSeconds: number,
    private readonly includedUnits: number
  ) {}

  private readonly usageBasedDelegate = new UsageBasedPricingStrategy();

  calculatePrice(context: PricingContext): number {
    // “subscription fee” is handled elsewhere (e.g. monthly billing cron);
    // only compute *overage* in realtime.
    const { computeSeconds, unitsProcessed = 0 } = context;

    if (computeSeconds <= this.includedCpuSeconds && unitsProcessed <= this.includedUnits) {
      return 0;
    }

    return this.usageBasedDelegate.calculatePrice(context);
  }
}

/**
 * Tiered pricing: price per unit decreases as consumption grows.
 * Modelled as piece-wise constant marginal cost curve.
 */
class TieredPricingStrategy implements PricingStrategy {
  public readonly type = PricingStrategyType.TIERED;

  /**
   * tiers must be **sorted ascending** by threshold.
   * Example:
   *   [
   *     { threshold: 0,     pricePerUnitCents: 1.0 },
   *     { threshold: 10000, pricePerUnitCents: 0.8 },
   *     { threshold: 50000, pricePerUnitCents: 0.6 }
   *   ]
   */
  constructor(
    private readonly tiers: Array<{ threshold: number; pricePerUnitCents: number }>
  ) {
    if (tiers.length === 0) {
      throw new Error('TieredPricingStrategy requires at least one tier definition.');
    }
  }

  calculatePrice({ unitsProcessed = 0 }: PricingContext): number {
    let totalCents = 0;
    let remainingUnits = unitsProcessed;

    // Walk tiers from highest threshold downwards for efficiency.
    for (let i = this.tiers.length - 1; i >= 0; i--) {
      const { threshold, pricePerUnitCents } = this.tiers[i];
      if (remainingUnits > threshold) {
        const billable = remainingUnits - threshold;
        totalCents += billable * pricePerUnitCents;
        remainingUnits = threshold;
      }
    }

    return Math.round(totalCents);
  }
}

/* ----------------------------------------------------------------------------
 * Factory Pattern
 * ------------------------------------------------------------------------- */

export type PricingStrategyConfig =
  | {
      type: PricingStrategyType.USAGE_BASED;
    }
  | {
      type: PricingStrategyType.SUBSCRIPTION;
      monthlyFlatCents: number;
      includedCpuSeconds: number;
      includedUnits: number;
    }
  | {
      type: PricingStrategyType.TIERED;
      tiers: Array<{ threshold: number; pricePerUnitCents: number }>;
    };

/**
 * Responsible for constructing the proper PricingStrategy implementation.
 * All configuration is considered immutable after instantiation.
 */
export class PricingStrategyFactory {
  /**
   * @throws {Error} if config is invalid or unsupported.
   */
  public static create(config: PricingStrategyConfig): PricingStrategy {
    switch (config.type) {
      case PricingStrategyType.USAGE_BASED:
        return new UsageBasedPricingStrategy();

      case PricingStrategyType.SUBSCRIPTION:
        return new SubscriptionPricingStrategy(
          config.monthlyFlatCents,
          config.includedCpuSeconds,
          config.includedUnits
        );

      case PricingStrategyType.TIERED:
        return new TieredPricingStrategy(config.tiers);

      /* c8 ignore next 2 */
      default:
        throw new Error(
          `Unsupported PricingStrategyType: ${(config as PricingStrategyConfig).type}`
        );
    }
  }
}

/* ----------------------------------------------------------------------------
 * Observer Pattern (lightweight)
 * ------------------------------------------------------------------------- */

class KPIEventBus extends EventEmitter {
  private static _instance: KPIEventBus | null = null;

  private constructor() {
    super();
  }

  /** Singleton – ensures in-process fan-out is consistent. */
  public static get instance(): KPIEventBus {
    if (!this._instance) {
      this._instance = new KPIEventBus();
    }
    return this._instance;
  }
}

/* ----------------------------------------------------------------------------
 * Application-level façade
 * ------------------------------------------------------------------------- */

/**
 * PricingEngine exposes a concise API to the outside world (application layer).
 * Adapters (REST controllers, gRPC servers, Kafka consumers, …) call this code
 * to compute prices while keeping the domain isolated from IO concerns.
 */
export class PricingEngine {
  constructor(private readonly strategy: PricingStrategy) {}

  /**
   * Calculate price and emit “price_decided” event.
   *
   * Consumers are **encouraged** to handle errors but we guarantee that no
   * pricing strategy shall ever throw; worst case is returning 0.
   */
  public decidePrice(context: PricingContext): number {
    let cents = 0;
    try {
      cents = this.strategy.calculatePrice({ ...context });
    } catch (err) {
      /* c8 ignore start */
      // Defensive coding: never escalate pricing failures to users;
      // instead log (outside hexagon) and default to zero cost.
      console.error('PricingEngine.calculatePrice failed:', err);
      cents = 0;
      /* c8 ignore end */
    }

    // Emit event for observers (billing adaptors, dashboards, …)
    KPIEventBus.instance.emit('price_decided', <PriceDecidedEvent>{
      tenantId: context.tenantId,
      modelName: context.modelName,
      priceCents: cents,
      strategyType: this.strategy.type,
      contextSnapshot: context,
      timestamp: new Date()
    });

    return cents;
  }

  /**
   * Register an in-process observer for price_decided events.
   * Example usage:
   *   pricingEngine.onPriceDecided(evt => ledger.enqueue(evt))
   */
  public onPriceDecided(handler: (evt: PriceDecidedEvent) => void): void {
    KPIEventBus.instance.on('price_decided', handler);
  }
}

/* ----------------------------------------------------------------------------
 * Example: default strategy wiring (would normally be done in DI container)
 * ------------------------------------------------------------------------- */

const defaultStrategy = PricingStrategyFactory.create({
  type: PricingStrategyType.USAGE_BASED
});

export const DefaultPricingEngine = new PricingEngine(defaultStrategy);

/* -------------------------------------------------------------------------------------------------
 * End of file
 * ------------------------------------------------------------------------------------------------ */
```