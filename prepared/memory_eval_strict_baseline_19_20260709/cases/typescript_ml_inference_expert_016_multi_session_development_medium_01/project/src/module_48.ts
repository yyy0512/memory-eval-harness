```typescript
/**
 * InsightHexaAI
 * Strategic ML Inference Suite for Enterprise KPIs
 *
 * File: src/module_48.ts
 * Responsibility: Core domain service that performs real-time KPI inference.
 *                 Combines Strategy Pattern (model-selection), Observer Pattern
 *                 (KPI drift notifications), and Hexagonal Architecture (ports).
 */

import { randomUUID } from 'crypto'; // Node ≥ v14
// In real project, use @insighthexaai/logger; here we fallback to console
// import { Logger } from '@insighthexaai/logger';

/* ------------------------------------------------------------------ *
 *                         Domain & Utility Types                     *
 * ------------------------------------------------------------------ */

export type KPI =
  | 'customer_lifetime_value'
  | 'churn_risk_score'
  | 'upsell_propensity'
  | 'monthly_recurring_revenue';

export interface FeatureVector {
  readonly entityId: string;
  readonly timestamp: Date;
  readonly values: Record<string, number>;
}

export interface ModelMetadata {
  readonly id: string;
  readonly kpi: KPI;
  readonly version: string;
  readonly createdAt: Date;
  readonly tags: Record<string, string>;
  /** Expected input schema; could be JSON schema or simple list */
  readonly schema: string[];
  /** Additional opaque metadata used by strategies */
  readonly metrics: Record<string, number>;
}

export interface KPIResult {
  readonly requestId: string;
  readonly entityId: string;
  readonly kpi: KPI;
  readonly value: number;
  readonly modelId: string;
  readonly inferenceLatencyMs: number;
  readonly generatedAt: Date;
}

/* ------------------------------------------------------------------ *
 *                                Ports                               *
 * ------------------------------------------------------------------ */

/**
 * Port for retrieving features from the enterprise Feature Store.
 */
export interface FeatureStorePort {
  /**
   * Fetches real-time, SLA-compliant features for an entity.
   * Throws FeatureUnavailableError on failure.
   */
  getFeatures(entityId: string, schema: string[]): Promise<FeatureVector>;
}

/**
 * Port for querying the Model Registry for available candidates.
 */
export interface ModelRegistryPort {
  /**
   * Returns candidate models for a given KPI (active, production-ready).
   * Throws ModelNotFoundError when none exist.
   */
  getCandidateModels(kpi: KPI): Promise<ModelMetadata[]>;
}

/**
 * Port for actual inference execution; abstracts out frameworks (TF, Torch, ONNX).
 */
export interface InferenceEnginePort {
  /**
   * Runs prediction for given model & features. Returns prediction value.
   * Throws InferenceExecutionError on failure.
   */
  predict(model: ModelMetadata, features: FeatureVector): Promise<number>;
}

/**
 * Observer for KPI inference events (e.g., dashboards, alerting).
 */
export interface KpiObserverPort {
  notify(result: KPIResult): void;
}

/* ------------------------------------------------------------------ *
 *                           Error Classes                            *
 * ------------------------------------------------------------------ */

export class InsightHexaError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'InsightHexaError';
  }
}

export class FeatureUnavailableError extends InsightHexaError {
  constructor(entityId: string, cause?: Error) {
    super(`Features unavailable for entity ${entityId}`, cause);
    this.name = 'FeatureUnavailableError';
  }
}

export class ModelNotFoundError extends InsightHexaError {
  constructor(kpi: KPI) {
    super(`No candidate models found for KPI "${kpi}"`);
    this.name = 'ModelNotFoundError';
  }
}

export class InferenceExecutionError extends InsightHexaError {
  constructor(modelId: string, cause?: Error) {
    super(`Inference execution failed for model ${modelId}`, cause);
    this.name = 'InferenceExecutionError';
  }
}

/* ------------------------------------------------------------------ *
 *                        Strategy Pattern: Model Selection           *
 * ------------------------------------------------------------------ */

/**
 * Runtime context provided to selection strategies.
 */
export interface SelectionContext {
  readonly entityId: string;
  readonly kpi: KPI;
  /**
   * Additional optional context such as segment, geography,
   * or A/B assignment overrides.
   */
  readonly attributes?: Record<string, string | number>;
}

/**
 * Contract for selecting a model among candidates.
 */
export interface ModelSelectionStrategy {
  readonly name: string;
  selectModel(
    candidates: ModelMetadata[],
    context: SelectionContext,
  ): Promise<ModelMetadata>;
}

/* ---------------------------------- *
 *        A/B Testing Strategy        *
 * ---------------------------------- */

export class ABTestingStrategy implements ModelSelectionStrategy {
  public readonly name = 'ab_testing';

  /**
   * Simple deterministic hash-based assignment on entityId to provide
   * ~50/50 split between two top models. Can be extended to N-way.
   */
  async selectModel(
    candidates: ModelMetadata[],
    context: SelectionContext,
  ): Promise<ModelMetadata> {
    if (candidates.length === 0) {
      throw new ModelNotFoundError(context.kpi);
    }

    // Stable sort by version DESC; assume candidate[0], candidate[1] are A/B
    const sorted = [...candidates].sort(
      (a, b) => (b.version > a.version ? 1 : -1),
    );
    const hash = this.simpleHash(context.entityId);
    const index = hash % Math.min(2, sorted.length);
    return sorted[index];
  }

  private simpleHash(input: string): number {
    let h = 0;
    for (let i = 0; i < input.length; i++) {
      h = (h << 5) - h + input.charCodeAt(i);
      h |= 0; // Convert to 32-bit integer
    }
    return Math.abs(h);
  }
}

/* ---------------------------------- *
 *     Epsilon-Greedy Bandit Strategy *
 * ---------------------------------- */

export interface EpsilonGreedyConfig {
  epsilon: number; // 0 ≤ epsilon ≤ 1
}

export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  public readonly name = 'epsilon_greedy';
  private readonly epsilon: number;

  constructor(cfg: EpsilonGreedyConfig = { epsilon: 0.1 }) {
    if (cfg.epsilon < 0 || cfg.epsilon > 1) {
      throw new InsightHexaError('epsilon must be between 0 and 1');
    }
    this.epsilon = cfg.epsilon;
  }

  async selectModel(
    candidates: ModelMetadata[],
    context: SelectionContext,
  ): Promise<ModelMetadata> {
    if (candidates.length === 0) {
      throw new ModelNotFoundError(context.kpi);
    }

    // With probability epsilon, explore; otherwise, exploit best reward
    const explore = Math.random() < this.epsilon;
    if (explore) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Exploit: choose model with highest reward metric
    const sorted = [...candidates].sort(
      (a, b) => (b.metrics.reward || 0) - (a.metrics.reward || 0),
    );
    return sorted[0];
  }
}

/* ------------------------------------------------------------------ *
 *                   Factory Pattern: Strategy Factory                *
 * ------------------------------------------------------------------ */

export type StrategyName = 'ab_testing' | 'epsilon_greedy';

export class ModelSelectionStrategyFactory {
  static create(
    name: StrategyName,
    params?: Record<string, unknown>,
  ): ModelSelectionStrategy {
    switch (name) {
      case 'ab_testing':
        return new ABTestingStrategy();
      case 'epsilon_greedy':
        return new MultiArmedBanditStrategy(
          params as Partial<EpsilonGreedyConfig>,
        );
      default:
        throw new InsightHexaError(`Unknown strategy name: ${name}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 *                Core Domain Service: Real-Time Inference            *
 * ------------------------------------------------------------------ */

