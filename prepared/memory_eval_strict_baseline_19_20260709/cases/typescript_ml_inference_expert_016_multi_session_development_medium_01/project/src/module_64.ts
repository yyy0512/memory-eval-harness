```typescript
/**************************************************************************************************
 * File:        src/module_64.ts
 * Project:     InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * Description: Domain-level revenue-strategy engine that applies Strategy & Factory patterns
 *              to calculate SLA-aware inference costs. An EventEmitter-based bus implements the
 *              Observer pattern so that consumers (billing ledgers, audit reporters, dashboards)
 *              can react to revenue events without tight coupling to core logic.
 *
 * NOTE: This file purposefully avoids any direct I/O (DBs, HTTP, message brokers, …); such
 *       integrations will be implemented by adapters outside the hexagon. All monetary values
 *       are expressed in smallest currency units (e.g., cents) to avoid floating-point drift.
 **************************************************************************************************/

import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                               Type Declarations                            */
/* -------------------------------------------------------------------------- */

/**
 * Built-in ISO-4217 currencies we explicitly support inside the core.
 * Anything else must be converted by an adapter before entering the hexagon.
 */
export type SupportedCurrency = 'USD' | 'EUR' | 'GBP';

export enum RevenueStrategyId {
  USAGE_BASED = 'USAGE_BASED',
  SUBSCRIPTION = 'SUBSCRIPTION',
  HYBRID = 'HYBRID', // Flat fee up to threshold, then usage-based
}

export interface RevenueCalculationParams {
  /** # of inference requests */
  inferenceCount: number;
  /** Average model latency in ms (for potential SLA surcharges) */
  averageLatencyMs: number;
  /** Uniquely identifies the model to allow differential pricing */
  modelName: string;
  modelVersion: string;
  /** Optional timestamp; defaults to now (UTC) */
  timestamp?: Date;
}

export interface RevenueSnapshot {
  /** Unique ID for correlating with external invoices */
  chargeId: string;
  /** Strategy in effect when the snapshot was produced */
  strategy: RevenueStrategyId;
  /** Total amount in minor units (e.g., cents) */
  amount: number;
  currency: SupportedCurrency;
  /** Additional granular cost information */
  breakdown: Record<string, number>;
  occurredAt: Date;
}

/* -------------------------------------------------------------------------- */
/*                               Custom Errors                                */
/* -------------------------------------------------------------------------- */

export class RevenueError extends Error {
  constructor(message: string) {
    super(`[RevenueError] ${message}`);
  }
}

/* -------------------------------------------------------------------------- */
/*                          Revenue Strategy Contracts                        */
/* -------------------------------------------------------------------------- */

export interface RevenueStrategy {
  readonly id: RevenueStrategyId;
  readonly currency: SupportedCurrency;
  describe(): string;
  /**
   * Calculates cost in minor currency units.
   */
  calculateCost(params: RevenueCalculationParams): RevenueSnapshot;
}

/* -------------------------------------------------------------------------- */
/*                             Strategy Implementations                       */
/* -------------------------------------------------------------------------- */

/**
 * PAYG model: cost = (per-inference rate) × (# of inferences).
 * SLA surcharges are applied based on latency thresholds.
 */
export class UsageBasedStrategy implements RevenueStrategy {
  public readonly id = RevenueStrategyId.USAGE_BASED;
  public readonly currency: SupportedCurrency = 'USD';

  private readonly perInferenceRate: number; // in minor units
  private readonly slaLatencyThresholdMs: number;
  private readonly slaSurchargePct: number;

  constructor({
    perInferenceRateCents = 2,
    slaLatencyThresholdMs = 500,
    slaSurchargePct = 0.10,
  }: {
    perInferenceRateCents?: number;
    slaLatencyThresholdMs?: number;
    slaSurchargePct?: number;
  } = {}) {
    this.perInferenceRate = perInferenceRateCents;
    this.slaLatencyThresholdMs = slaLatencyThresholdMs;
    this.slaSurchargePct = slaSurchargePct;
  }

  describe(): string {
    return `Usage-based pricing at $${(this.perInferenceRate / 100).toFixed(
      2,
    )} per inference. Latency > ${
      this.slaLatencyThresholdMs
    }ms incurs ${this.slaSurchargePct * 100}% surcharge.`;
  }

  calculateCost(params: RevenueCalculationParams): RevenueSnapshot {
    if (params.inferenceCount < 0) {
      throw new RevenueError('Inference count must be non-negative.');
    }

    const base = params.inferenceCount * this.perInferenceRate;

    // SLA surcharge for high latency
    const surcharge =
      params.averageLatencyMs > this.slaLatencyThresholdMs
        ? Math.round(base * this.slaSurchargePct)
        : 0;

    const total = base + surcharge;

    return {
      chargeId: uuid(),
      strategy: this.id,
      amount: total,
      currency: this.currency,
      breakdown: {
        base,
        slaSurcharge: surcharge,
      },
      occurredAt: params.timestamp ?? new Date(),
    };
  }
}

/**
 * Subscription model: flat monthly fee with a configurable inclusive usage
 * quota. Overages revert to PAYG rates.
 */
export class SubscriptionStrategy implements RevenueStrategy {
  public readonly id = RevenueStrategyId.SUBSCRIPTION;
  public readonly currency: SupportedCurrency = 'USD';

  private readonly monthlyFlatFee: number;
  private readonly inclusiveInferences: number;
  private readonly overageRate: number;

  constructor({
    monthlyFlatFeeCents = 50000, // $500
    inclusiveInferences = 500_000,
    overageRateCents = 1,
  }: {
    monthlyFlatFeeCents?: number;
    inclusiveInferences?: number;
    overageRateCents?: number;
  } = {}) {
    this.monthlyFlatFee = monthlyFlatFeeCents;
    this.inclusiveInferences = inclusiveInferences;
    this.overageRate = overageRateCents;
  }

  describe(): string {
    return `Subscription pricing: $${(this.monthlyFlatFee / 100).toFixed(
      2,
    )}/mo, includes ${this.inclusiveInferences.toLocaleString()} inferences. Overages billed at $${(
      this.overageRate / 100
    ).toFixed(2)} each.`;
  }

  calculateCost(params: RevenueCalculationParams): RevenueSnapshot {
    if (params.inferenceCount < 0) {
      throw new RevenueError('Inference count must be non-negative.');
    }

    const overage =
      Math.max(params.inferenceCount - this.inclusiveInferences, 0) *
      this.overageRate;

    const total = this.monthlyFlatFee + overage;

    return {
      chargeId: uuid(),
      strategy: this.id,
      amount: total,
      currency: this.currency,
      breakdown: {
        flatFee: this.monthlyFlatFee,
        overage,
      },
      occurredAt: params.timestamp ?? new Date(),
    };
  }
}

/**
 * Hybrid strategy: lower flat fee + overage; suitable for predictable but
 * fluctuating workloads. Demonstrates extensibility of the Factory pattern.
 */
export class HybridStrategy implements RevenueStrategy {
  public readonly id = RevenueStrategyId.HYBRID;
  public readonly currency: SupportedCurrency = 'USD';

  private readonly flatFee: number;
  private readonly baseQuota: number;
  private readonly usageRate: number;

  constructor({
    flatFeeCents = 15000, // $150
    baseQuota = 100_000,
    usageRateCents = 2,
  }: {
    flatFeeCents?: number;
    baseQuota?: number;
    usageRateCents?: number;
  } = {}) {
    this.flatFee = flatFeeCents;
    this.baseQuota = baseQuota;
    this.usageRate = usageRateCents;
  }

  describe(): string {
    return `Hybrid pricing: $${(this.flatFee / 100).toFixed(
      2,
    )} flat incl. ${this.baseQuota.toLocaleString()} inferences, then $${(
      this.usageRate / 100
    ).toFixed(2)} per additional inference.`;
  }

  calculateCost(params: RevenueCalculationParams): RevenueSnapshot {
    if (params.inferenceCount < 0) {
      throw new RevenueError('Inference count must be non-negative.');
    }

    const variable =
      Math.max(params.inferenceCount - this.baseQuota, 0) * this.usageRate;

    const total = this.flatFee + variable;

    return {
      chargeId: uuid(),
      strategy: this.id,
      amount: total,
      currency: this.currency,
      breakdown: {
        flatFee: this.flatFee,
        variable,
      },
      occurredAt: params.timestamp ?? new Date(),
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                             Strategy Factory                               */
/* -------------------------------------------------------------------------- */

type StrategyCtor<T extends RevenueStrategy> = new (options?: any) => T;

export class RevenueStrategyFactory {
  /**
   * Dynamically registers strategy constructors so that new strategies can be
   * added at runtime (e.g., via feature flags) without code changes here.
   */
  private readonly registry: Map<RevenueStrategyId, StrategyCtor<RevenueStrategy>> =
    new Map();

  constructor() {
    // Register built-ins
    this.register(RevenueStrategyId.USAGE_BASED, UsageBasedStrategy);
    this.register(RevenueStrategyId.SUBSCRIPTION, SubscriptionStrategy);
    this.register(RevenueStrategyId.HYBRID, HybridStrategy);
  }

  public register<T extends RevenueStrategy>(
    id: RevenueStrategyId,
    ctor: StrategyCtor<T>,
  ): void {
    if (this.registry.has(id)) {
      throw new RevenueError(
        `Strategy with id "${id}" is already registered.`,
      );
    }
    this.registry.set(id, ctor as StrategyCtor<RevenueStrategy>);
  }

  public create(
    id: RevenueStrategyId,
    options?: Record<string, unknown>,
  ): RevenueStrategy {
    const ctor = this.registry.get(id);
    if (!ctor) {
      throw new RevenueError(`Unknown strategy id "${id}".`);
    }
    return new ctor(options);
  }
}

/* -------------------------------------------------------------------------- */
/*                           Observer / Event Bus                             */
/* -------------------------------------------------------------------------- */

export enum RevenueEvent {
  CHARGE_CALCULATED = 'CHARGE_CALCULATED',
  STRATEGY_CHANGED = 'STRATEGY_CHANGED',
}

export interface RevenueChargeEventPayload {
  snapshot: RevenueSnapshot;
}

export interface RevenueStrategyChangedPayload {
  oldStrategy: RevenueStrategyId;
  newStrategy: RevenueStrategyId;
}

export class RevenueEventBus extends EventEmitter {
  emitCharge(snapshot: RevenueSnapshot): boolean {
    return this.emit(RevenueEvent.CHARGE_CALCULATED, { snapshot });
  }

  emitStrategyChange(
    oldStrategy: RevenueStrategyId,
    newStrategy: RevenueStrategyId,
  ): boolean {
    return this.emit(RevenueEvent.STRATEGY_CHANGED, {
      oldStrategy,
      newStrategy,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                          Revenue Strategy Service                          */
/* -------------------------------------------------------------------------- */

export class RevenueStrategyService {
  private currentStrategy: RevenueStrategy;
  private readonly factory: RevenueStrategyFactory;
  private readonly bus: RevenueEventBus;

  constructor({
    defaultStrategy = RevenueStrategyId.USAGE_BASED,
    factory = new RevenueStrategyFactory(),
    bus = new RevenueEventBus(),
  }: {
    defaultStrategy?: RevenueStrategyId;
    factory?: RevenueStrategyFactory;
    bus?: RevenueEventBus;
  } = {}) {
    this.factory = factory;
    this.bus = bus;
    this.currentStrategy = this.factory.create(defaultStrategy);
  }

  /**
   * Switches the active strategy at runtime. Observers are notified.
   */
  public switchStrategy(
    id: RevenueStrategyId,
    options?: Record<string, unknown>,
  ): void {
    const oldId = this.currentStrategy.id;
    this.currentStrategy = this.factory.create(id, options);
    this.bus.emitStrategyChange(oldId, id);
  }

  /**
   * Computes a charge and broadcasts the result to interested listeners.
   */
  public quote(
    params: RevenueCalculationParams,
    overrideOptions?: Record<string, unknown>,
  ): RevenueSnapshot {
    // Allow single-use strategy variance without state change
    const strategy = overrideOptions
      ? this.factory.create(this.currentStrategy.id, overrideOptions)
      : this.currentStrategy;

    const snapshot = strategy.calculateCost(params);

    this.bus.emitCharge(snapshot);

    return snapshot;
  }

  /**
   * Helper to introspect the currently active strategy.
   */
  public describeCurrentStrategy(): string {
    return this.currentStrategy.describe();
  }
}

/* -------------------------------------------------------------------------- */
/*                             Example Registration                           */
/* -------------------------------------------------------------------------- */

/*
 * The following demonstrates how adapters might hook into the event bus
 * without polluting domain logic. Remove or adjust in production.
 */

// Singleton-ish instance that adapters can import
export const revenueBus = new RevenueEventBus();
export const revenueService = new RevenueStrategyService({ bus: revenueBus });

/* Example Listener (would reside in an adapter layer) */
// revenueBus.on(
//   RevenueEvent.CHARGE_CALCULATED,
//   ({ snapshot }: RevenueChargeEventPayload) => {
//     console.log(
//       `[BillingLedger] Recorded charge ${snapshot.chargeId}: $${(
//         snapshot.amount / 100
//       ).toFixed(2)}`,
//     );
//   },
// );
```