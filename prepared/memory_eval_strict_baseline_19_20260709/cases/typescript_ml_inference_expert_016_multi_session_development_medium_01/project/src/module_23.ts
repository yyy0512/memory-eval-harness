```typescript
/**************************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * File:        src/module_23.ts
 * Purpose:     Domain-level “Model Selector” using Strategy + Factory + Observer patterns.
 *               ‑ Supports A/B and Multi-Armed Bandit strategies for online inference traffic
 *                 splitting while emitting KPI drift events to downstream observers.
 *               ‑ Pure hexagonal code; no external IO concerns coupled in.
 **************************************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------- *
 * Domain Types                                                               *
 * -------------------------------------------------------------------------- */

/**
 * Lightweight representation of a model version as understood inside the hexagon.
 * (Concrete storage—e.g., MLFlow, S3—is delegated to Ports/Adapters elsewhere.)
 */
export interface ModelVersion {
  readonly id: string;               // Unique model identifier (e.g., UUID or registry path)
  readonly name: string;             // Human-friendly alias
  readonly metrics: Record<string, number>; // Historical evaluation metrics (accuracy, AUC, …)
  readonly trafficPercentage?: number;      // For Static A/B splits (0-100). Optional for Bandit
}

/**
 * Context forwarded with every inference request.
 * The selector uses it to ensure replay-safe, deterministic assignments.
 */
export interface RequestContext {
  readonly requestId: string;    // Correlates logs across hexagon layers
  readonly tenantId: string;     // Multi-tenant isolation
  readonly userId?: string;      // Enables user-stickiness in A/B splits
  readonly timestamp: Date;      // Required for timeseries KPI monitoring
  readonly custom?: Record<string, any>; // Free-form attributes (e.g., geo, appVersion)
}

/**
 * KPI snapshot adopted by Bandit strategies for online learning.
 */
export interface KPIStats {
  readonly modelId: string;
  readonly conversions: number;  // Business-metric events (e.g., purchases)
  readonly impressions: number;  // Denominator for conversion rate
}

/* -------------------------------------------------------------------------- *
 * Observer/Event Bus                                                         *
 * -------------------------------------------------------------------------- */

/**
 * Domain-level event names that ModelSelectorService may emit.
 */
export enum SelectorEvent {
  KPI_DRIFT = 'kpi_drift',
  MODEL_CHOSEN = 'model_chosen',
}

/**
 * Strongly-typed payloads baked into events.
 */
export interface KPIEventPayload {
  readonly modelId: string;
  readonly kpiName: string;
  readonly oldValue: number;
  readonly newValue: number;
  readonly driftRatio: number; // new / old
}

export interface ModelChosenPayload {
  readonly requestId: string;
  readonly chosenModelId: string;
  readonly strategy: string;
}

/**
 * Event bus that other hexagon services (alerting, dashboards, retraining triggers)
 * subscribe to. Inside the core we keep the dependency limited to Node's EventEmitter
 * to avoid leaking IO frameworks.
 */
export const selectorEventBus = new EventEmitter();

/* -------------------------------------------------------------------------- *
 * Strategy Pattern – Interface                                               *
 * -------------------------------------------------------------------------- */

export interface ModelSelectionStrategy {
  readonly name: string;

  /**
   * Pick a model for this inference request.
   * Implementations MUST be side-effect-free and deterministic given identical inputs.
   */
  selectModel(
    context: RequestContext,
    availableModels: readonly ModelVersion[],
  ): ModelVersion;

  /**
   * Optionally feed runtime KPI stats back into the selector.  No-ops for
   * deterministic (static) strategies like A/B.
   */
  updateKPIs?(stats: KPIStats): void;
}

/* -------------------------------------------------------------------------- *
 * Concrete Strategies                                                        *
 * -------------------------------------------------------------------------- */

/**
 * Simple sticky A/B split using userId (or requestId fallback) hashing.
 */
export class ABTestStrategy implements ModelSelectionStrategy {
  public readonly name = 'A/B';

  selectModel(
    context: RequestContext,
    availableModels: readonly ModelVersion[],
  ): ModelVersion {
    if (availableModels.length === 0) {
      throw new Error('[ABTestStrategy] No models configured.');
    }

    // Normalize traffic percentages; if missing we default to even splits.
    const fallbackPercentage = 100 / availableModels.length;
    const ranges: Array<{ model: ModelVersion; threshold: number }> = [];
    let cumulative = 0;

    for (const mv of availableModels) {
      const pct = mv.trafficPercentage ?? fallbackPercentage;
      cumulative += pct;
      ranges.push({ model: mv, threshold: cumulative });
    }

    if (Math.abs(cumulative - 100) > 1e-6) {
      throw new Error(
        `[ABTestStrategy] Traffic percentage does not sum to 100 (got ${cumulative}).`,
      );
    }

    // Sticky hash ensures same user → same model assignment
    const key = context.userId ?? context.requestId;
    const hashInt = this.deterministicHash(key);
    const bucket = (hashInt % 100) + 1; // 1-100 inclusive

    // Find first threshold ≥ bucket
    const chosen = ranges.find(r => bucket <= r.threshold);
    return chosen?.model ?? ranges[0].model; // Fallback never reached but TypeScript-safe
  }

  /* ------------------------  Helpers  ----------------------------------- */

  /**
   * Non-cryptographic integer hash for deterministic bucketing.
   * Source: adapted from Java’s String.hashCode() implementation.
   */
  private deterministicHash(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) {
      hash = (hash << 5) - hash + key.charCodeAt(i);
      hash |= 0; // Constrain to 32-bit int
    }
    return Math.abs(hash);
  }
}

/**
 * Multi-Armed Bandit using epsilon-greedy on conversion rate.
 * ‑ Each model is an arm.
 * ‑ ϵ controls exploration vs exploitation.
 */
export class EpsilonGreedyBanditStrategy implements ModelSelectionStrategy {
  public readonly name = 'EpsilonGreedyBandit';

  /** 0 ≤ epsilon ≤ 1.  Defaults to 0.1 (10 % exploration) */
  constructor(private readonly epsilon: number = 0.1) {
    if (epsilon < 0 || epsilon > 1) {
      throw new Error('[EpsilonGreedyBanditStrategy] epsilon must be within [0,1].');
    }
  }

  private readonly kpiTable: Map<string, KPIStats> = new Map();

  selectModel(
    context: RequestContext,
    availableModels: readonly ModelVersion[],
  ): ModelVersion {
    if (availableModels.length === 0) {
      throw new Error('[EpsilonGreedyBanditStrategy] No models configured.');
    }

    // Exploration: random model with probability epsilon
    if (Math.random() < this.epsilon) {
      return availableModels[Math.floor(Math.random() * availableModels.length)];
    }

    // Exploitation: pick the model with highest conversion rate
    let bestModel = availableModels[0];
    let bestRate = -Infinity;

    for (const mv of availableModels) {
      const stats = this.kpiTable.get(mv.id);
      const rate =
        stats && stats.impressions > 0
          ? stats.conversions / stats.impressions
          : 0; // Default 0 until we have data

      if (rate > bestRate) {
        bestRate = rate;
        bestModel = mv;
      }
    }

    return bestModel;
  }

  updateKPIs(stats: KPIStats): void {
    const existing = this.kpiTable.get(stats.modelId);
    if (!existing) {
      this.kpiTable.set(stats.modelId, { ...stats });
      return;
    }

    // Merge incremental stats
    const merged: KPIStats = {
      modelId: stats.modelId,
      conversions: existing.conversions + stats.conversions,
      impressions: existing.impressions + stats.impressions,
    };

    // Detect KPI drift (±20 % threshold)
    const oldRate =
      existing.impressions > 0 ? existing.conversions / existing.impressions : 0;
    const newRate =
      merged.impressions > 0 ? merged.conversions / merged.impressions : 0;

    if (oldRate > 0 && Math.abs(newRate - oldRate) / oldRate >= 0.2) {
      selectorEventBus.emit(SelectorEvent.KPI_DRIFT, <KPIEventPayload>{
        modelId: stats.modelId,
        kpiName: 'conversion_rate',
        oldValue: oldRate,
        newValue: newRate,
        driftRatio: newRate / oldRate,
      });
    }

    this.kpiTable.set(stats.modelId, merged);
  }
}

/* -------------------------------------------------------------------------- *
 * Factory Pattern – Instantiate Strategies                                   *
 * -------------------------------------------------------------------------- */

export type StrategyIdentifier = 'ab' | 'epsilon-greedy';

export interface StrategyFactoryOptions {
  readonly epsilon?: number; // For epsilon-greedy
}

export class ModelSelectionStrategyFactory {
  static create(
    id: StrategyIdentifier,
    opts: StrategyFactoryOptions = {},
  ): ModelSelectionStrategy {
    switch (id) {
      case 'ab':
        return new ABTestStrategy();
      case 'epsilon-greedy':
        return new EpsilonGreedyBanditStrategy(opts.epsilon ?? 0.1);
      default:
        throw new Error(`[StrategyFactory] Unsupported strategy id: ${id}`);
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Service (Hexagon Port)                                                     *
 * -------------------------------------------------------------------------- */

export class ModelSelectorService {
  constructor(
    private readonly strategy: ModelSelectionStrategy,
    private readonly eventBus: EventEmitter = selectorEventBus,
  ) {}

  /**
   * High-level operation used by InferencePort.
   * Returns ModelVersion that the adapter must load & execute externally.
   */
  chooseModel(
    context: Omit<RequestContext, 'requestId' | 'timestamp'> &
      Partial<Pick<RequestContext, 'requestId' | 'timestamp'>>,
    availableModels: readonly ModelVersion[],
  ): ModelVersion {
    // Enrich context with defaults
    const enrichedCtx: RequestContext = {
      requestId: context.requestId ?? randomUUID(),
      timestamp: context.timestamp ?? new Date(),
      ...context,
    };

    // Validate input models
    if (availableModels.length === 0) {
      throw new Error('[ModelSelectorService] availableModels is empty.');
    }

    const chosen = this.strategy.selectModel(enrichedCtx, availableModels);

    // Notify observers (dashboards, audit, etc.)
    this.eventBus.emit(SelectorEvent.MODEL_CHOSEN, <ModelChosenPayload>{
      requestId: enrichedCtx.requestId,
      chosenModelId: chosen.id,
      strategy: this.strategy.name,
    });

    return chosen;
  }

  /**
   * Pipe KPI feedback from external systems back into the strategy.
   * Primary use-case: bandit exploration.
   */
  ingestKPI(stats: KPIStats): void {
    if (typeof this.strategy.updateKPIs === 'function') {
      try {
        this.strategy.updateKPIs(stats);
      } catch (error) {
        // Wrap but re-throw to propagate failure upstream
        const wrapped = new Error(
          `[ModelSelectorService] updateKPIs failed: ${(error as Error).message}`,
        );
        (wrapped as any).cause = error;
        throw wrapped;
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Convenience Exports                                                        *
 * -------------------------------------------------------------------------- */

export const createDefaultModelSelector = (
  id: StrategyIdentifier = 'ab',
  opts?: StrategyFactoryOptions,
): ModelSelectorService =>
  new ModelSelectorService(ModelSelectionStrategyFactory.create(id, opts));

/**************************************************************************************************
 * End of file                                                                                    *
 **************************************************************************************************/
```