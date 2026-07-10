```typescript
/*------------------------------------------------------------------------------
  InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
  File:        src/module_76.ts
  Description: Core-domain “Pricing Engine” (hexagon side) that determines the
               cost of an inference request based on the enterprise revenue
               strategy (usage-based, subscription, hybrid, etc.).  A strategy
               is selected via a factory and instruments an internal Event Bus
               so that downstream observers (billing adapter, BI dashboards,
               alerts) are notified whenever a price is computed.
------------------------------------------------------------------------------*/

import { EventEmitter } from 'events';

/* ============================================================================
 * Domain Primitives
 * ========================================================================= */

export type Currency = 'USD' | 'EUR' | 'GBP';

/**
 * Money — immutable value object
 */
export class Money {
  public readonly amount: number;
  public readonly currency: Currency;

  constructor(amount: number, currency: Currency = 'USD') {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`Money amount must be a non-negative finite number. Got: ${amount}`);
    }
    this.amount = Number(amount.toFixed(4)); // enforce max 4 decimals
    this.currency = currency;
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  public multiply(multiplier: number): Money {
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new Error(`Multiplier must be a non-negative finite number. Got: ${multiplier}`);
    }
    return new Money(this.amount * multiplier, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  public toString(): string {
    return `${this.currency} ${this.amount.toFixed(4)}`;
  }
}

/**
 * SLA levels supported by the platform.
 */
export enum SlaTier {
  BRONZE = 'BRONZE',   // best-effort latency, no replication
  SILVER = 'SILVER',   // p95 < 500ms, single-AZ replication
  GOLD = 'GOLD',       // p99 < 200ms, multi-AZ replication
  PLATINUM = 'PLATINUM'// dedicated infra, p99 < 50ms
}

/**
 * Information about a single inference request.
 */
export interface InferenceRequest {
  requestId: string;
  customerId: string;
  modelName: string;
  tokenCount: number;     // number of ML tokens or features processed
  slaTier: SlaTier;
  timestamp: Date;
}

/**
 * Price computation result.
 */
export interface PricingResult {
  requestId: string;
  customerId: string;
  modelName: string;
  slaTier: SlaTier;
  price: Money;
  strategyName: string;
  computedAt: Date;
}

/* ============================================================================
 * Revenue Strategy Interfaces
 * ========================================================================= */

/**
 * RevenueStrategy computes the price for a given inference request.
 * Concrete implementations encapsulate the revenue logic.
 */
export interface RevenueStrategy {
  readonly name: string;
  computePrice(request: InferenceRequest): Money;
}

/* ============================================================================
 * Concrete Revenue Strategies
 * ========================================================================= */

/**
 * SubscriptionPricing — flat monthly fee covers up to N tokens,
 * overage incurs per-token cost.
 */
export class SubscriptionPricing implements RevenueStrategy {
  public readonly name = 'SUBSCRIPTION';

  constructor(
    private readonly monthlyFee: Money,
    private readonly includedTokens: number,
    private readonly overagePer1KTokens: Money
  ) {}

  computePrice(request: InferenceRequest): Money {
    // NOTE: In reality, we would consult usage state (tokensUsedThisMonth),
    // but for deterministic unit testing we pass all info via the request.
    const { tokenCount } = request;

    if (tokenCount <= this.includedTokens) {
      return new Money(0, this.monthlyFee.currency); // covered by subscription
    }

    const overageTokens = tokenCount - this.includedTokens;
    const blocks = Math.ceil(overageTokens / 1000);
    return this.overagePer1KTokens.multiply(blocks);
  }
}

/**
 * UsageBasedPricing — pure pay-as-you-go.
 */
export class UsageBasedPricing implements RevenueStrategy {
  public readonly name = 'USAGE_BASED';

  constructor(
    private readonly pricePer1KTokens: Map<SlaTier, Money>
  ) {}

  computePrice(request: InferenceRequest): Money {
    const { tokenCount, slaTier } = request;
    const basePrice = this.pricePer1KTokens.get(slaTier);

    if (!basePrice) {
      throw new Error(`Pricing not configured for SLA tier ${slaTier}`);
    }

    const blocks = Math.ceil(tokenCount / 1000);
    return basePrice.multiply(blocks);
  }
}

/**
 * HybridPricing — subscription + usage for premium SLA only.
 */
export class HybridPricing implements RevenueStrategy {
  public readonly name = 'HYBRID';

  constructor(
    private readonly subscriptionStrategy: SubscriptionPricing,
    private readonly premiumUsageStrategy: UsageBasedPricing
  ) {}

  computePrice(request: InferenceRequest): Money {
    if (request.slaTier === SlaTier.PLATINUM) {
      return this.premiumUsageStrategy.computePrice(request);
    }
    return this.subscriptionStrategy.computePrice(request);
  }
}

/* ============================================================================
 * Factory for Revenue Strategies
 * ========================================================================= */

/**
 * Configuration object accepted by the factory.
 * All amounts are assumed to be in the same currency.
 */
export interface RevenueStrategyConfig {
  strategy: 'SUBSCRIPTION' | 'USAGE_BASED' | 'HYBRID';
  currency: Currency;
  /**
   * Below properties are optional and used depending on the strategy chosen.
   */
  subscription?: {
    monthlyFee: number;
    includedTokens: number;
    overagePer1KTokens: number;
  };
  usage?: {
    pricePer1KTokens: Record<SlaTier, number>;
  };
}

export class UnsupportedStrategyError extends Error {
  constructor(strategy: string) {
    super(`Unsupported revenue strategy: ${strategy}`);
  }
}

/**
 * RevenueStrategyFactory — produces concrete strategy instances.
 */
export class RevenueStrategyFactory {
  static create(config: RevenueStrategyConfig): RevenueStrategy {
    const { strategy, currency } = config;

    switch (strategy) {
      case 'SUBSCRIPTION': {
        if (!config.subscription) {
          throw new Error('Missing subscription config block.');
        }
        const { monthlyFee, includedTokens, overagePer1KTokens } =
          config.subscription;
        return new SubscriptionPricing(
          new Money(monthlyFee, currency),
          includedTokens,
          new Money(overagePer1KTokens, currency)
        );
      }

      case 'USAGE_BASED': {
        if (!config.usage) {
          throw new Error('Missing usage config block.');
        }
        const map = new Map<SlaTier, Money>();
        for (const tier of Object.values(SlaTier)) {
          const priceVal = config.usage.pricePer1KTokens[tier];
          if (priceVal === undefined) {
            throw new Error(`pricePer1KTokens.${tier} not defined`);
          }
          map.set(tier, new Money(priceVal, currency));
        }
        return new UsageBasedPricing(map);
      }

      case 'HYBRID': {
        if (!config.subscription || !config.usage) {
          throw new Error('Hybrid strategy requires both subscription and usage config.');
        }
        const sub = RevenueStrategyFactory.create({
          strategy: 'SUBSCRIPTION',
          currency,
          subscription: config.subscription
        }) as SubscriptionPricing;

        const usage = RevenueStrategyFactory.create({
          strategy: 'USAGE_BASED',
          currency,
          usage: config.usage
        }) as UsageBasedPricing;

        return new HybridPricing(sub, usage);
      }

      default:
        throw new UnsupportedStrategyError(strategy);
    }
  }
}

/* ============================================================================
 * Observer Pattern — internal event bus for pricing
 * ========================================================================= */

/**
 * Event payload for 'priceComputed' events.
 */
export interface PriceComputedEvent {
  readonly result: PricingResult;
}

/**
 * Internal singleton event bus for hexagon components only.
 * Adapters (e.g., KafkaPublisher, DashboardNotifier) may subscribe
 * via exposed Port interfaces, not directly.
 */
class PricingEventBus extends EventEmitter {
  private static INSTANCE: PricingEventBus;

  private constructor() {
    super();
  }

  static get instance(): PricingEventBus {
    if (!PricingEventBus.INSTANCE) {
      PricingEventBus.INSTANCE = new PricingEventBus();
    }
    return PricingEventBus.INSTANCE;
  }
}

/* ============================================================================
 * Pricing Engine — orchestrates strategy + event bus
 * ========================================================================= */

export class PricingEngine {
  private readonly strategy: RevenueStrategy;
  private readonly bus = PricingEventBus.instance;

  constructor(strategyConfig: RevenueStrategyConfig) {
    this.strategy = RevenueStrategyFactory.create(strategyConfig);
  }

  /**
   * Computes the price and emits an event.
   */
  public priceInference(request: InferenceRequest): PricingResult {
    this.assertValidRequest(request);

    const price = this.strategy.computePrice(request);
    const result: PricingResult = {
      requestId: request.requestId,
      customerId: request.customerId,
      modelName: request.modelName,
      slaTier: request.slaTier,
      price,
      strategyName: this.strategy.name,
      computedAt: new Date()
    };

    // Emit non-blocking; listeners log or push to external systems.
    this.bus.emit('priceComputed', { result } as PriceComputedEvent);

    return result;
  }

  /**
   * Allows other hexagon services to observe pricing events.
   */
  public onPriceComputed(listener: (event: PriceComputedEvent) => void): void {
    this.bus.on('priceComputed', listener);
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                */
  /* ---------------------------------------------------------------------- */

  private assertValidRequest(req: InferenceRequest): void {
    if (req.tokenCount <= 0) {
      throw new Error('InferenceRequest.tokenCount must be > 0');
    }
    if (!req.requestId || !req.customerId) {
      throw new Error('InferenceRequest must include requestId and customerId');
    }
  }
}

/* ============================================================================
 * Example Usage (would normally live in unit tests)
 * ========================================================================= */

if (process.env.NODE_ENV === 'test') {
  const config: RevenueStrategyConfig = {
    strategy: 'HYBRID',
    currency: 'USD',
    subscription: {
      monthlyFee: 1000,
      includedTokens: 1_000_000,
      overagePer1KTokens: 0.005
    },
    usage: {
      pricePer1KTokens: {
        BRONZE: 0.002,
        SILVER: 0.003,
        GOLD: 0.004,
        PLATINUM: 0.006
      }
    }
  };

  const engine = new PricingEngine(config);
  engine.onPriceComputed(({ result }) =>
    console.log(`[PricingEngine] ${result.requestId} → ${result.price}`)
  );

  engine.priceInference({
    requestId: 'req_123',
    customerId: 'cust_789',
    modelName: 'sentiment_v2',
    tokenCount: 12_345,
    slaTier: SlaTier.SILVER,
    timestamp: new Date()
  });
}
```