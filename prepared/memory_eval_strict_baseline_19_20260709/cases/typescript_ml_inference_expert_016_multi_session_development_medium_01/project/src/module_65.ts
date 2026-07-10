```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * Module: module_65.ts
 * Area  : Core Domain ‑ Revenue Management & KPI Observability
 *
 * Hexagonal side: INSIDE the hexagon (pure domain logic)
 * Responsibilities:
 *   • Provide pluggable pricing strategies (Strategy Pattern) for model-inference billing
 *   • Offer a factory (Factory Pattern) to resolve strategies at runtime
 *   • Emit KPI drift / revenue-threshold events (Observer Pattern) to interested adapters
 *
 * NOTE:
 *   This file purposefully contains NO references to IO technology (S3, Kafka, SQL, …). All
 *   collaborators are defined as ports/interfaces so that adapters can be written elsewhere.
 ***************************************************************************************************/

import { v4 as uuid } from 'uuid'; // Lightweight dependency, ok for pure logic

/***************************************************************************************************
 * Shared Value Objects & Domain Types
 ***************************************************************************************************/

/**
 * Represents a monetary value with currency awareness.
 * Immutable.
 */
export class Money {
  public readonly amount: number;
  public readonly currency: string;

  constructor(amount: number, currency: string = 'USD') {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new DomainError(`Money amount must be a non-negative finite number, received: ${amount}`);
    }
    if (!currency.match(/^[A-Z]{3}$/)) {
      throw new DomainError(`Currency must be 3-letter ISO code, received: ${currency}`);
    }

    this.amount = Number(amount.toFixed(4)); // Avoid float noise
    this.currency = currency;
    Object.freeze(this);
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  public multiply(factor: number): Money {
    if (factor < 0) {
      throw new DomainError('Factor must be >= 0');
    }
    return new Money(this.amount * factor, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  public toString(): string {
    return `${this.currency} ${this.amount.toFixed(4)}`;
  }
}

/**
 * Payload reaching the billing core after an inference request was processed.
 */
export interface InferencePayload {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly predictions: number;         // # of predictions performed
  readonly avgLatencyMs: number;        // Average latency per prediction (ms)
  readonly slaTier: 'bronze' | 'silver' | 'gold';
}

/**
 * Domain-level exception, isolated from infrastructure details.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(`[DomainError] ${message}`);
    Object.setPrototypeOf(this, DomainError.prototype);
  }
}

/***************************************************************************************************
 * Strategy Pattern – Pricing Strategies
 ***************************************************************************************************/

/**
 * Port that any pricing algorithm must implement.
 */
export interface PricingStrategy {
  readonly name: string;
  calculateCost(payload: InferencePayload): Money;
}

/**
 * Pay-as-you-go strategy. Price = predictions × unitPrice, with SLA multipliers.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly name = 'usage_based';

  constructor(
    private readonly unitPrice: Money = new Money(0.0002) // $0.0002 per prediction as default
  ) {}

  public calculateCost(payload: InferencePayload): Money {
    this.validatePayload(payload);

    const slaMultiplier = this.getSlaMultiplier(payload.slaTier);
    const rawCost = this.unitPrice.multiply(payload.predictions);
    return rawCost.multiply(slaMultiplier);
  }

  private getSlaMultiplier(tier: InferencePayload['slaTier']): number {
    switch (tier) {
      case 'bronze':
        return 1;
      case 'silver':
        return 1.25;
      case 'gold':
        return 1.5;
      default:
        throw new DomainError(`Unknown SLA tier: ${tier}`);
    }
  }

  private validatePayload(payload: InferencePayload): void {
    if (payload.predictions <= 0) {
      throw new DomainError('Predictions must be > 0 for cost calculation.');
    }
  }
}

/**
 * Fixed monthly subscription strategy. Variable inference cost is ignored.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly name = 'subscription';

  constructor(
    private readonly monthlyFee: Money = new Money(499)
  ) {}

  public calculateCost(_: InferencePayload): Money {
    // Even though we ignore usage, we still validate non-null payload to keep contract consistent
    return this.monthlyFee;
  }
}

/***************************************************************************************************
 * Factory Pattern – Runtime Strategy Resolution
 ***************************************************************************************************/

export class PricingStrategyFactory {
  /**
   * Resolve a strategy by identifier or throw if unsupported.
   */
  public static resolve(strategyId: string, customConfig?: Record<string, unknown>): PricingStrategy {
    switch (strategyId) {
      case 'usage_based':
        return new UsageBasedPricingStrategy(
          customConfig?.unitPrice instanceof Money
            ? customConfig.unitPrice
            : undefined
        );

      case 'subscription':
        return new SubscriptionPricingStrategy(
          customConfig?.monthlyFee instanceof Money
            ? customConfig.monthlyFee
            : undefined
        );

      default:
        throw new DomainError(`Unsupported pricing strategy id "${strategyId}"`);
    }
  }
}

/***************************************************************************************************
 * Observer Pattern – KPI Event Stream (IN-MEMORY PUB/SUB)
 ***************************************************************************************************/

export type Severity = 'low' | 'medium' | 'high';

/**
 * KPI Events that can be listened to by external dashboards, alerting systems, etc.
 */
export interface KPIEvent {
  readonly id: string;
  readonly metricName: string;
  readonly oldValue: number;
  readonly newValue: number;
  readonly timestamp: Date;
  readonly severity: Severity;
}

/**
 * Observer callback signature.
 */
export interface KPIObserver {
  (event: KPIEvent): void;
}

/**
 * Central dispatcher for KPI events. Maintains in-memory observer list.
 * Adapters can implement broker integration (Kafka, RabbitMQ) outside the hexagon.
 */
export class KPIEventEmitter {
  private observers: Set<KPIObserver> = new Set();

  public register(observer: KPIObserver): void {
    this.observers.add(observer);
  }

  public unregister(observer: KPIObserver): void {
    this.observers.delete(observer);
  }

  public emit(event: Omit<KPIEvent, 'id' | 'timestamp'> & Partial<Pick<KPIEvent, 'id' | 'timestamp'>>): void {
    const enrichedEvent: KPIEvent = {
      id: event.id ?? uuid(),
      timestamp: event.timestamp ?? new Date(),
      ...event,
    } as KPIEvent;

    // No async/await here; pure sync notifications.
    this.observers.forEach((obs) => {
      try {
        obs(enrichedEvent);
      } catch (err) {
        /* eslint-disable no-console */
        console.error(`[KPIEventEmitter] Observer threw error: ${(err as Error).message}`);
        /* eslint-enable no-console */
      }
    });
  }
}

/***************************************************************************************************
 * Revenue Service – Combines Strategy & Event Emission
 ***************************************************************************************************/

/**
 * Business rules for billing. Exposes a single, side-effect-free calculate() method and publishes
 * revenue events for downstream consumers (dashboards, accounting, alerts, …).
 */
export class BillingService {
  private readonly emitter: KPIEventEmitter;

  constructor(
    private readonly strategy: PricingStrategy,
    emitter?: KPIEventEmitter
  ) {
    this.emitter = emitter ?? new KPIEventEmitter();
  }

  /**
   * Calculates cost and notifies observers if revenue crosses thresholds.
   */
  public calculate(payload: InferencePayload): Money {
    const cost = this.strategy.calculateCost(payload);
    this.maybeEmitRevenueEvent(payload, cost);
    return cost;
  }

  public getEventEmitter(): KPIEventEmitter {
    return this.emitter;
  }

  /********************************** PRIVATE ****************************************/

  private maybeEmitRevenueEvent(payload: InferencePayload, cost: Money): void {
    // Simple heuristic: alert if a single request > $100 cost
    if (cost.amount >= 100) {
      this.emitter.emit({
        metricName: 'single_request_revenue',
        oldValue: 0,
        newValue: cost.amount,
        severity: 'high',
      });
    }

    // Example: warn if avg latency > 1000ms on gold tier
    if (payload.slaTier === 'gold' && payload.avgLatencyMs > 1000) {
      this.emitter.emit({
        metricName: 'latency_sla_breach',
        oldValue: 1000,
        newValue: payload.avgLatencyMs,
        severity: 'medium',
      });
    }
  }
}

/***************************************************************************************************
 * Example Usage (would be removed in production bundle but kept for dev docs)
 ***************************************************************************************************/
if (process.env['NODE_ENV'] === 'development') {
  // Self-contained dev demo
  const strategy = PricingStrategyFactory.resolve('usage_based', {
    unitPrice: new Money(0.0005),
  });

  const billingService = new BillingService(strategy);
  billingService.getEventEmitter().register((evt: KPIEvent) => {
    /* eslint-disable no-console */
    console.log('⚡ KPI Event:', evt);
    /* eslint-enable no-console */
  });

  const cost = billingService.calculate({
    modelName: 'credit-risk-v1',
    modelVersion: '1.2.4',
    predictions: 250_000,
    avgLatencyMs: 850,
    slaTier: 'gold',
  });

  /* eslint-disable no-console */
  console.log(`Cost: ${cost.toString()}`);
  /* eslint-enable no-console */
}
```