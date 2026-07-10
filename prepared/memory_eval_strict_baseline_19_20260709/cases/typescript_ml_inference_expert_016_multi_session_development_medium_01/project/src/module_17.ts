```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * module_17.ts
 *
 * Domain: Revenue-impacting inference cost calculation & KPI alerting.
 * Patterns: Strategy, Factory, Observer (EventEmitter-based)
 *
 * This module lives inside the “hexagon”.  It exposes pure-domain
 * interfaces + implementations that upstream adapters (e.g. REST,
 * gRPC, Kafka consumers) can invoke without pulling in any IO
 * concerns.  Outbound ‑ for example, persisting a billable event – is
 * expressed through a port interface that an adapter will fulfil.
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/* ------------------------------------------------------------------ */
/*                             Domain Types                            */
/* ------------------------------------------------------------------ */

/**
 * Public representation of an inference batch coming from an external
 * adapter (e.g. a Kafka stream, REST endpoint, etc.).
 */
export interface InferenceBatch {
  readonly batchId: string;
  /** ISO-8601 string */
  readonly timestamp: string;
  /** How many individual model inferences were performed. */
  readonly inferenceCount: number;
  /**
   * Optional metadata that pricing strategies may or may not use
   * (e.g. enterprise tier, SLA level, custom discounts).
   */
  readonly tags?: Record<string, string | number>;
}

/**
 * Result produced by a revenue strategy.
 */
export interface RevenueReport {
  readonly reportId: string;
  readonly batchId: string;
  /**
   * Strategy identifier, e.g. `usage_based` or `subscription`.
   * Useful for observability / billing breakdowns.
   */
  readonly strategy: string;
  /** Final price in minor currency units (e.g. cents). */
  readonly amountMinor: number;
  /** ISO-8601 string */
  readonly calculatedAt: string;
}

/* ------------------------------------------------------------------ */
/*                       Strategy Pattern – Domain                     */
/* ------------------------------------------------------------------ */

/**
 * Pricing algorithm contract.
 */
export interface RevenueStrategy {
  readonly name: string;

  /**
   * Calculate the billable amount (minor currency units).
   * Must be side-effect-free.
   */
  calculate(batch: InferenceBatch): number;
}

/**
 * Usage-based pricing: X cents per inference.
 */
export class UsageBasedRevenueStrategy implements RevenueStrategy {
  public readonly name = 'usage_based';

  constructor(private readonly pricePerInferenceMinor: number) {
    if (pricePerInferenceMinor <= 0) {
      throw new Error(
        `[UsageBasedRevenueStrategy] pricePerInferenceMinor must be > 0 (received ${pricePerInferenceMinor})`
      );
    }
  }

  public calculate(batch: InferenceBatch): number {
    if (batch.inferenceCount < 0) {
      throw new Error(
        `[UsageBasedRevenueStrategy] inferenceCount cannot be negative (batchId=${batch.batchId})`
      );
    }
    return batch.inferenceCount * this.pricePerInferenceMinor;
  }
}

/**
 * Subscription pricing: fixed monthly fee, but we still compute a
 * synthetic "unit cost" for internal finance dashboards.  The
 * adapter that calls the port can decide whether or not to bill.
 */
export class SubscriptionRevenueStrategy implements RevenueStrategy {
  public readonly name = 'subscription';

  constructor(
    private readonly monthlyFlatFeeMinor: number,
    private readonly avgMonthlyInferenceQuota: number // ‑1 means unlimited
  ) {
    if (monthlyFlatFeeMinor <= 0) {
      throw new Error(
        `[SubscriptionRevenueStrategy] monthlyFlatFeeMinor must be > 0 (received ${monthlyFlatFeeMinor})`
      );
    }
    if (avgMonthlyInferenceQuota === 0) {
      throw new Error(
        '[SubscriptionRevenueStrategy] avgMonthlyInferenceQuota cannot be 0'
      );
    }
  }

  public calculate(batch: InferenceBatch): number {
    if (this.avgMonthlyInferenceQuota < 0) {
      // Unlimited plan → effective unit price = 0
      return 0;
    }

    const unitPrice = Math.ceil(
      this.monthlyFlatFeeMinor / this.avgMonthlyInferenceQuota
    );
    return batch.inferenceCount * unitPrice;
  }
}

/* ------------------------------------------------------------------ */
/*                Factory Pattern – Strategy Instantiation             */
/* ------------------------------------------------------------------ */

/**
 * Configuration object supplied by the calling adapter, usually
 * hydrated from environment variables or a configuration service
 * (e.g. HashiCorp Vault, AWS AppConfig).
 */
export interface PricingEngineConfig {
  type: 'usage_based' | 'subscription';
  /**
   * Additional config per strategy.  Keys are intentionally
   * left loose to prevent coupling the domain to config shape.
   */
  params: Record<string, unknown>;
}

/**
 * Creates concrete strategies based on runtime configuration.
 * Keeps the hexagon pure by disallowing direct dependency
 * on environment variables or secret stores.
 */
export class RevenueStrategyFactory {
  public static create(config: PricingEngineConfig): RevenueStrategy {
    switch (config.type) {
      case 'usage_based': {
        const price = Number(config.params['pricePerInferenceMinor']);
        return new UsageBasedRevenueStrategy(price);
      }

      case 'subscription': {
        const flatFee = Number(config.params['monthlyFlatFeeMinor']);
        const quota = Number(config.params['avgMonthlyInferenceQuota']);
        return new SubscriptionRevenueStrategy(flatFee, quota);
      }

      default:
        throw new Error(
          `[RevenueStrategyFactory] Unsupported strategy type: ${config.type}`
        );
    }
  }
}

/* ------------------------------------------------------------------ */
/*                    Domain Service (Hexagon Core)                    */
/* ------------------------------------------------------------------ */

/**
 * Allows the rest of the domain to remain oblivious to concrete
 * strategy implementations.  Similar to Java’s “context” object.
 */
export class RevenueService {
  /**
   * All KPI notifications emitted by the service.
   * Consumers (e.g., monitoring dashboards, audit log adapters)
   * can subscribe via `on(...)`.
   */
  private readonly kpiEvents = new EventEmitter();

  constructor(
    private readonly strategy: RevenueStrategy,
    private readonly billingPort: BillingPort
  ) {}

  /**
   * Calculates revenue for a batch and persists it using the
   * provided billing port.  Also emits an in-memory KPI event.
   */
  public async processInferenceBatch(
    batch: InferenceBatch
  ): Promise<RevenueReport> {
    try {
      const amountMinor = this.strategy.calculate(batch);

      const report: RevenueReport = {
        reportId: uuidv4(),
        batchId: batch.batchId,
        strategy: this.strategy.name,
        amountMinor,
        calculatedAt: new Date().toISOString(),
      };

      await this.billingPort.persistRevenueReport(report);
      this.kpiEvents.emit('revenue_calculated', report);

      return report;
    } catch (err) {
      // Convert unknown error into a typed Error for better DX
      const safeError =
        err instanceof Error
          ? err
          : new Error(
              `[RevenueService] Unknown error encountered: ${JSON.stringify(
                err
              )}`
            );
      this.kpiEvents.emit('revenue_error', safeError);
      throw safeError;
    }
  }

  /* ------------ Observer Pattern: Event Subscription API --------- */

  public on(
    event: 'revenue_calculated',
    listener: (report: RevenueReport) => void
  ): this;
  public on(event: 'revenue_error', listener: (error: Error) => void): this;
  public on(
    event: 'revenue_calculated' | 'revenue_error',
    listener: (payload: unknown) => void
  ): this {
    this.kpiEvents.on(event, listener);
    return this;
  }

  public off(
    event: 'revenue_calculated' | 'revenue_error',
    listener: (...args: unknown[]) => void
  ): this {
    this.kpiEvents.off(event, listener);
    return this;
  }
}

/* ------------------------------------------------------------------ */
/*                        Outbound Port Definition                     */
/* ------------------------------------------------------------------ */

/**
 * Ports live in the domain and must be implemented by adapters.
 * For example, an adapter may write to PostgreSQL, another to Snowflake.
 */
export interface BillingPort {
  /**
   * Persist the revenue report in an idempotent fashion.  Implementations
   * should ensure the report is stored exactly once even if the method
   * is called multiple times (e.g., via unique constraints or upsert).
   */
  persistRevenueReport(report: RevenueReport): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*                         Example Usage (tests)                       */
/* ------------------------------------------------------------------ */

/*
  The snippet below demonstrates how an adapter might wire things
  together.  It is left commented out so that the core module
  remains side-effect free.

  import { PostgresBillingAdapter } from '../adapters/postgresBillingAdapter';

  const config: PricingEngineConfig = {
    type: process.env.PRICING_MODEL as 'usage_based' | 'subscription',
    params: {
      pricePerInferenceMinor: process.env.PRICE_PER_INFERENCE,
      monthlyFlatFeeMinor: process.env.MONTHLY_FLAT_FEE,
      avgMonthlyInferenceQuota: process.env.MONTHLY_INFERENCE_QUOTA,
    },
  };

  const strategy = RevenueStrategyFactory.create(config);
  const billingPort = new PostgresBillingAdapter();
  const revenueService = new RevenueService(strategy, billingPort);

  revenueService.on('revenue_calculated', (report) => {
    console.log('🤑 Revenue calculated:', report);
  });

  // Later, inside a controller / consumer:
  await revenueService.processInferenceBatch({
    batchId: 'batch-42',
    timestamp: new Date().toISOString(),
    inferenceCount: 1_200,
  });
*/

/* ------------------------------------------------------------------ */
/*                            Public Exports                           */
/* ------------------------------------------------------------------ */

export {
  UsageBasedRevenueStrategy,
  SubscriptionRevenueStrategy,
  RevenueStrategyFactory,
  RevenueService,
};
```
