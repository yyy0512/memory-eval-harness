```typescript
/******************************************************************************
 * File:        src/module_46.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Pricing engine (hexagon-core) that calculates the monetary
 *              impact of each inference request, delegating to pluggable
 *              Strategy_Pattern implementations (usage, subscription, tiered).
 *              The engine doubles as an Observable, pushing real-time pricing
 *              events to downstream adapters (e.g., Kafka → billing ledger,
 *              WebSocket → finance dashboard).
 * Author:      InsightHexaAI Core Team
 ******************************************************************************/

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------- */
/*                                 Interfaces                                 */
/* -------------------------------------------------------------------------- */

/**
 * A distilled view of an inference execution used for billing.
 */
export interface InferenceUsage {
  /** Globally-unique request identifier */
  readonly requestId: string;
  /** Owning customer account */
  readonly accountId: string;
  /** Name or ID of the model invoked */
  readonly modelName: string;
  /** Unix epoch (ms) */
  readonly startedAt: number;
  /** Unix epoch (ms) */
  readonly finishedAt: number;
  /** Number of records scored in this inference */
  readonly records: number;
  /** Total vCPU-seconds consumed by the backend during the request */
  readonly cpuSeconds: number;
  /** SLA tier purchased by the customer */
  readonly slaTier: 'standard' | 'premium' | 'enterprise';
}

/**
 * A normalized pricing output that will feed downstream invoicing systems.
 */
export interface PricingSummary {
  readonly requestId: string;
  readonly accountId: string;
  /** Cost before discounts & taxes */
  readonly rawCostUsd: number;
  /** Final amount after promotional discounts, if any */
  readonly netCostUsd: number;
  /** Human-readable reason explaining pricing calculation */
  readonly narrative: string;
}

/**
 * Strategy contract for new pricing models.
 */
export interface PricingStrategy {
  readonly name: string;
  calculateCost(usage: InferenceUsage): PricingSummary;
}

/* -------------------------------------------------------------------------- */
/*                          Strategy Implementations                          */
/* -------------------------------------------------------------------------- */

/**
 * Pure usage-based billing: customers pay per vCPU-second and per record.
 */
export class UsageBasedPricingStrategy implements PricingStrategy {
  public readonly name = 'usage-based';

  constructor(
    private readonly pricePerCpuSecondUsd: number,
    private readonly pricePerRecordUsd: number
  ) {}

  calculateCost(usage: InferenceUsage): PricingSummary {
    const cpuCost   = usage.cpuSeconds * this.pricePerCpuSecondUsd;
    const recordCost = usage.records * this.pricePerRecordUsd;
    const rawCost   = cpuCost + recordCost;

    return {
      requestId: usage.requestId,
      accountId: usage.accountId,
      rawCostUsd: round(rawCost),
      netCostUsd: round(rawCost), // No discounts in this plan
      narrative: `Usage: ${usage.cpuSeconds} CPU-s @ $${this.pricePerCpuSecondUsd}/s + ` +
                 `${usage.records} recs @ $${this.pricePerRecordUsd}/rec`
    };
  }
}

/**
 * Flat subscription model with optional overage for SLA breaches.
 */
export class SubscriptionPricingStrategy implements PricingStrategy {
  public readonly name = 'subscription';

  constructor(
    private readonly monthlyFlatUsd: number,
    private readonly includedRecords: number,
    private readonly overagePerRecordUsd: number
  ) {}

  calculateCost(usage: InferenceUsage): PricingSummary {
    const overageRecords = Math.max(0, usage.records - this.includedRecords);
    const overageCost    = overageRecords * this.overagePerRecordUsd;
    const rawCost = overageCost; // Flat fee handled elsewhere (monthly invoice)

    return {
      requestId: usage.requestId,
      accountId: usage.accountId,
      rawCostUsd: round(rawCost),
      netCostUsd: round(rawCost),
      narrative: overageRecords
        ? `Overage: ${overageRecords} recs @ $${this.overagePerRecordUsd}/rec beyond ` +
          `${this.includedRecords} recs/month subscription`
        : 'Within subscription allowance'
    };
  }
}

/**
 * Tiered pricing model that rewards volume.
 */
export class TieredPricingStrategy implements PricingStrategy {
  public readonly name = 'tiered';

  constructor(
    /**
     * Map of record threshold → price per record, e.g.
     * { 10000: 0.002, 50000: 0.0015, Infinity: 0.001 }
     */
    private readonly tiers: Record<number, number>
  ) {
    // Validate tier keys are numeric, ascending
    const invalid = Object.keys(tiers)
      .map(Number)
      .some((n) => Number.isNaN(n) || n <= 0);
    if (invalid) {
      throw new Error('[TieredPricingStrategy] Tier keys must be positive numbers or Infinity');
    }
  }

  calculateCost(usage: InferenceUsage): PricingSummary {
    const pricePerRecord = this.getUnitPrice(usage.records);
    const rawCost = usage.records * pricePerRecord;

    return {
      requestId: usage.requestId,
      accountId: usage.accountId,
      rawCostUsd: round(rawCost),
      netCostUsd: round(rawCost),
      narrative: `Tiered: ${usage.records} recs @ $${pricePerRecord}/rec`
    };
  }

  private getUnitPrice(records: number): number {
    // Find the smallest tier threshold >= records
    const thresholds = Object.keys(this.tiers).map(Number).sort((a, b) => a - b);
    for (const threshold of thresholds) {
      if (records <= threshold) return this.tiers[threshold];
    }
    // Fallback to max tier (Infinity)
    return this.tiers[Infinity];
  }
}

/* -------------------------------------------------------------------------- */
/*                             Strategy Factory                               */
/* -------------------------------------------------------------------------- */

export type PricingStrategyConfig =
  | {
      type: 'usage-based';
      pricePerCpuSecondUsd: number;
      pricePerRecordUsd: number;
    }
  | {
      type: 'subscription';
      monthlyFlatUsd: number;
      includedRecords: number;
      overagePerRecordUsd: number;
    }
  | {
      type: 'tiered';
      tiers: Record<number, number>;
    };

/**
 * Factory responsible for converting configuration objects into
 * executable strategy instances.
 */
export class PricingStrategyFactory {
  static create(config: PricingStrategyConfig): PricingStrategy {
    switch (config.type) {
      case 'usage-based':
        return new UsageBasedPricingStrategy(
          config.pricePerCpuSecondUsd,
          config.pricePerRecordUsd
        );
      case 'subscription':
        return new SubscriptionPricingStrategy(
          config.monthlyFlatUsd,
          config.includedRecords,
          config.overagePerRecordUsd
        );
      case 'tiered':
        return new TieredPricingStrategy(config.tiers);
      default:
        // Exhaustiveness check
        const never: never = config;
        throw new Error(`[PricingStrategyFactory] Unsupported strategy: ${never}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                               Event System                                 */
