```typescript
/****************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * --------------------------------------------------------------------------------------
 * File:        src/module_52.ts
 * Module:      Inference Pricing (Domain Layer)
 * Description: Hexagonal-architecture domain service that calculates the monetary
 *              cost of each real-time inference request.  The calculation is delegated
 *              to interchangeable PricingStrategy implementations (Strategy Pattern)
 *              that may be switched at run-time through the PricingStrategyFactory
 *              (Factory Pattern).  The service also emits pricing events (Observer
 *              Pattern) so that adapters—billing ledgers, BI dashboards, alerts—can
 *              subscribe without coupling to business logic.
 *
 * Author:      InsightHexaAI Engineering
 * License:     MIT
 ****************************************************************************************/

import { EventEmitter } from 'events';
import Decimal from 'decimal.js-light';

/*
 * --------------------------------------------------------------------------------------
 * Domain Types
 * --------------------------------------------------------------------------------------
 */

/**
 * Monetary units supported by the platform.  Monetary calculations rely on `Decimal`
 * for loss-less precision.
 */
export enum Currency {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
}

/**
 * Contextual metadata describing an online inference request.  This object is created
 * by an adapter (e.g., a REST controller or Kafka consumer) and passed into the
 * hexagon.  Only stable, business-level attributes are allowed here.
 */
export interface InferenceRequestMeta {
  /** Globally-unique identifier for the request */
  readonly requestId: string;

  /** Name (slug) of the model requested, e.g., 'clv-xgb-v23' */
  readonly modelName: string;

  /** Milliseconds of compute time consumed on GPU or CPU */
  readonly latencyMs: number;

  /** Whether the request was served from an online feature store cache */
  readonly cacheHit: boolean;

  /** ISO-8601 timestamp in UTC */
  readonly timestamp: string;

  /** Optional reference to the customer account making the call */
  readonly accountId?: string;
}

/**
 * The result of a pricing calculation.  Downstream adapters convert this DTO to their
 * own data models (e.g., Stripe metadata, Snowflake tables, log events, …).
 */
export interface PricingDecision {
  /** Positive decimal monetary value */
  readonly amount: Decimal;

  /** Currency in which the cost is denominated */
  readonly currency: Currency;

  /** The pricing strategy that produced this decision */
  readonly strategy: string;

  /** Request for which this decision was made */
  readonly requestId: string;

  /** ISO-8601 timestamp of when the cost was calculated */
  readonly calculatedAt: string;
}

/*
 * --------------------------------------------------------------------------------------
 * Strategy Pattern
 * --------------------------------------------------------------------------------------
 */

/**
 * Contract for cost-calculation algorithms.  Implementations must be pure functions of
 * the provided metadata in order to keep the domain deterministic and testable.
 */
export interface PricingStrategy {
  readonly name: string;

  /**
   * Calculate the price of a single inference request.
   *
   * @param meta - Immutable metadata about the inference request.
   * @returns Monetary cost of the request.
   * @throws PricingError – When calculation fails (e.g., missing data).
   */
  calculate(meta: InferenceRequestMeta): PricingDecision;
}

/**
 * Usage-based pricing: charges a flat rate per millisecond of compute time.  This is
 * the default strategy recommended for pay-as-you-go customers.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly name = 'USAGE_BASED';

  constructor(
    private readonly pricePerMs: Decimal = new Decimal(0.000002), // $0.002 per 1 sec
    private readonly currency: Currency = Currency.USD,
  ) {}

  calculate(meta: InferenceRequestMeta): PricingDecision {
    this.assertValid(meta);

    const amount = this.pricePerMs.mul(meta.latencyMs);
    return {
      amount,
      currency: this.currency,
      strategy: this.name,
      requestId: meta.requestId,
      calculatedAt: new Date().toISOString(),
    };
  }

  private assertValid(meta: InferenceRequestMeta): void {
    if (meta.latencyMs < 0) {
      throw new PricingError(
        `[UsageBasedPricingStrategy] latencyMs cannot be negative (received ${meta.latencyMs})`,
      );
    }
  }
}

/**
 * Subscription-tier pricing: the marginal cost of an inference is zero for the calling
 * account because usage is prepaid.  Still, Finance may want to record an "imputed
 * cost" for internal cost-of-goods sold (COGS) analysis; hence we emit $0.00.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly name = 'SUBSCRIPTION_FLAT';

  calculate(meta: InferenceRequestMeta): PricingDecision {
    return {
      amount: new Decimal(0),
      currency: Currency.USD,
      strategy: this.name,
      requestId: meta.requestId,
      calculatedAt: new Date().toISOString(),
    };
  }
}

/**
 * SLA-aware pricing: surcharges low-latency requests with a multiplier.
 *
 * Rules:
 * - Base rate: $0.000003 per ms
 * - 2× multiplier if latency target is < 10 ms
 * - 0.5× discount for cache hits
 */
export class SlaTierPricingStrategy implements PricingStrategy {
  public readonly name = 'SLA_TIER';

  private readonly baseRate = new Decimal(0.000003);

  constructor(private readonly currency: Currency = Currency.USD) {}

  calculate(meta: InferenceRequestMeta): PricingDecision {
    this.assertValid(meta);

    let rate = this.baseRate;

    // Apply low-latency surcharge
    if (meta.latencyMs <= 10) {
      rate = rate.mul(2);
    }

    // Apply cache discount
    if (meta.cacheHit) {
      rate = rate.mul(0.5);
    }

    const amount = rate.mul(meta.latencyMs);

    return {
      amount,
      currency: this.currency,
      strategy: this.name,
      requestId: meta.requestId,
      calculatedAt: new Date().toISOString(),
    };
  }

  private assertValid(meta: InferenceRequestMeta): void {
    if (meta.latencyMs < 0) {
      throw new PricingError(
        `[SlaTierPricingStrategy] latencyMs cannot be negative (received ${meta.latencyMs})`,
      );
    }
  }
}

/*
 * --------------------------------------------------------------------------------------
 * Factory Pattern
 * --------------------------------------------------------------------------------------
 */

export enum PricingStrategyKind {
  USAGE_BASED = 'usage',
  SUBSCRIPTION = 'subscription',
  SLA_TIER = 'sla',
}

export interface PricingStrategyConfig {
  kind: PricingStrategyKind;
  /** Additional JSON config; interpreted per strategy. */
  params?: Record<string, unknown>;
}

/**
 * Dynamically creates PricingStrategy instances from configuration.  Keeps adapters
 * decoupled from concrete strategy classes.
 */
export class PricingStrategyFactory {
  static create(cfg: PricingStrategyConfig): PricingStrategy {
    switch (cfg.kind) {
      case PricingStrategyKind.USAGE_BASED: {
        const rate = cfg.params?.pricePerMs as number | undefined;
        const currency = (cfg.params?.currency as Currency | undefined) ?? Currency.USD;
        return new UsageBasedPricingStrategy(
          rate !== undefined ? new Decimal(rate) : undefined,
          currency,
        );
      }
      case PricingStrategyKind.SUBSCRIPTION:
        return new SubscriptionPricingStrategy();

      case PricingStrategyKind.SLA_TIER: {
        const currency = (cfg.params?.currency as Currency | undefined) ?? Currency.USD;
        return new SlaTierPricingStrategy(currency);
      }

      default:
        throw new PricingError(
          `[PricingStrategyFactory] Unsupported pricing strategy kind: ${cfg.kind as string}`,
        );
    }
  }
}

/*
 * --------------------------------------------------------------------------------------
 * Domain Service
 * --------------------------------------------------------------------------------------
 */

/**
 * Event names emitted by InferencePricingService
 */
export enum PricingEvents {
  DECISION_MADE = 'pricing.decision_made',
  ERROR = 'pricing.error',
}

/**
 * Domain service that wraps a strategy and exposes a stable API to adapters.
 */
export class InferencePricingService {
  private readonly emitter = new EventEmitter();

  constructor(private readonly strategy: PricingStrategy) {}

  /**
   * Subscribe to pricing events. Returns the same emitter instance to allow `on`
   * chaining while preserving encapsulation of the internal `EventEmitter`.
   */
  get events(): EventEmitter {
    return this.emitter;
  }

  /**
   * Calculates the price for a given inference request and emits a decision event.
   * Any error during calculation will be emitted as well.
   */
  calculate(meta: InferenceRequestMeta): PricingDecision {
    try {
      const decision = this.strategy.calculate(meta);
      this.emitter.emit(PricingEvents.DECISION_MADE, decision);
      return decision;
    } catch (err) {
      const wrapped = PricingError.wrap(err);
      this.emitter.emit(PricingEvents.ERROR, wrapped, meta);
      throw wrapped;
    }
  }
}

/*
 * --------------------------------------------------------------------------------------
 * Error Handling
 * --------------------------------------------------------------------------------------
 */

/**
 * Domain-specific error class for all pricing-related failures.
 */
export class PricingError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PricingError';

    // Maintain proper stack traces in V8 engines
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PricingError);
    }
  }

  /** Wrap any unknown error into a PricingError to keep the public contract stable. */
  static wrap(err: unknown): PricingError {
    return err instanceof PricingError
      ? err
      : new PricingError(
          '[PricingError] Unknown error during pricing calculation',
          err,
        );
  }
}

/*
 * --------------------------------------------------------------------------------------
 * Example Usage (to be removed in production build; kept here for clarity)
 * --------------------------------------------------------------------------------------
 */

if (process.env.NODE_ENV !== 'production') {
  // Example configuration pulled from environment or config service.
  const config: PricingStrategyConfig = {
    kind: PricingStrategyKind.SLA_TIER,
    params: { currency: Currency.USD },
  };

  const strategy = PricingStrategyFactory.create(config);
  const pricingSvc = new InferencePricingService(strategy);

  pricingSvc.events.on(PricingEvents.DECISION_MADE, (decision: PricingDecision) => {
    // eslint-disable-next-line no-console
    console.log('[Pricing Decision]', decision);
  });

  pricingSvc.events.on(PricingEvents.ERROR, (err: Error) => {
    // eslint-disable-next-line no-console
    console.error('[Pricing Error]', err);
  });

  const sampleMeta: InferenceRequestMeta = {
    requestId: 'req_123',
    modelName: 'churn-rf-v7',
    latencyMs: 8,
    cacheHit: false,
    timestamp: new Date().toISOString(),
    accountId: 'acct_A',
  };

  pricingSvc.calculate(sampleMeta);
}
```