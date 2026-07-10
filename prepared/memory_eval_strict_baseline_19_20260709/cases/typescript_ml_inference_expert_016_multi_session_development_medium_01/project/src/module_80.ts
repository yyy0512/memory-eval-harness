```typescript
/***************************************************************************************************
 * File:        src/module_80.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Core-domain “SLA-aware inference pricing” implementation.
 *
 *              • Implements the Strategy Pattern to calculate pay-per-inference costs based on
 *                SLA, usage volume, and optional subscription tiers.
 *              • Provides a Factory for wiring strategies at runtime from configuration or A/B
 *                experiments.
 *              • Publishes Domain Events (Observer Pattern) so that other bounded contexts
 *                (billing, finance dashboards, anomaly detection, etc.) can react without
 *                tight-coupling.
 *
 * NOTE:        All code in this file lives **inside** the business-logic hexagon; no IO concerns
 *              (DB writes, HTTP handlers, Kafka producers, etc.) are addressed here.
 ***************************************************************************************************/

import { randomUUID } from 'crypto';

/**
 * -----------------------------------------------------------------------------------------------
 * Shared kernel: Logger abstraction
 * -----------------------------------------------------------------------------------------------
 * The actual implementation (e.g. Pino, Winston, Datadog) will be injected by adapters.
 */
export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * -----------------------------------------------------------------------------------------------
 * Observer Pattern — lightweight domain event bus
 * -----------------------------------------------------------------------------------------------
 */

export interface IDomainEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly type: string;
}

export type DomainEventHandler<T extends IDomainEvent> = (event: T) => void;

export class EventBus {
  private handlers: Map<string, DomainEventHandler<IDomainEvent>[]> = new Map();

  public publish<T extends IDomainEvent>(event: T): void {
    const subscribers = this.handlers.get(event.type) ?? [];
    subscribers.forEach((h) => {
      try {
        h(event);
      } catch (err) {
        /* eslint-disable no-console */
        console.error(
          `[DomainEventBus] handler failure for event ${event.type}: ${(err as Error).message}`
        );
        /* eslint-enable no-console */
      }
    });
  }

  public subscribe<T extends IDomainEvent>(type: string, handler: DomainEventHandler<T>): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler as DomainEventHandler<IDomainEvent>);
    this.handlers.set(type, existing);
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * Domain types & enums
 * -----------------------------------------------------------------------------------------------
 */

export enum SlaTier {
  PLATINUM = 'PLATINUM',
  GOLD = 'GOLD',
  SILVER = 'SILVER',
  BRONZE = 'BRONZE',
}

export interface PricingContext {
  readonly tenantId: string;
  readonly usageCount: number; // number of inferences in current billing window
  readonly slaTier: SlaTier;
  readonly modelComplexityFactor: number; // 1 = baseline, 2 = twice as expensive
  readonly subscriptionMonthlyFee?: number; // if undefined, tenant is usage-based only
}

/**
 * -----------------------------------------------------------------------------------------------
 * Strategy Pattern — pricing algorithm contract
 * -----------------------------------------------------------------------------------------------
 */

export interface IInferencePricingStrategy {
  /**
   * Calculates the price (in USD) for a batch of inferences under the provided context.
   * Must never return a negative value.
   */
  calculatePrice(ctx: PricingContext): number;
}

/**
 * -----------------------------------------------------------------------------------------------
 * Concrete Strategies
 * -----------------------------------------------------------------------------------------------
 */

/**
 * Pure usage-based pricing. Each inference costs a base price multiplied by SLA & model factors.
 */
export class UsageBasedPricingStrategy implements IInferencePricingStrategy {
  /**
   * Baseline cost for ONE inference under SILVER tier & complexity factor=1
   */
  private static readonly BASE_PRICE_USD = 0.0002;

  /**
   * SLA multipliers
   */
  private static readonly SLA_MULTIPLIERS: Record<SlaTier, number> = {
    [SlaTier.PLATINUM]: 2.0,
    [SlaTier.GOLD]: 1.5,
    [SlaTier.SILVER]: 1.0,
    [SlaTier.BRONZE]: 0.8,
  };

  public calculatePrice(ctx: PricingContext): number {
    if (ctx.usageCount < 0) {
      throw new Error('Usage count cannot be negative');
    }
    const slaMultiplier = UsageBasedPricingStrategy.SLA_MULTIPLIERS[ctx.slaTier] ?? 1.0;
    const unitPrice =
      UsageBasedPricingStrategy.BASE_PRICE_USD *
      slaMultiplier *
      Math.max(1, ctx.modelComplexityFactor);

    return +(unitPrice * ctx.usageCount).toFixed(6);
  }
}

/**
 * Pure subscription pricing. Usage is “free” up to a Fair-Use threshold; overage is penalized.
 */
export class SubscriptionPricingStrategy implements IInferencePricingStrategy {
  private static readonly FAIR_USE_LIMIT = 1_000_000; // inferences per month
  private static readonly OVERAGE_UNIT_COST = 0.00015; // USD

  public calculatePrice(ctx: PricingContext): number {
    if (!ctx.subscriptionMonthlyFee || ctx.subscriptionMonthlyFee <= 0) {
      throw new Error('Subscription fee must be specified and positive for subscription pricing');
    }

    if (ctx.usageCount <= SubscriptionPricingStrategy.FAIR_USE_LIMIT) {
      return 0; // included in subscription
    }

    const overage = ctx.usageCount - SubscriptionPricingStrategy.FAIR_USE_LIMIT;
    const overageCost =
      overage *
      SubscriptionPricingStrategy.OVERAGE_UNIT_COST *
      Math.max(1, ctx.modelComplexityFactor);

    return +overageCost.toFixed(6);
  }
}

/**
 * Hybrid pricing. Customers pay a monthly fee for a discounted per-usage price.
 */
export class HybridPricingStrategy implements IInferencePricingStrategy {
  private static readonly DISCOUNTED_USAGE_PRICE = 0.0001; // USD

  public calculatePrice(ctx: PricingContext): number {
    if (!ctx.subscriptionMonthlyFee || ctx.subscriptionMonthlyFee <= 0) {
      throw new Error('Subscription fee must be specified and positive for hybrid pricing');
    }

    const usageCost =
      ctx.usageCount *
      HybridPricingStrategy.DISCOUNTED_USAGE_PRICE *
      Math.max(1, ctx.modelComplexityFactor);

    return +(usageCost.toFixed(6));
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * Factory Pattern — resolve strategy at runtime
 * -----------------------------------------------------------------------------------------------
 */

export enum PricingStrategyType {
  USAGE_BASED = 'USAGE_BASED',
  SUBSCRIPTION = 'SUBSCRIPTION',
  HYBRID = 'HYBRID',
}

export class PricingStrategyFactory {
  public static create(
    type: PricingStrategyType,
    logger?: ILogger
  ): IInferencePricingStrategy {
    switch (type) {
      case PricingStrategyType.USAGE_BASED:
        logger?.debug('Using UsageBasedPricingStrategy');
        return new UsageBasedPricingStrategy();
      case PricingStrategyType.SUBSCRIPTION:
        logger?.debug('Using SubscriptionPricingStrategy');
        return new SubscriptionPricingStrategy();
      case PricingStrategyType.HYBRID:
        logger?.debug('Using HybridPricingStrategy');
        return new HybridPricingStrategy();
      default:
        logger?.error(`Unsupported pricing strategy: ${type}`);
        throw new Error(`Unsupported pricing strategy: ${type}`);
    }
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * Domain Events
 * -----------------------------------------------------------------------------------------------
 */

export interface BillingCalculatedEvent extends IDomainEvent {
  readonly tenantId: string;
  readonly strategy: PricingStrategyType;
  readonly totalPriceUsd: number;
  readonly usageCount: number;
  readonly slaTier: SlaTier;
  readonly modelComplexityFactor: number;
}

/**
 * -----------------------------------------------------------------------------------------------
 * Domain Service — InferencePricingService
 * -----------------------------------------------------------------------------------------------
 */

export class InferencePricingService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: ILogger,
    private strategy: IInferencePricingStrategy
  ) {}

  /**
   * Swap pricing strategy at runtime (useful for experiments or admin overrides).
   */
  public setStrategy(strategy: IInferencePricingStrategy): void {
    this.logger.info('Switching inference pricing strategy', {
      oldStrategy: this.strategy.constructor.name,
      newStrategy: strategy.constructor.name,
    });
    this.strategy = strategy;
  }

  /**
   * Calculates the price and emits a BillingCalculatedEvent for observers.
   */
  public calculateBilling(ctx: PricingContext): number {
    try {
      const price = this.strategy.calculatePrice(ctx);
      const event: BillingCalculatedEvent = {
        id: randomUUID(),
        occurredAt: new Date(),
        type: 'BillingCalculated',
        tenantId: ctx.tenantId,
        strategy: this.getStrategyType(),
        totalPriceUsd: price,
        usageCount: ctx.usageCount,
        slaTier: ctx.slaTier,
        modelComplexityFactor: ctx.modelComplexityFactor,
      };

      this.logger.info('Billing calculated', { tenantId: ctx.tenantId, priceUsd: price });
      this.eventBus.publish(event);

      return price;
    } catch (err) {
      this.logger.error('Failed to calculate billing', {
        tenantId: ctx.tenantId,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * Helper to resolve enum from strategy instance.
   */
  private getStrategyType(): PricingStrategyType {
    if (this.strategy instanceof UsageBasedPricingStrategy) return PricingStrategyType.USAGE_BASED;
    if (this.strategy instanceof SubscriptionPricingStrategy) return PricingStrategyType.SUBSCRIPTION;
    if (this.strategy instanceof HybridPricingStrategy) return PricingStrategyType.HYBRID;
    // Fallback for custom strategies that might be injected in the future
    return PricingStrategyType.USAGE_BASED;
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * Example usage (inside hexagon). Remove or adapt in production.
 * -----------------------------------------------------------------------------------------------
 */

// const logger: ILogger = console as unknown as ILogger; // Adapter will provide a real logger
// const bus = new EventBus();
// bus.subscribe<BillingCalculatedEvent>('BillingCalculated', (e) =>
//   logger.info(`Observed billing event: $${e.totalPriceUsd} for ${e.tenantId}`)
// );
// const pricingService = new InferencePricingService(
//   bus,
//   logger,
//   PricingStrategyFactory.create(PricingStrategyType.USAGE_BASED, logger)
// );
// const price = pricingService.calculateBilling({
//   tenantId: 'acme-corp',
//   usageCount: 250_000,
//   slaTier: SlaTier.GOLD,
//   modelComplexityFactor: 1.2,
// });
// console.log(price);
```