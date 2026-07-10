```typescript
/**********************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * --------------------------------------------------------------------------------------------
 * File:        src/module_71.ts
 * Module:      Pricing Engine (hexagon/core domain service)
 * Pattern(s):  Strategy Pattern, Factory Pattern, Observer Pattern
 *
 * Description:
 *   SLA-aware, inference-level pricing engine.  Calculates the cost of every prediction
 *   request while remaining pluggable: product managers can introduce new monetisation
 *   schemes (usage-based, subscription, tiered-SLA, revenue-share, etc.) without touching
 *   IO adapters or other business logic.
 *
 *   The engine:
 *     1. Receives an InferenceRequestContext (immutable value object).
 *     2. Delegates cost computation to a PricingStrategy selected by PricingStrategyFactory.
 *     3. Emits a domain event (PricingCalculatedEvent) to downstream observers
 *        (billing pipeline, dashboards, alerts, etc.).
 *
 *   100 % side-effect-free except for the event emission, which is handled through a
 *   lightweight, strongly-typed EventEmitter adapter that lives inside the hexagon.
 *********************************************************************************************/

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------------------------------
 * Section 1. Shared Types & Interfaces
 * ---------------------------------------------------------------------------------------------- */

/**
 * Immutable context passed to every strategy implementation.
 */
export interface InferenceRequestContext {
  readonly requestId: string;
  readonly modelId: string;
  readonly tenantId: string;
  readonly timestamp: Date;
  readonly latencyMs: number;            // End-to-end processing time.
  readonly payloadBytes: number;         // Size of request + response.
  readonly userTier: 'free' | 'silver' | 'gold' | 'enterprise';
  readonly metadata?: Record<string, unknown>; // Arbitrary extras (A/B flag, region, etc.).
}

/**
 * Outcome of a pricing calculation.
 */
export interface PriceQuote {
  readonly requestId: string;
  readonly amountCents: number;
  readonly currency: 'USD' | 'EUR' | 'GBP';
  readonly strategyId: string;
  readonly calculatedAt: Date;
}

/**
 * Contract for any pricing strategy.
 */
export interface PricingStrategy {
  readonly id: string;
  calculate(ctx: InferenceRequestContext): PriceQuote;
}

/* -------------------------------------------------------------------------------------------------
 * Section 2. Concrete Strategy Implementations
 * ---------------------------------------------------------------------------------------------- */

/**
 * Simple pay-per-request model with fixed cost.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly id = 'usage_based_v1';

  constructor(private readonly pricePerRequestCents: number) {
    if (pricePerRequestCents < 0) {
      throw new Error('pricePerRequestCents must be >= 0');
    }
  }

  calculate(ctx: InferenceRequestContext): PriceQuote {
    return {
      requestId: ctx.requestId,
      amountCents: this.pricePerRequestCents,
      currency: 'USD',
      strategyId: this.id,
      calculatedAt: new Date(),
    };
  }
}

/**
 * Tier-aware SLA pricing. Higher tiers pay more but receive latency credits.
 */
export class TieredSlaPricingStrategy implements PricingStrategy {
  public readonly id = 'tiered_sla_v2';

  private static readonly BASE_PRICE = 5; // 5¢ base.

  calculate(ctx: InferenceRequestContext): PriceQuote {
    const tierMultiplier: Record<InferenceRequestContext['userTier'], number> = {
      free: 1.0,
      silver: 0.9,
      gold: 0.7,
      enterprise: 0.5,
    };

    const latencyPenaltyCents =
      ctx.latencyMs > 800 ? 0 : (-0.5 * (800 - ctx.latencyMs)) / 100; // Credit for <800 ms.

    const amount =
      TieredSlaPricingStrategy.BASE_PRICE * tierMultiplier[ctx.userTier] +
      latencyPenaltyCents;

    return {
      requestId: ctx.requestId,
      amountCents: Math.max(0, Math.round(amount)),
      currency: 'USD',
      strategyId: this.id,
      calculatedAt: new Date(),
    };
  }
}

/**
 * Annual subscription – zero marginal cost for requests unless SLA is violated.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly id = 'subscription_v1';

  constructor(private readonly slaThresholdMs = 1000) {}

  calculate(ctx: InferenceRequestContext): PriceQuote {
    const isSlaBreached = ctx.latencyMs > this.slaThresholdMs;
    const penalty = isSlaBreached
      ? Math.round((ctx.latencyMs - this.slaThresholdMs) / 10) // 0.1¢ per ms above SLA.
      : 0;

    return {
      requestId: ctx.requestId,
      amountCents: penalty,
      currency: 'USD',
      strategyId: this.id,
      calculatedAt: new Date(),
    };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Section 3. Strategy Factory
 * ---------------------------------------------------------------------------------------------- */

export type StrategyConfig =
  | { type: 'usage'; pricePerRequestCents: number }
  | { type: 'tiered' }
  | { type: 'subscription'; slaThresholdMs?: number };

/**
 * Factory responsible for instantiating the correct strategy from runtime config.
 */
export class PricingStrategyFactory {
  static create(cfg: StrategyConfig): PricingStrategy {
    switch (cfg.type) {
      case 'usage':
        return new UsageBasedPricingStrategy(cfg.pricePerRequestCents);
      case 'tiered':
        return new TieredSlaPricingStrategy();
      case 'subscription':
        return new SubscriptionPricingStrategy(cfg.slaThresholdMs);
      default: {
        // Typescript's exhaustiveness check would typically prevent this branch,
        // but we keep a runtime check for defensive programming.
        /* istanbul ignore next */
        throw new Error(`Unsupported pricing strategy type: ${(cfg as any).type}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Section 4. Domain Events & Observer Pattern
 * ---------------------------------------------------------------------------------------------- */

