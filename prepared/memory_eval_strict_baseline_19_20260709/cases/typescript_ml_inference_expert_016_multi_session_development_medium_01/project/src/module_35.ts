```typescript
/**
 * module_35.ts
 *
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------
 * Pricing & SLA engine that lives inside the hexagon.  This module is
 * responsible for translating low-level model-serving telemetry into
 * billable events while respecting customer-specific Service-Level-
 * Agreements (SLAs).  It showcases:
 *
 * • Strategy Pattern – interchangeable pricing algorithms.
 * • Factory  Pattern – run-time selection of strategies.
 * • Observer Pattern – domain-level event propagation (decoupled
 *   from adapters such as Kafka, WebSockets, or E-mail gateways).
 *
 * The code below purposefully contains *no* IO side-effects.  Adapters
 * can listen to the exported `DomainEventBus` and forward events to
 * external systems.
 */

import { randomUUID } from 'crypto';

/* ------------------------------------------------------------------ *
 *                           Domain Types                             *
 * ------------------------------------------------------------------ */

/**
 * A single inference request that reached the core domain.
 */
export interface InferenceRequest {
  readonly id: string;
  readonly modelName: string;
  /** Actual wall-clock compute duration in milliseconds */
  readonly computeMs: number;
  /** Total input payload size in bytes */
  readonly payloadSizeBytes: number;
  /** True if request was served within contractual SLA window */
  readonly servedWithinSla: boolean;
  /** Customer identifier to allow per-tenant billing rules */
  readonly customerId: string;
}

/**
 * Outcome of the pricing engine.  Adapters can persist or forward this
 * structure to an accounting system / billing gateway.
 */
export interface PricingResult {
  readonly invoiceItemId: string;
  readonly requestId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly currency: 'USD' | 'EUR' | 'GBP' | 'JPY';
  readonly strategyUsed: string;
  /** Non-fatal warnings – e.g. SLA violated, discount applied, etc. */
  readonly notes?: string[];
}

/**
 * High-level domain events emitted by the pricing engine.  We expose
 * a discriminated union so that consumers can exhaustively switch on
 * `type`.
 */
export type PricingDomainEvent =
  | {
      type: 'INVOICE_ITEM_CREATED';
      payload: PricingResult;
    }
  | {
      type: 'SLA_VIOLATION';
      payload: {
        requestId: string;
        customerId: string;
        modelName: string;
        responseTimeMs: number;
      };
    };

/* ------------------------------------------------------------------ *
 *                       Observer (Event Bus)                         *
 * ------------------------------------------------------------------ */

/**
 * Very small in-memory event bus.  In production an adapter would map
 * these events toward Kafka, RabbitMQ, or any other message backbone.
 */
export class DomainEventBus {
  private static listeners: {
    [K in PricingDomainEvent['type']]?: Array<
      (event: Extract<PricingDomainEvent, { type: K }>) => void
    >;
  } = {};

  // Subscribe to a given event type.
  public static on<K extends PricingDomainEvent['type']>(
    type: K,
    handler: (event: Extract<PricingDomainEvent, { type: K }>) => void,
  ): void {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type]!.push(handler as never);
  }

  // Emit event to all subscribers; errors in one handler must *not*
  // affect others → we catch & log locally.
  public static emit(event: PricingDomainEvent): void {
    const handlers = this.listeners[event.type];
    if (!handlers?.length) return;

    handlers.forEach((handler) => {
      try {
        handler(event as never);
      } catch (err) {
        // Logging adapter would pick this up; we fallback to stderr
        console.error(
          `[DomainEventBus] Error in handler for ${event.type}:`,
          (err as Error).message,
        );
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 *                         Strategy Pattern                           *
 * ------------------------------------------------------------------ */

/**
 * Contract for pricing strategies.
 */
export interface PricingStrategy {
  readonly name: string;
  /**
   * Compute the billing amount for a single inference request.
   * Should never throw – return 0 for non-billable requests.
   */
  calculatePrice(request: InferenceRequest): number;
}

/**
 * Utility guard to prevent negative pricing.
 */
const sanitizePrice = (amount: number): number => Math.max(0, Math.floor(amount));

/**
 * Strategy #1 – simple pay-as-you-go model where customers pay for
 * compute time (ms) and payload size (bytes).
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly name = 'USAGE_BASED_V1';

  private readonly msRateCents: number;
  private readonly byteRateCents: number;

  public constructor(
    { msRateCents, byteRateCents }: { msRateCents: number; byteRateCents: number },
  ) {
    this.msRateCents = msRateCents;
    this.byteRateCents = byteRateCents;
  }

  calculatePrice({ computeMs, payloadSizeBytes }: InferenceRequest): number {
    const cost =
      computeMs * this.msRateCents + payloadSizeBytes * this.byteRateCents;
    return sanitizePrice(cost);
  }
}

/**
 * Strategy #2 – flat monthly subscription where incremental usage is
 * free unless an SLA is violated (penalty fee).
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly name = 'SUBSCRIPTION_FLAT_V1';
  private readonly slaPenaltyCents: number;

  public constructor({ slaPenaltyCents }: { slaPenaltyCents: number }) {
    this.slaPenaltyCents = slaPenaltyCents;
  }

  calculatePrice({ servedWithinSla }: InferenceRequest): number {
    return servedWithinSla ? 0 : this.slaPenaltyCents;
  }
}

/**
 * Strategy #3 – tiered model (Bronze, Silver, Gold) that charges
 * differently based on compute time thresholds.
 */
export class TieredPricingStrategy implements PricingStrategy {
  public readonly name = 'TIERED_V1';

  private readonly tiers: Array<{
    maxMs: number; // Inclusive upper bound
    rateCents: number;
  }>;

  public constructor(
    tiers: Array<{
      maxMs: number;
      rateCents: number;
    }>,
  ) {
    // Sort tiers ascending for deterministic evaluation
    this.tiers = tiers.sort((a, b) => a.maxMs - b.maxMs);
  }

  calculatePrice({ computeMs }: InferenceRequest): number {
    const tier = this.tiers.find((t) => computeMs <= t.maxMs);
    const rate = tier ? tier.rateCents : this.tiers[this.tiers.length - 1].rateCents;
    return sanitizePrice(computeMs * rate);
  }
}

/* ------------------------------------------------------------------ *
 *                        Factory  Pattern                            *
 * ------------------------------------------------------------------ */

export interface PricingStrategyConfig {
  /** Strategy key as stored in configuration database */
  key: 'USAGE' | 'SUBSCRIPTION' | 'TIERED';
  /** Arbitrary JSON payload validated by the factory */
  params: Record<string, unknown>;
}

/**
 * Builds a concrete pricing strategy from untyped configuration.
 */
export class PricingStrategyFactory {
  public static build(config: PricingStrategyConfig): PricingStrategy {
    switch (config.key) {
      case 'USAGE': {
        const { msRateCents, byteRateCents } = config.params as {
          msRateCents: number;
          byteRateCents: number;
        };

        if (msRateCents == null || byteRateCents == null) {
          throw new Error(
            'Invalid params for USAGE strategy – msRateCents and byteRateCents are required',
          );
        }
        return new UsageBasedPricingStrategy({ msRateCents, byteRateCents });
      }

      case 'SUBSCRIPTION': {
        const { slaPenaltyCents } = config.params as { slaPenaltyCents: number };

        if (slaPenaltyCents == null) {
          throw new Error(
            'Invalid params for SUBSCRIPTION strategy – slaPenaltyCents is required',
          );
        }
        return new SubscriptionPricingStrategy({ slaPenaltyCents });
      }

      case 'TIERED': {
        const { tiers } = config.params as {
          tiers: Array<{ maxMs: number; rateCents: number }>;
        };

        if (!Array.isArray(tiers) || tiers.length === 0) {
          throw new Error('Invalid params for TIERED strategy – tiers must be provided');
        }
        return new TieredPricingStrategy(tiers);
      }

      default:
        throw new Error(`Unknown pricing strategy "${(config as any).key}"`);
    }
  }
}

/* ------------------------------------------------------------------ *
 *                      Inference Pricing Service                     *
 * ------------------------------------------------------------------ */

/**
 * Core domain service – no IO, no frameworks.
 */
export class InferencePricingService {
  private readonly strategy: PricingStrategy;

  public constructor(strategy: PricingStrategy) {
    this.strategy = strategy;
  }

  /**
   * Calculates price, emits corresponding domain events, and returns
   * the `PricingResult`.  Any synchronous error bubbles up and should
   * be translated by outer layers into a proper HTTP/gRPC response.
   */
  public price(request: InferenceRequest): PricingResult {
    const amountCents = this.strategy.calculatePrice(request);

    const pricingResult: PricingResult = {
      invoiceItemId: randomUUID(),
      requestId: request.id,
      customerId: request.customerId,
      amountCents,
      currency: 'USD',
      strategyUsed: this.strategy.name,
      notes:
        !request.servedWithinSla && amountCents === 0
          ? ['SLA violated but current plan does not penalize']
          : undefined,
    };

    // Notify listeners that a new invoice item is ready
    DomainEventBus.emit({
      type: 'INVOICE_ITEM_CREATED',
      payload: pricingResult,
    });

    // Additional event for SLA violations
    if (!request.servedWithinSla) {
      DomainEventBus.emit({
        type: 'SLA_VIOLATION',
        payload: {
          requestId: request.id,
          customerId: request.customerId,
          modelName: request.modelName,
          responseTimeMs: request.computeMs,
        },
      });
    }

    return pricingResult;
  }
}

/* ------------------------------------------------------------------ *
 *                     Convenience Factory Function                   *
 * ------------------------------------------------------------------ */

/**
 * High-level helper that instantiates the `InferencePricingService`
 * from raw configuration – useful for test harnesses or CLI tools.
 */
export const bootstrapPricingService = (
  cfg: PricingStrategyConfig,
): InferencePricingService => {
  const strategy = PricingStrategyFactory.build(cfg);
  return new InferencePricingService(strategy);
};

/* ------------------------------------------------------------------ *
 *                             Example                                *
 * ------------------------------------------------------------------ */

/**
 * The following snippet demonstrates how the *core* can be exercised
 * in isolation.  In real applications only adapters import Node.js
 * libs for logging, HTTP, or database connectivity.
 */
if (process.env.NODE_ENV === 'development') {
  // Subscribe to events (domain-level)
  DomainEventBus.on('INVOICE_ITEM_CREATED', (evt) =>
    console.log(`[DEV] Invoice item created:`, evt.payload),
  );
  DomainEventBus.on('SLA_VIOLATION', (evt) =>
    console.warn(`[DEV] SLA violation detected:`, evt.payload),
  );

  // Bootstrap service with a usage-based strategy
  const pricingSvc = bootstrapPricingService({
    key: 'USAGE',
    params: { msRateCents: 0.02, byteRateCents: 0.0001 },
  });

  // Run a sample request
  pricingSvc.price({
    id: randomUUID(),
    modelName: 'customer_churn_v2',
    computeMs: 357,
    payloadSizeBytes: 12_840,
    servedWithinSla: false,
    customerId: 'enterprise-acme-123',
  });
}
```