export interface RealTimeInferenceServiceConfig {
  readonly strategyName: StrategyName;
  readonly strategyParams?: Record<string, unknown>;
  readonly observers?: readonly KpiObserverPort[];
}

/**
 * Real-time KPI inference orchestrator.
 *
 * Ports are injected (constructor DI) to keep adapters outside the core.
 */
export class RealTimeInferenceService {
  private readonly strategy: ModelSelectionStrategy;
  private readonly observers: readonly KpiObserverPort[];

  constructor(
    private readonly featureStore: FeatureStorePort,
    private readonly modelRegistry: ModelRegistryPort,
    private readonly inferenceEngine: InferenceEnginePort,
    cfg: RealTimeInferenceServiceConfig,
  ) {
    this.strategy = ModelSelectionStrategyFactory.create(
      cfg.strategyName,
      cfg.strategyParams,
    );
    this.observers = cfg.observers ?? [];
  }

  /**
   * Executes end-to-end inference for requested KPI and notifies observers.
   * Returns KPIResult or throws InsightHexaError subclasses.
   */
  async infer(
    entityId: string,
    kpi: KPI,
    contextAttributes: Record<string, string | number> = {},
  ): Promise<KPIResult> {
    const selectionContext: SelectionContext = {
      entityId,
      kpi,
      attributes: contextAttributes,
    };

    // 1. Retrieve candidate models
    const candidates = await this.modelRegistry.getCandidateModels(kpi);

    // 2. Select model via strategy
    const model = await this.strategy.selectModel(candidates, selectionContext);

    // 3. Fetch features compatible with model schema
    const features = await this.safeGetFeatures(entityId, model.schema);

    // 4. Run inference
    const { prediction, latencyMs } = await this.safePredict(model, features);

    // 5. Build KPI result object
    const result: KPIResult = {
      requestId: randomUUID(),
      entityId,
      kpi,
      value: prediction,
      modelId: model.id,
      inferenceLatencyMs: latencyMs,
      generatedAt: new Date(),
    };

    // 6. Notify observers (non-blocking)
    this.observers.forEach((obs) => {
      try {
        obs.notify(result);
      } catch (e) {
        /* eslint-disable no-console */
        console.error(
          `[RealTimeInferenceService] Observer ${obs.constructor.name} errored:`,
          e,
        );
        /* eslint-enable no-console */
      }
    });

    return result;
  }