/**
 * Domain event emitted after every successful price calculation.
 */
export interface PricingCalculatedEvent {
  readonly quote: PriceQuote;
  readonly context: InferenceRequestContext;
}

/**
 * Strongly-typed event names for the PricingEngineEmitter.
 */
type PricingEngineEvents = {
  'pricing.calculated': (event: PricingCalculatedEvent) => void;
  error: (err: unknown) => void;
};

/**
 * Typed wrapper around Node's EventEmitter to enforce compile-time safety.
 */
class TypedEventEmitter<T extends Record<string, (...args: any[]) => void>>
  extends EventEmitter {
  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean {
    return super.emit(event as string, ...args);
  }

  on<K extends keyof T>(event: K, listener: T[K]): this {
    return super.on(event as string, listener as (...args: any[]) => void);
  }

  off<K extends keyof T>(event: K, listener: T[K]): this {
    return super.off(event as string, listener as (...args: any[]) => void);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Section 5. Pricing Engine (Domain Service)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Core service used by inference adapters to obtain per-request pricing.
 */
export class PricingEngine {
  private readonly emitter = new TypedEventEmitter<PricingEngineEvents>();

  constructor(private strategy: PricingStrategy) {}

  /**
   * Dynamically update the strategy without reinstantiating the engine.
   * Emits no event – caller is responsible for broadcasting changes if required.
   */
  public setStrategy(strategy: PricingStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Subscribe to pricing events.
   */
  public on<K extends keyof PricingEngineEvents>(
    event: K,
    listener: PricingEngineEvents[K]
  ): this {
    this.emitter.on(event, listener);
    return this;
  }

  /**
   * Calculate price and emit domain event. Exceptions are forwarded to observers
   * via 'error' event to decouple error handling.
   */
  public quote(ctx: InferenceRequestContext): PriceQuote {
    try {
      const quote = this.strategy.calculate(ctx);

      this.emitter.emit('pricing.calculated', { quote, context: ctx });
      return quote;
    } catch (err) {
      this.emitter.emit('error', err);
      // Re-throw to ensure upstream caller can handle it too.
      throw err;
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Section 6. Convenience Builder
 * ---------------------------------------------------------------------------------------------- */

/**
 * Helper to wire everything together from a plain JS object.
 */
export function buildDefaultPricingEngine(
  config: StrategyConfig,
  observers: Partial<PricingEngineEvents> = {}
): PricingEngine {
  const strategy = PricingStrategyFactory.create(config);
  const engine = new PricingEngine(strategy);

  if (observers['pricing.calculated']) {
    engine.on('pricing.calculated', observers['pricing.calculated']);
  }
  if (observers.error) {
    engine.on('error', observers.error);
  }
  return engine;
}

/* -------------------------------------------------------------------------------------------------
 * Section 7. Example Usage (Remove in production but kept here for clarity)
 * ---------------------------------------------------------------------------------------------- */
// The following block is wrapped in an `if (require.main === module)` guard to
// avoid side effects when imported as a library – useful for quick, manual tests.

if (require.main === module) {
  // eslint-disable-next-line no-console
  console.log('[PricingEngine] Running manual sanity check…');

  const engine = buildDefaultPricingEngine(
    { type: 'tiered' },
    {
      'pricing.calculated': (e) =>
        // eslint-disable-next-line no-console
        console.log('Price quote generated:', e.quote),
      error: (err) => console.error('Pricing engine error:', err),
    }
  );

  const ctx: InferenceRequestContext = {
    requestId: 'req_123',
    modelId: 'mdl_abc',
    tenantId: 'tenant_demo',
    timestamp: new Date(),
    latencyMs: 670,
    payloadBytes: 1024,
    userTier: 'gold',
  };

  engine.quote(ctx);
}
```