/* -------------------------------------------------------------------------- */

/**
 * Event names emitted by the PricingEngine.
 */
export enum PricingEngineEvent {
  PRICE_COMPUTED = 'PRICE_COMPUTED',
  ERROR = 'ERROR'
}

/**
 * Shape of events emitted on success.
 */
export interface PriceComputedEvent {
  type: PricingEngineEvent.PRICE_COMPUTED;
  payload: PricingSummary;
}

/**
 * Shape of events emitted on failure.
 */
export interface PriceErrorEvent {
  type: PricingEngineEvent.ERROR;
  payload: { requestId: string; error: Error };
}

type PricingEngineEvents = PriceComputedEvent | PriceErrorEvent;

/* -------------------------------------------------------------------------- */
/*                               Pricing Engine                               */
/* -------------------------------------------------------------------------- */

/**
 * Central service invoked by the model-serving adapter once each inference
 * finishes.  The engine applies the configured strategy and broadcasts the
 * result via Node’s EventEmitter (Observer_Pattern), allowing asphalt-layer
 * adapters (Kafka, Snowflake Loader, etc.) to subscribe independently.
 */
export class PricingEngine extends EventEmitter {
  private readonly strategy: PricingStrategy;

  constructor(config: PricingStrategyConfig) {
    super();
    this.strategy = PricingStrategyFactory.create(config);
  }

  /**
   * Compute the cost of a single inference and emit events for observers.
   *
   * @param usage Inference usage context passed by the serving infrastructure
   */
  public processUsage(usage: InferenceUsage): void {
    try {
      const summary = this.strategy.calculateCost(usage);
      this.emitEvent({
        type: PricingEngineEvent.PRICE_COMPUTED,
        payload: summary
      });
    } catch (err) {
      const error = toError(err);
      this.emitEvent({
        type: PricingEngineEvent.ERROR,
        payload: { requestId: usage.requestId, error }
      });
    }
  }

  /**
   * Internal helper to ensure correct typing of emitted events.
   */
  private emitEvent<E extends PricingEngineEvents>(event: E): void {
    this.emit(event.type, event);
  }
}

/* -------------------------------------------------------------------------- */
/*                              Util Functions                                */
/* -------------------------------------------------------------------------- */

function round(value: number, decimal: number = 4): number {
  const factor = Math.pow(10, decimal);
  return Math.round(value * factor) / factor;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
```