  /* ----------------------- *
   *    Helper Functions     *
   * ----------------------- */

  private async safeGetFeatures(
    entityId: string,
    schema: string[],
  ): Promise<FeatureVector> {
    try {
      return await this.featureStore.getFeatures(entityId, schema);
    } catch (e) {
      throw new FeatureUnavailableError(entityId, e as Error);
    }
  }

  private async safePredict(
    model: ModelMetadata,
    features: FeatureVector,
  ): Promise<{ prediction: number; latencyMs: number }> {
    const start = performance.now();
    try {
      const prediction = await this.inferenceEngine.predict(model, features);
      const latencyMs = performance.now() - start;
      return { prediction, latencyMs };
    } catch (e) {
      throw new InferenceExecutionError(model.id, e as Error);
    }
  }
}

/* ------------------------------------------------------------------ *
 *                            Mock Adapters                           *
 * ------------------------------------------------------------------ *
 * The following mock implementations serve purely for demonstration
 * and unit-testing. Production adapters would live in separate files
 * outside the hexagon.
 */

export class InMemoryFeatureStoreAdapter implements FeatureStorePort {
  constructor(private readonly store: Record<string, Record<string, number>>) {}

  async getFeatures(entityId: string, schema: string[]): Promise<FeatureVector> {
    const record = this.store[entityId];
    if (!record) {
      throw new FeatureUnavailableError(entityId);
    }
    // Filter only required schema keys
    const filtered: Record<string, number> = {};
    for (const key of schema) {
      if (!(key in record)) {
        throw new FeatureUnavailableError(
          entityId,
          new Error(`Missing feature key: ${key}`),
        );
      }
      filtered[key] = record[key];
    }
    return {
      entityId,
      timestamp: new Date(),
      values: filtered,
    };
  }
}

export class InMemoryModelRegistryAdapter implements ModelRegistryPort {
  constructor(private readonly models: ModelMetadata[]) {}

  async getCandidateModels(kpi: KPI): Promise<ModelMetadata[]> {
    return this.models.filter((m) => m.kpi === kpi);
  }
}

export class LocalInferenceEngineAdapter implements InferenceEnginePort {
  // For demo purposes, we use a dummy inference function
  async predict(model: ModelMetadata, features: FeatureVector): Promise<number> {
    // naive dot product with feature values & pseudo weights
    let score = 0;
    for (const key of model.schema) {
      score += (features.values[key] ?? 0) * 0.01;
    }
    return score;
  }
}

export class ConsoleObserverAdapter implements KpiObserverPort {
  /* eslint-disable no-console */
  notify(result: KPIResult): void {
    console.info(
      `[ConsoleObserver] KPI ${result.kpi} = ${result.value.toFixed(
        4,
      )} for entity ${result.entityId} (model=${result.modelId})`,
    );
  }
  /* eslint-enable no-console */
}
```