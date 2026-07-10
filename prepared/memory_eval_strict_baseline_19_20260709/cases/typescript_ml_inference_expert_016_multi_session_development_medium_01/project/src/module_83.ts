```typescript
/**************************************************************************************************
 * File:        src/module_83.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Core domain module responsible for SLA-aware inference pricing. Uses
 *              Strategy, Factory, and Observer patterns to allow flexible revenue models
 *              while keeping business logic independent of infrastructure.
 **************************************************************************************************/

import { v4 as uuidv4 } from 'uuid';

/* ────────────────────────────────────────────────────────────────────────── *
 *  Domain primitives                                                        *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Monetary amount expressed in the major unit of the company’s
 * operating currency (e.g., USD). Minor‐unit precision is preserved.
 */
export class MonetaryAmount {
  constructor(public readonly value: number) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`MonetaryAmount must be a non-negative finite number. Received: ${value}`);
    }
  }

  public add(other: MonetaryAmount): MonetaryAmount {
    return new MonetaryAmount(this.value + other.value);
  }

  public multiply(factor: number): MonetaryAmount {
    if (!Number.isFinite(factor) || factor < 0) {
      throw new Error(`Factor must be a non-negative finite number. Received: ${factor}`);
    }
    return new MonetaryAmount(this.value * factor);
  }

  public toString(): string {
    return this.value.toFixed(2);
  }
}

/**
 * Enumeration of SLA tiers that impact pricing multipliers.
 */
export enum SlaTier {
  STANDARD = 'STANDARD',
  GOLD = 'GOLD',
  PLATINUM = 'PLATINUM'
}

/**
 * Metrics captured for every inference request.
 * These metrics are inputs for the pricing engine.
 */
export interface InferenceRequestMetrics {
  modelName: string;
  requestTimestamp: Date;
  /**
   * Row‐equivalent units processed (e.g., number of customer records predicted on).
   */
  workloadSize: number;
  /**
   * Arbitrary complexity score (0–1). 1 indicates maximum‐complexity pipeline.
   */
  pipelineComplexity: number;
  /**
   * SLA tier associated with the customer making the request.
   */
  slaTier: SlaTier;
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Strategy Pattern                                                         *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Strategy interface for revenue calculation.
 * Implementations encapsulate all business rules for pricing.
 */
export interface RevenueStrategy {
  /**
   * Calculates the cost of serving an inference request.
   * @param metrics – Characteristics of the inference job.
   */
  calculateCost(metrics: InferenceRequestMetrics): MonetaryAmount;
  /**
   * Optional human-readable name used for audit & billing.
   */
  readonly name: string;
}

/**
 * Usage-based pricing strategy:
 *   Cost = baseFee + sizeComponent + complexityComponent, scaled by SLA multiplier.
 */
export class UsageBasedStrategy implements RevenueStrategy {
  public readonly name = 'USAGE_BASED';

  // Domain constants (could be loaded from configuration).
  private readonly baseFee = new MonetaryAmount(0.05); // 5 cents per request
  private readonly perRowRate = 0.0001;                 // $0.0001 per row
  private readonly complexityMultiplier = 0.25;         // 25% of complexity score
  private readonly slaMultipliers: Record<SlaTier, number> = {
    [SlaTier.STANDARD]: 1.0,
    [SlaTier.GOLD]: 1.2,
    [SlaTier.PLATINUM]: 1.5
  };

  public calculateCost(metrics: InferenceRequestMetrics): MonetaryAmount {
    const { workloadSize, pipelineComplexity, slaTier } = metrics;

    if (workloadSize < 0) {
      throw new Error('workloadSize cannot be negative.');
    }
    if (pipelineComplexity < 0 || pipelineComplexity > 1) {
      throw new Error('pipelineComplexity must be between 0 and 1.');
    }

    const sizeComponent = new MonetaryAmount(workloadSize * this.perRowRate);
    const complexityComponent = new MonetaryAmount(
      pipelineComplexity * this.complexityMultiplier
    );

    const rawCost = this.baseFee
      .add(sizeComponent)
      .add(complexityComponent);

    const multiplier = this.slaMultipliers[slaTier];
    return rawCost.multiply(multiplier);
  }
}

/**
 * Subscription-based pricing strategy:
 *   Flat monthly fee grants quota. Overage is billed usage-based.
 *   This simplistic implementation assumes quota state lives elsewhere
 *   (e.g., billing microservice). For demonstration, we pass quotaRemaining
 *   via metrics argument.
 */
export interface SubscriptionMetrics extends InferenceRequestMetrics {
  quotaRemaining: number; // Unit-equivalents left in the subscription cycle.
}

export class SubscriptionStrategy implements RevenueStrategy {
  public readonly name = 'SUBSCRIPTION';

  private readonly monthlyFlatFee = new MonetaryAmount(999); // $999 / month
  private readonly overagePerRowRate = 0.0002;               // Slightly higher than usage-based
  private readonly slaDiscount: Record<SlaTier, number> = {
    [SlaTier.STANDARD]: 1.0,
    [SlaTier.GOLD]: 0.9,      // 10% discount for GOLD
    [SlaTier.PLATINUM]: 0.8   // 20% discount for PLATINUM
  };

  public calculateCost(metrics: InferenceRequestMetrics): MonetaryAmount {
    const subMetrics = metrics as SubscriptionMetrics;
    const { workloadSize, slaTier, quotaRemaining } = subMetrics;

    if (quotaRemaining < 0) {
      throw new Error('quotaRemaining cannot be negative.');
    }

    const overageUnits = Math.max(workloadSize - quotaRemaining, 0);
    const overageCost = new MonetaryAmount(overageUnits * this.overagePerRowRate);
    return overageCost.multiply(this.slaDiscount[slaTier]);
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Factory Pattern                                                          *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Factory responsible for producing RevenueStrategy instances.
 * Keeps the creation logic decoupled from domain services.
 */
export class RevenueStrategyFactory {
  private static readonly registry: Map<string, () => RevenueStrategy> = new Map([
    ['USAGE_BASED', () => new UsageBasedStrategy()],
    ['SUBSCRIPTION', () => new SubscriptionStrategy()]
  ]);

  /**
   * Registers a new revenue strategy at runtime.
   * Can be used by plugins/adapters that extend business logic.
   */
  public static register(
    strategyName: string,
    factoryFn: () => RevenueStrategy
  ): void {
    if (this.registry.has(strategyName)) {
      throw new Error(`RevenueStrategy "${strategyName}" is already registered.`);
    }
    this.registry.set(strategyName, factoryFn);
  }

  /**
   * Obtains a strategy instance by name.
   * @throws if strategy is unknown.
   */
  public static create(strategyName: string): RevenueStrategy {
    const fn = this.registry.get(strategyName);
    if (!fn) {
      throw new Error(`RevenueStrategy "${strategyName}" is not registered.`);
    }
    return fn();
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Observer Pattern                                                         *
 * ────────────────────────────────────────────────────────────────────────── */

export interface PriceCalculatedEvent {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly cost: MonetaryAmount;
  readonly strategyName: string;
  readonly requestMetrics: InferenceRequestMetrics;
}

export interface PricingEventObserver {
  onPriceCalculated(event: PriceCalculatedEvent): void | Promise<void>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Domain Service: PricingService                                           *
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Domain service that encapsulates pricing logic and event emission.
 */
export class PricingService {
  private readonly observers: Set<PricingEventObserver> = new Set();

  constructor(private readonly strategy: RevenueStrategy) {}

  /**
   * Calculates cost for a given inference request and notifies observers.
   */
  public async priceRequest(
    metrics: InferenceRequestMetrics
  ): Promise<MonetaryAmount> {
    const cost = this.strategy.calculateCost(metrics);

    const event: PriceCalculatedEvent = {
      eventId: uuidv4(),
      occurredAt: new Date(),
      cost,
      strategyName: this.strategy.name,
      requestMetrics: Object.freeze({ ...metrics }) // defensive copy
    };

    await this.notifyObservers(event);
    return cost;
  }

  /* ─────────────── Observer management ─────────────── */

  public addObserver(observer: PricingEventObserver): void {
    this.observers.add(observer);
  }

  public removeObserver(observer: PricingEventObserver): void {
    this.observers.delete(observer);
  }

  private async notifyObservers(event: PriceCalculatedEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const observer of this.observers) {
      try {
        // Convert any synchronous callback to Promise for uniformity
        const result = observer.onPriceCalculated(event);
        if (result instanceof Promise) {
          promises.push(result);
        }
      } catch (e) {
        // Log and continue – PricingService must never throw on observer failure
        // In real implementation, would delegate to central logger.
        console.error('[PricingService] Observer failure:', e);
      }
    }

    if (promises.length) {
      try {
        await Promise.all(promises);
      } catch (e) {
        console.error('[PricingService] Async observer failure:', e);
      }
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Example Observer Implementation (for reference)                          *
 *  In production, observers would live in adapter modules (e.g., Kafka,     *
 *  Datadog, Snowflake). They subscribe via addObserver() at runtime.        *
 * ────────────────────────────────────────────────────────────────────────── */

class AuditTrailObserver implements PricingEventObserver {
  async onPriceCalculated(event: PriceCalculatedEvent): Promise<void> {
    // NOTE: Replace console.log with real audit trail sink.
    console.log(
      `[AuditTrail] ${event.strategyName} cost=${event.cost.toString()} ` +
      `model=${event.requestMetrics.modelName} ` +
      `workload=${event.requestMetrics.workloadSize}`
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Usage Example (would normally live in application layer)                 *
 * ────────────────────────────────────────────────────────────────────────── */

// Example creation of service
const strategy = RevenueStrategyFactory.create('USAGE_BASED');
const pricingService = new PricingService(strategy);
pricingService.addObserver(new AuditTrailObserver());

// Example inference metrics
const exampleMetrics: InferenceRequestMetrics = {
  modelName: 'churn_predictor_v4',
  requestTimestamp: new Date(),
  workloadSize: 50_000,
  pipelineComplexity: 0.6,
  slaTier: SlaTier.GOLD
};

// Fire and forget; real application would await and persist cost.
pricingService.priceRequest(exampleMetrics).catch(console.error);
```