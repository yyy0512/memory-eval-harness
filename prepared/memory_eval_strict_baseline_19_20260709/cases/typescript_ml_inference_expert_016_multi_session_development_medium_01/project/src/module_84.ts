```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * Module 84: Inference Pricing Domain (Core Hexagon Layer)
 *
 * The code below models the business-critical rules that determine how much a
 * customer is charged whenever a model inference is executed.  Keeping with the
 * hexagonal philosophy, this module purposefully avoids any IO concerns
 * (databases, HTTP, message queues, etc.).  Instead it focusses on
 * domain-specific policies, exposing clean interfaces for adapters to call.
 *
 * Patterns in use:
 *  • Strategy Pattern  – Multiple interchangeable pricing algorithms
 *  • Factory Pattern   – Central place to obtain a concrete PricingStrategy
 *  • Observer Pattern  – Domain events emitted when a price is calculated
 *
 * No external runtime dependencies are introduced, ensuring portability and
 * testability.  Adapters (REST controllers, Kafka consumers, GraphQL resolvers,
 * etc.) may depend on this file, but not the other way around.
 */

/* ========================================================================== */
/*                                  Type Aliases                              */
/* ========================================================================== */

/**
 * Money representation kept intentionally lightweight.
 * In production we might use a dedicated money/decimal library.
 */
export interface Money {
  currency: string;      // ISO-4217 (e.g. "USD")
  amount: number;        // Minor units (e.g. cents) *not* floating point
}

/**
 * Minimal information required to determine a price for an inference request.
 * Additional metadata may be added without affecting existing strategies,
 * thanks to duck-typing.
 */
export interface InferenceRequestContext {
  modelName: string;
  modelVersion: string;
  predictionCount: number;          // Number of rows/records predicted
  latencyMs: number;               // pXX latency in milliseconds
  scheduled: boolean;              // true ⇢ batch; false ⇢ real-time
  customerTier: 'enterprise' | 'business' | 'startup';
  timestamp: Date;
}

/* ========================================================================== */
/*                              Observer / Events                             */
/* ========================================================================== */

/**
 * A lightweight, framework-agnostic event emitter.  We avoid Node's EventEmitter
 * so that the core can still be consumed by browser or edge-runtime adapters.
 */
export class DomainEventEmitter {
  private readonly listeners: Map<string, Array<(...args: unknown[]) => void>> =
    new Map();

  public on<T extends unknown[]>(event: string, handler: (...payload: T) => void): void {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(handler as (...args: unknown[]) => void);
    this.listeners.set(event, eventListeners);
  }

  public off<T extends unknown[]>(event: string, handler: (...payload: T) => void): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners) return;
    const idx = eventListeners.indexOf(handler as (...args: unknown[]) => void);
    if (idx >= 0) eventListeners.splice(idx, 1);
  }

  public emit<T extends unknown[]>(event: string, ...payload: T): void {
    const eventListeners = this.listeners.get(event);
    if (!eventListeners) return;
    eventListeners.forEach((fn) => {
      try {
        fn(...payload);
      } catch (err) {
        // Domain events must not crash pricing logic; swallow but log instead.
        /* eslint-disable no-console */
        console.error(`[DomainEventEmitter] Listener for "${event}" failed`, err);
      }
    });
  }
}

export interface PricingCalculatedEvent {
  ctx: InferenceRequestContext;
  price: Money;
  strategyId: string;
}

/* ========================================================================== */
/*                             Strategy Interfaces                             */
/* ========================================================================== */

export interface PricingStrategy {
  /**
   * A human-readable identifier.  Useful for audit trails and dashboards.
   */
  readonly id: string;

  /**
   * Calculate the price for the given inference request.
   * Implementations must be pure functions: no IO, logging, or randomization.
   */
  calculate(ctx: Readonly<InferenceRequestContext>): Money;
}

/* ========================================================================== */
/*                           Concrete Strategy Classes                        */
/* ========================================================================== */

/**
 * Simple usage-based pricing:
 * • Each prediction is charged at a fixed rate (per 1,000 predictions)
 * • Batch vs. real-time incurs different base prices
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly id = 'USAGE_BASED_V1';

  private readonly config = {
    basePricePerThousand: {
      batch: 30,       // $0.30 USD (30 cents)
      realtime: 50,    // $0.50 USD
    },
  };

  public calculate(ctx: Readonly<InferenceRequestContext>): Money {
    const pricePerThousand =
      ctx.scheduled
        ? this.config.basePricePerThousand.batch
        : this.config.basePricePerThousand.realtime;

    // Always round *up* to next thousand to avoid under-billing.
    const units = Math.ceil(ctx.predictionCount / 1_000);
    return {
      currency: 'USD',
      amount: pricePerThousand * units,
    };
  }
}

/**
 * Subscription pricing:
 * • A flat fee per request (could be zero) because customers already pay a
 *   subscription elsewhere.  This still enables charge-back accounting.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly id = 'SUBSCRIPTION_FLAT_V1';

  public calculate(_: Readonly<InferenceRequestContext>): Money {
    return {
      currency: 'USD',
      amount: 0,
    };
  }
}

/**
 * SLA-aware, tiered pricing:
 * • Faster latency ⇒ higher price
 * • Enterprise tier discounts
 * • Additional surcharge for real-time requests
 */
export class SlaAwareTieredPricingStrategy implements PricingStrategy {
  public readonly id = 'SLA_AWARE_TIERED_V2';

  private readonly latencyBandsMs = [
    { max: 50, multiplier: 2.0 },
    { max: 200, multiplier: 1.5 },
    { max: 1000, multiplier: 1.0 },
    { max: Infinity, multiplier: 0.7 },
  ] as const;

  private readonly basePricePerThousand = 40; // in cents

  private readonly tierDiscount: Record<InferenceRequestContext['customerTier'], number> = {
    enterprise: 0.8, // 20 % discount
    business: 1.0,
    startup: 1.2,    // 20 % surcharge
  };

  public calculate(ctx: Readonly<InferenceRequestContext>): Money {
    const latencyBand = this.latencyBandsMs.find((b) => ctx.latencyMs <= b.max)!;

    const realTimeSurcharge = ctx.scheduled ? 1.0 : 1.25;
    const discountFactor = this.tierDiscount[ctx.customerTier];

    const effectiveRate =
      this.basePricePerThousand *
      latencyBand.multiplier *
      realTimeSurcharge *
      discountFactor;

    const units = Math.ceil(ctx.predictionCount / 1_000);

    return {
      currency: 'USD',
      amount: Math.round(effectiveRate * units),
    };
  }
}

/* ========================================================================== */
/*                               Factory Pattern                              */
/* ========================================================================== */

export type PricingStrategyKind =
  | 'USAGE'
  | 'SUBSCRIPTION'
  | 'SLA_TIERED';

export class UnknownPricingStrategyError extends Error {
  public constructor(kind: string) {
    super(`Unknown pricing strategy kind "${kind}"`);
    this.name = 'UnknownPricingStrategyError';
  }
}

export class PricingStrategyFactory {
  /**
   * Return a concrete PricingStrategy.  The default implementation is a simple
   * switch; advanced scenarios could resolve from a DI container.
   */
  public static create(kind: PricingStrategyKind): PricingStrategy {
    switch (kind) {
      case 'USAGE':
        return new UsageBasedPricingStrategy();
      case 'SUBSCRIPTION':
        return new SubscriptionPricingStrategy();
      case 'SLA_TIERED':
        return new SlaAwareTieredPricingStrategy();
      default:
        throw new UnknownPricingStrategyError(kind);
    }
  }
}

/* ========================================================================== */
/*                               Domain Service                               */
/* ========================================================================== */

export class InferencePricingService {
  public constructor(
    private readonly eventBus: DomainEventEmitter = new DomainEventEmitter(),
  ) {}

  /**
   * Compute the price for a given inference request by delegating to a strategy
   * obtained via PricingStrategyFactory.  Emits a PricingCalculatedEvent on the
   * domain event bus upon success.
   *
   * Errors bubble up so that application-level services can decide whether to
   * retry, fallback, or abort.
   */
  public calculatePrice(
    strategyKind: PricingStrategyKind,
    ctx: InferenceRequestContext,
  ): Money {
    const strategy = PricingStrategyFactory.create(strategyKind);
    const price = strategy.calculate(ctx);

    // Emit observer event for audit trails and BI dashboards
    this.eventBus.emit<PricingCalculatedEvent>(
      'PricingCalculated',
      {
        ctx,
        price,
        strategyId: strategy.id,
      },
    );

    return price;
  }

  /**
   * Allows external adapters to subscribe to domain events
   * without depending on the internal event bus implementation.
   */
  public onPricingCalculated(
    handler: (evt: PricingCalculatedEvent) => void,
  ): () => void {
    this.eventBus.on('PricingCalculated', handler);
    // Return an unsubscribe function to keep caller code clean.
    return () => this.eventBus.off('PricingCalculated', handler);
  }
}

/* ========================================================================== */
/*                               Usage Example                                */
/* ========================================================================== */

/*
 * The following example shows how an adapter—say a REST controller—would call
 * into the domain service without any knowledge of the underlying strategy
 * implementation.
 *
 *     const service = new InferencePricingService();
 *
 *     service.onPricingCalculated((evt) => {
 *       auditLogger.info(evt);
 *     });
 *
 *     const price = service.calculatePrice('SLA_TIERED', {
 *       modelName: 'next-best-action',
 *       modelVersion: '2024-Q2-prod',
 *       predictionCount: 125_000,
 *       latencyMs: 85,
 *       scheduled: false,
 *       customerTier: 'enterprise',
 *       timestamp: new Date(),
 *     });
 *
 *     console.log(`Charge ${price.amount} ${price.currency} to customer`);
 *
 * Adapters handle IO (HTTP response, DB insert, Kafka publish),
 * while this module stays blissfully ignorant of the outside world.
 */
```