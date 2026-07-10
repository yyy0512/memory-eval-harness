```typescript
/***************************************************************************************************
 * File:        src/module_70.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Domain-level Model-Version-Selection service (inside the hexagon). Implements the
 *              Strategy & Factory patterns to dynamically choose between different model-selection
 *              strategies (A/B, Multi-Armed Bandit, etc.). The service listens to real-time metric
 *              updates (Observer pattern) and routes inference requests to the most profitable
 *              model version while delegating I/O to ports (hexagonal architecture).
 ***************************************************************************************************/

import { random, sample } from 'lodash'; // Small, treeshake-friendly utility helpers.

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Domain Types
 * ────────────────────────────────────────────────────────────────────────────────
 */

/** Business-relevant metrics gathered for each model version. */
export interface ModelStatistics {
  totalPredictions: number;
  successfulPredictions: number;          // Domain definition of “success” comes from business.
  cumulativeRevenue: number;              // Direct revenue attributed to this model version.
  lastUpdated: Date;
}

/** Aggregate information about a concrete model artefact. */
export interface ModelVersion {
  id: string;                             // UUID from Model Registry
  versionName: string;                    // Human-friendly semantic version (e.g. “v1.2.0”)
  metadata: Record<string, unknown>;      // Arbitrary metadata provided by upstream pipelines.
  stats: ModelStatistics;                 // Mutable statistics updated by Observers.
}

/** Contextual information available during an inference request. */
export interface PredictionContext {
  tenantId: string;                       // Multi-tenant SaaS deployment support.
  featuresHash: string;                   // Deterministic hash of preprocessed feature vector.
  /**
   * Additional contextual information (geo, device, pricing tier, etc.). Keep it generic so
   * we do NOT change the domain service whenever a new business unit adds attributes.
   */
  extras?: Record<string, unknown>;
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Hexagonal Ports (Domain Interfaces)
 * ────────────────────────────────────────────────────────────────────────────────
 */

/**
 * Reads/writes model metadata from/to the Model Registry. The interface hides
 * implementation specifics (e.g., MLflow, SageMaker, proprietary DB).
 */
export interface ModelRegistryPort {
  loadCandidateModels(modelFamily: string): Promise<ModelVersion[]>;
  markModelAsProduction(modelId: string): Promise<void>;
  updateStatistics(modelId: string, stats: Partial<ModelStatistics>): Promise<void>;
}

/**
 * Supplies domain metrics (conversion rate, revenue) that originate from external
 * monitoring/observation services. Notice how domain logic stays free of any HTTP/Kafka code.
 */
export interface MetricsPort {
  getConversionRate(modelId: string): Promise<number>;
  getRevenue(modelId: string): Promise<number>;
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Strategy Pattern – Model Selection
 * ────────────────────────────────────────────────────────────────────────────────
 */

export enum SelectionStrategyType {
  AB_TEST = 'AB_TEST',
  MULTI_ARMED_BANDIT = 'MULTI_ARMED_BANDIT',
  FALLBACK = 'FALLBACK',                  // Always choose a configured default.
}

/** Contract every model-selection strategy must follow. */
export interface SelectionStrategy {
  readonly type: SelectionStrategyType;
  selectModel(
    candidates: ModelVersion[],
    context: PredictionContext
  ): Promise<ModelVersion>;
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Concrete Strategy #1 – A/B Testing (static allocation percentages)
 * ────────────────────────────────────────────────────────────────────────────────
 */

export class ABTestStrategy implements SelectionStrategy {
  public readonly type = SelectionStrategyType.AB_TEST;

  /**
   * Each modelId → allocation percentage (0-100). Injected at runtime via config service.
   * Example: { 'model-A': 75, 'model-B': 25 }.
   */
  constructor(private readonly trafficAllocation: Record<string, number>) {}

  async selectModel(
    candidates: ModelVersion[],
    _context: PredictionContext,
  ): Promise<ModelVersion> {
    if (candidates.length === 0) {
      throw new Error('[ABTestStrategy] Candidate list is empty.');
    }

    // Normalize percentages & perform weighted random sampling.
    const allocationSum = Object.values(this.trafficAllocation).reduce((a, b) => a + b, 0);
    if (allocationSum === 0) {
      throw new Error('[ABTestStrategy] Allocation percentages sum to zero.');
    }

    const r = random(0, allocationSum, false);
    let cumulative = 0;
    for (const model of candidates) {
      const weight = this.trafficAllocation[model.id] ?? 0;
      cumulative += weight;
      if (r <= cumulative) {
        return model;
      }
    }

    // Fallback (should rarely occur due to rounding errors).
    return candidates[0];
  }
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Concrete Strategy #2 – Multi-Armed Bandit (epsilon-greedy variant)
 * ────────────────────────────────────────────────────────────────────────────────
 */

export interface BanditConfig {
  epsilon: number; // Exploration factor (0–1). Higher value means more random exploration.
}

export class MultiArmedBanditStrategy implements SelectionStrategy {
  public readonly type = SelectionStrategyType.MULTI_ARMED_BANDIT;

  constructor(
    private readonly metricsPort: MetricsPort,
    private readonly config: BanditConfig,
  ) {}

  /**
   * Epsilon-greedy algorithm:
   *  – With probability ε, choose a random model (exploration).
   *  – Otherwise, choose the model with highest observed reward (exploitation).
   * Reward can be conversion rate, revenue, or any scalar KPI important to the business.
   */
  async selectModel(
    candidates: ModelVersion[],
    _context: PredictionContext,
  ): Promise<ModelVersion> {
    if (candidates.length === 0) {
      throw new Error('[MultiArmedBanditStrategy] Candidate list is empty.');
    }

    const explore = Math.random() < this.config.epsilon;

    if (explore) {
      // Pure exploration: pick any model at random.
      return sample(candidates) as ModelVersion;
    }

    // Exploitation: pick model with highest reward.
    let bestModel: ModelVersion | null = null;
    let bestReward = -Infinity;

    for (const model of candidates) {
      try {
        // Customizable reward function – here we choose revenue per prediction.
        const revenue = await this.metricsPort.getRevenue(model.id);
        const totalPredictions = model.stats.totalPredictions || 1;
        const reward = revenue / totalPredictions;

        if (reward > bestReward) {
          bestReward = reward;
          bestModel = model;
        }
      } catch (err) {
        // Metrics might be missing if the model is brand new; ignore & keep searching.
        continue;
      }
    }

    return bestModel ?? (sample(candidates) as ModelVersion);
  }
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Concrete Strategy #3 – Fallback (always pick default production model)
 * ────────────────────────────────────────────────────────────────────────────────
 */

export class FallbackStrategy implements SelectionStrategy {
  public readonly type = SelectionStrategyType.FALLBACK;

  constructor(private readonly defaultModelId: string) {}

  async selectModel(
    candidates: ModelVersion[],
    _context: PredictionContext,
  ): Promise<ModelVersion> {
    const hit = candidates.find(c => c.id === this.defaultModelId);
    if (!hit) {
      throw new Error(
        `[FallbackStrategy] Default model '${this.defaultModelId}' not found in candidate list.`,
      );
    }
    return hit;
  }
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Factory Pattern – Produces Strategy Instances Based on Configuration
 * ────────────────────────────────────────────────────────────────────────────────
 */

export interface StrategyFactoryDeps {
  metricsPort: MetricsPort;
  // Additional dependencies (Feature flags service, Config service, etc.) can be added here.
}

export class SelectionStrategyFactory {
  constructor(private readonly deps: StrategyFactoryDeps) {}

  create(
    type: SelectionStrategyType,
    config?: unknown, // Strategy-specific configuration typed at callsite.
  ): SelectionStrategy {
    switch (type) {
      case SelectionStrategyType.AB_TEST:
        if (!config || typeof config !== 'object') {
          throw new Error('[SelectionStrategyFactory] AB_TEST config missing.');
        }
        return new ABTestStrategy(config as Record<string, number>);

      case SelectionStrategyType.MULTI_ARMED_BANDIT:
        return new MultiArmedBanditStrategy(
          this.deps.metricsPort,
          (config || { epsilon: 0.1 }) as BanditConfig,
        );

      case SelectionStrategyType.FALLBACK:
        if (typeof config !== 'string') {
          throw new Error('[SelectionStrategyFactory] FALLBACK defaultModelId missing.');
        }
        return new FallbackStrategy(config);

      default:
        throw new Error(`[SelectionStrategyFactory] Unknown strategy type: ${String(type)}`);
    }
  }
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Observer Pattern – Domain Event for Metric Updates
 * ────────────────────────────────────────────────────────────────────────────────
 */

export interface MetricsObserver {
  /** Invoked whenever model-specific KPI data is updated. */
  onMetricsUpdate(modelId: string, stats: Partial<ModelStatistics>): Promise<void>;
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Domain Service – ModelSelectorService
 * ────────────────────────────────────────────────────────────────────────────────
 */

export interface ModelSelectorOptions {
  strategyType: SelectionStrategyType;
  strategyConfig?: unknown;
  modelFamily: string; // e.g., "customer-churn-predictor".
}

/**
 * High-level domain service discovered by the hexagon. All I/O (DB, HTTP) is delegated
 * to ports. The service is stateless & thus easy to test in isolation.
 */
export class ModelSelectorService implements MetricsObserver {
  private strategy: SelectionStrategy | null = null;

  constructor(
    private readonly registry: ModelRegistryPort,
    private readonly strategyFactory: SelectionStrategyFactory,
    private readonly opts: ModelSelectorOptions,
  ) {}

  /** Lazily create the strategy because dependencies like MetricsPort may be async. */
  private get selectionStrategy(): SelectionStrategy {
    if (!this.strategy) {
      this.strategy = this.strategyFactory.create(
        this.opts.strategyType,
        this.opts.strategyConfig,
      );
    }
    return this.strategy;
  }

  /**
   * Choose the best model for the given context, update production flag in the
   * Model Registry (side effect), and return the selected model.
   */
  async selectBestModel(context: PredictionContext): Promise<ModelVersion> {
    const candidates = await this.registry.loadCandidateModels(this.opts.modelFamily);
    if (candidates.length === 0) {
      throw new Error(
        `[ModelSelectorService] No candidate models found for family '${this.opts.modelFamily}'.`,
      );
    }

    const winner = await this.selectionStrategy.selectModel(candidates, context);

    // Optionally mark the chosen model as production (depends on business logic).
    await this.registry.markModelAsProduction(winner.id).catch(err => {
      // Best effort: we may still return the model to caller even if the registry update fails.
      console.error(
        `[ModelSelectorService] Failed to mark model '${winner.id}' as production:`,
        err,
      );
    });

    return winner;
  }

  /*
   * ────────────────────────────────────────────────────────────────────────────
   * Observer Implementation – keeps local cache up-to-date when metrics change.
   * ────────────────────────────────────────────────────────────────────────────
   */

  async onMetricsUpdate(
    modelId: string,
    stats: Partial<ModelStatistics>,
  ): Promise<void> {
    try {
      await this.registry.updateStatistics(modelId, stats);
    } catch (err) {
      // Do not rethrow – metrics updates should never bring down the service.
      console.warn(
        `[ModelSelectorService] Unable to persist stats for model '${modelId}':`,
        err,
      );
    }
  }
}

/*
 * ────────────────────────────────────────────────────────────────────────────────
 * Convenience Builder (usage example)
 * ────────────────────────────────────────────────────────────────────────────────
 */

export function buildDefaultModelSelector(
  registry: ModelRegistryPort,
  metrics: MetricsPort,
): ModelSelectorService {
  const factory = new SelectionStrategyFactory({ metricsPort: metrics });

  const selector = new ModelSelectorService(registry, factory, {
    strategyType: SelectionStrategyType.MULTI_ARMED_BANDIT,
    strategyConfig: { epsilon: 0.15 } satisfies BanditConfig,
    modelFamily: 'customer-lifetime-value',
  });

  return selector;
}

/***************************************************************************************************
 * End of file
 ***************************************************************************************************/
```