```typescript
/**************************************************************************************************
 * InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_54.ts
 * Author:      InsightHexaAI Core Team
 * Description: SLA–aware inference billing component (hexagonal “domain-service” layer).
 *
 * This module implements a pluggable PricingStrategy engine, allowing the platform to calculate
 * inference-level costs according to business-defined revenue models (usage-based, subscription,
 * tiered, etc.).  Product owners can add or swap strategies at runtime without touching any IO
 * adapters (Kafka/Snowflake/Stripe/etc.) thanks to the Factory and Strategy patterns.
 *
 * Patterns & Principles:
 *   • Strategy Pattern   — interchangeable pricing algorithms
 *   • Factory  Pattern   — centralised instantiation & dependency injection
 *   • Hexagonal Arch.    — ports (interfaces) isolate core logic from external concerns
 *   • SOLID              — SRP, OCP, DIP, etc.
 **************************************************************************************************/

/* External deps kept minimal; all heavy lifting (tax/currency/FP math) is abstracted away.
 * decimal.js-light is battle-tested and tree-shakeable for precise currency math. */
import Decimal from 'decimal.js-light';

/*---------------------------------------------------------
 | Domain primitives & shared abstractions
 *--------------------------------------------------------*/

/**
 * ISO-4217 currency codes supported by InsightHexaAI billing.
 * Extendable should finance ever support multi-currency contracts.
 */
export type Currency = 'USD' | 'EUR' | 'GBP' | 'JPY';

/**
 * Monetary value wrapper with high-precision arithmetic.
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: Currency;

  constructor(amount: Decimal.Value, currency: Currency = 'USD') {
    this.amount = new Decimal(amount);
    this.currency = currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.add(other.amount), this.currency);
  }

  sub(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.sub(other.amount), this.currency);
  }

  mul(n: Decimal.Value): Money {
    return new Money(this.amount.mul(n), this.currency);
  }

  toString(): string {
    return `${this.currency} ${this.amount.toFixed(4)}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/*---------------------------------------------------------
 | Ports (hexagon “inbound” interfaces)
 *--------------------------------------------------------*/

/** Domain data required for pricing an inference request. */
export interface PricingContext {
  /** Unique enterprise customer identifier */
  readonly customerId: string;
  /** SLA tier (e.g., silver, gold, platinum) informs base price & discounts */
  readonly slaTier: 'SILVER' | 'GOLD' | 'PLATINUM';
  /** The ML model invoked */
  readonly modelName: string;
  /** Number of inferences performed */
  readonly inferenceCount: number;
  /** Total compute time (ms) consumed by the request  */
  readonly totalComputeMs: number;
  /** Timestamp of the inference event */
  readonly timestamp: Date;
}

/** Strategy contract for pricing algorithms. */
export interface PricingStrategy {
  readonly name: string;
  /**
   * Calculate price for the given inference context.
   * Should never throw; instead return Money(0) on internal failure and log via ErrorReporterPort.
   */
  calculatePrice(ctx: PricingContext): Money;
}

/**
 * Hexagonal output port for persisting calculated billing records.
 * (Implemented by an adapter e.g., to Snowflake, BigQuery, Stripe, etc.)
 */
export interface BillingRepositoryPort {
  persistCharge(ctx: PricingContext, charge: Money): Promise<void>;
}

/**
 * Hexagonal output port for emitting domain warnings / errors to logging or alerting systems.
 * Keeps domain logic unattractive to any single logging library.
 */
export interface ErrorReporterPort {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(err: unknown, meta?: Record<string, unknown>): void;
}

/*---------------------------------------------------------
 | Strategy Implementations
 *--------------------------------------------------------*/

/** Usage-based pricing: simple per-inference fee + compute time micro-billing. */
export class UsageBasedPricingStrategy implements PricingStrategy {
  readonly name = 'USAGE_BASED';
  /**
   * Fee configuration (could be externalised to feature flags or config DB).
   * Unit prices kept as Decimal for transparency and accuracy.
   */
  private readonly feePerInference = new Decimal(0.0025); // $0.0025 / inference
  private readonly feePerComputeMs = new Decimal(0.00000015); // $0.00000015 / ms

  calculatePrice(ctx: PricingContext): Money {
    const inferenceComponent = this.feePerInference.mul(ctx.inferenceCount);
    const computeComponent = this.feePerComputeMs.mul(ctx.totalComputeMs);
    const total = inferenceComponent.add(computeComponent);
    return new Money(total, 'USD');
  }
}

/** Subscription pricing: zero marginal cost—price is baked into subscription. */
export class SubscriptionPricingStrategy implements PricingStrategy {
  readonly name = 'SUBSCRIPTION';
  calculatePrice(_: PricingContext): Money {
    return new Money(0, 'USD');
  }
}

/** Tiered pricing: volume discounts based on cumulative usage thresholds. */
export class TieredPricingStrategy implements PricingStrategy {
  readonly name = 'TIERED';

  /* Example tier map; real implementation would query billing DB for usage YTD/MTD. */
  private readonly tiers: Array<{ from: number; to: number; price: Decimal }> = [
    { from: 0, to: 1_000, price: new Decimal(0.003) },
    { from: 1_001, to: 10_000, price: new Decimal(0.0022) },
    { from: 10_001, to: Infinity, price: new Decimal(0.0015) },
  ];

  calculatePrice(ctx: PricingContext): Money {
    const tier = this.tiers.find(t => ctx.inferenceCount >= t.from && ctx.inferenceCount <= t.to);
    const unitPrice = tier ? tier.price : this.tiers[this.tiers.length - 1].price;
    return new Money(unitPrice.mul(ctx.inferenceCount), 'USD');
  }
}

/*---------------------------------------------------------
 | Factory
 *--------------------------------------------------------*/

/** Factory for retrieving the correct PricingStrategy at runtime. */
export class PricingStrategyFactory {
  private readonly strategies: Map<string, PricingStrategy>;

  constructor(customStrategies: PricingStrategy[] = []) {
    // Register built-ins + caller-supplied custom ones.
    this.strategies = new Map(
      [
        new UsageBasedPricingStrategy(),
        new SubscriptionPricingStrategy(),
        new TieredPricingStrategy(),
        ...customStrategies,
      ].map(s => [s.name, s]),
    );
  }

  /**
   * Resolve a strategy by name.
   * Throws if the strategy is not registered; caller decides how to handle.
   */
  get(strategyName: string): PricingStrategy {
    const strategy = this.strategies.get(strategyName.toUpperCase());
    if (!strategy) {
      throw new StrategyNotFoundError(strategyName);
    }
    return strategy;
  }
}

/*---------------------------------------------------------
 | Domain Service (Application Layer inside the Hexagon)
 *--------------------------------------------------------*/

/**
 * InferenceBillingService orchestrates the pricing strategy and persistence
 * of billing records, and reports any non-fatal failures to ErrorReporterPort.
 */
export class InferenceBillingService {
  constructor(
    private readonly strategyFactory: PricingStrategyFactory,
    private readonly billingRepo: BillingRepositoryPort,
    private readonly errorReporter: ErrorReporterPort,
  ) {}

  /**
   * Calculate and persist charge for a single inference context.
   * Fails gracefully: persistence errors are reported but won’t disrupt request flow.
   */
  async billInference(ctx: PricingContext, strategyName: string): Promise<Money> {
    let price: Money;
    try {
      const strategy = this.strategyFactory.get(strategyName);
      price = strategy.calculatePrice(ctx);
    } catch (err) {
      this.errorReporter.error(err, { ctx, strategyName });
      // Fall back to safe default (free)
      price = new Money(0, 'USD');
    }

    // Persist charge asynchronously; caller awaits to ensure durability if needed.
    try {
      await this.billingRepo.persistCharge(ctx, price);
    } catch (err) {
      this.errorReporter.error(err, { ctx, price: price.toString() });
      // Domain decision: we do NOT re-throw; losing a charge is better than blocking inference.
    }

    return price;
  }
}

/*---------------------------------------------------------
 | Custom Error Types
 *--------------------------------------------------------*/

export class StrategyNotFoundError extends Error {
  constructor(name: string) {
    super(`Pricing strategy '${name}' not found or not registered.`);
    this.name = StrategyNotFoundError.name;
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: Currency, b: Currency) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = CurrencyMismatchError.name;
  }
}

/*---------------------------------------------------------
 | Example No-Op Adapters (for testing & demonstration)
 *--------------------------------------------------------*/

/**
 * In-memory billing repository useful for unit tests.
 */
export class InMemoryBillingRepository implements BillingRepositoryPort {
  private readonly records: Array<{ ctx: PricingContext; charge: Money }> = [];

  async persistCharge(ctx: PricingContext, charge: Money): Promise<void> {
    this.records.push({ ctx, charge });
  }

  /** Expose internal state for assertions */
  getCharges(): ReadonlyArray<{ ctx: PricingContext; charge: Money }> {
    return this.records;
  }
}

/**
 * Console-based error reporter (dev use only).
 */
export class ConsoleErrorReporter implements ErrorReporterPort {
  warn(message: string, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.warn('[InsightHexaAI:WARN]', message, meta ?? {});
  }
  error(err: unknown, meta?: Record<string, unknown>): void {
    // eslint-disable-next-line no-console
    console.error('[InsightHexaAI:ERROR]', err, meta ?? {});
  }
}
```