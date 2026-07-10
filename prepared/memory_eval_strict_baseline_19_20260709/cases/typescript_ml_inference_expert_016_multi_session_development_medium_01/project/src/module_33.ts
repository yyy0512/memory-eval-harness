```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * File:        src/module_33.ts
 * Module:      Model Versioning  ➜  Strategy-Driven Model Selector + Observer Notifications
 * Description: Implements Strategy-Pattern–driven model-selection logic that chooses which model
 *              version should serve production traffic.  A hexagonal port (ModelRegistryPort)
 *              decouples the selector from any concrete model registry (S3, MLflow, etc.).
 *              The module also supports the Observer-Pattern, so that interested adapters
 *              (dashboards, alerting, audit logs) can subscribe to model-switch events.
 *
 * Author:      InsightHexaAI Engineering
 ***************************************************************************************************/

import { randomUUID } from 'crypto'; // Node-built-in: unique event IDs
import * as _ from 'lodash';         // Utility helpers (ensure you have @types/lodash in dev-deps)

/* -------------------------------------------------------------------------------------------------
 * Domain Types
 * -----------------------------------------------------------------------------------------------*/

/**
 * Immutable metadata for one model version living in the registry.
 */
export interface ModelMetadata {
  readonly modelId: string;                 // e.g. “customer-churn-xgboost”
  readonly version: string;                 // semantic version or runId, e.g. “1.2.4”
  readonly createdAt: Date;
  readonly metrics: Record<string, number>; // arbitrary metric bag (ROC_AUC, RMSE, etc.)
  readonly tags: string[];                  // domain tags, e.g. [“production”, “ab_test”]
  readonly trafficPercentage?: number;      // current prod traffic share (0-100)
}

/**
 * Context in which the selection takes place—derived from run-time factors.
 */
export interface SelectionContext {
  readonly kpi?: string;                    // e.g. “gross_margin”, “nps”
  readonly userSegment?: string;            // e.g. “enterprise”, “smb”, “freemium”
  readonly regulatoryRegion?: string;       // e.g. “EU”, “US”, “APAC”
  readonly time: Date;                      // evaluation timestamp
  // Additional fields can be slotted in without breaking callers.
}

/**
 * Event emitted whenever the active production model version changes.
 */
export interface ModelSwitchEvent {
  readonly id: string;                // UUID for traceability
  readonly timestamp: Date;
  readonly oldVersion?: ModelMetadata;
  readonly newVersion: ModelMetadata;
  readonly reason: string;            // human-readable explanation
}

/* -------------------------------------------------------------------------------------------------
 * Hexagonal Port (Outbound) – Model Registry
 * -----------------------------------------------------------------------------------------------*/

/**
 * Pure domain port that any infrastructure adapter must implement.
 */
export interface ModelRegistryPort {
  /**
   * Return all candidate versions for a given logical model.
   */
  listModelVersions(modelId: string): Promise<ModelMetadata[]>;

  /**
   * Mark one version as “active.” Concrete implementation may shift traffic, tag, etc.
   */
  promoteToProduction(model: ModelMetadata): Promise<void>;

  /**
   * (Optional) Record a model switch event inside the registry or audit system.
   */
  logModelSwitch?(event: ModelSwitchEvent): Promise<void>;
}

/* -------------------------------------------------------------------------------------------------
 * Strategy Pattern – Model Selection
 * -----------------------------------------------------------------------------------------------*/

/**
 * Strategic interface for selecting which model version becomes (or remains) production.
 */
export interface ModelSelectionStrategy {
  readonly name: string;

  /**
   * Pick the champion model from a list of candidates.
   */
  select(
    candidates: ModelMetadata[],
    ctx: SelectionContext
  ): Promise<ModelMetadata>;
}

/**
 * A/B testing: randomly split traffic according to pre-defined percentages.
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
  public readonly name = 'ABTestingStrategy';

  async select(
    candidates: ModelMetadata[],
    _: SelectionContext
  ): Promise<ModelMetadata> {
    // Filter down to versions that have traffic percentage configured.
    const withTraffic = candidates.filter(c => c.trafficPercentage && c.trafficPercentage > 0);
    if (_.isEmpty(withTraffic)) {
      throw new Error('[ABTestingStrategy] No candidates have trafficPercentage set.');
    }

    const rand = Math.random() * 100;
    let cumulative = 0;
    for (const cand of withTraffic) {
      cumulative += cand.trafficPercentage!;
      if (rand <= cumulative) {
        return cand;
      }
    }
    // Fallback to the last candidate (shouldn’t normally happen due to rounding).
    return _.last(withTraffic)!;
  }
}

/**
 * Champion-Challenger: choose challenger if its main metric surpasses champion by threshold.
 */
export class ChampionChallengerStrategy implements ModelSelectionStrategy {
  public readonly name = 'ChampionChallengerStrategy';
  private readonly metric: string;
  private readonly improvementThreshold: number;

  constructor(params: { metric: string; improvementThreshold: number }) {
    this.metric = params.metric;
    this.improvementThreshold = params.improvementThreshold;
  }

  async select(
    candidates: ModelMetadata[],
    _: SelectionContext
  ): Promise<ModelMetadata> {
    const champion = candidates.find(c => c.tags.includes('production'));
    if (!champion) {
      throw new Error('[ChampionChallengerStrategy] No current production candidate found.');
    }

    const challenger = _.maxBy(
      candidates.filter(c => c.version !== champion.version),
      c => c.metrics[this.metric] ?? -Infinity
    );

    if (
      challenger &&
      (challenger.metrics[this.metric] ?? 0) >
        (champion.metrics[this.metric] ?? 0) * (1 + this.improvementThreshold)
    ) {
      return challenger;
    }
    return champion;
  }
}

/**
 * Multi-Armed Bandit (ε-greedy): explore with ε, exploit best candidate otherwise.
 */
export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  public readonly name = 'MultiArmedBanditStrategy';
  private readonly metric: string;
  private readonly epsilon: number;

  constructor(params: { metric: string; epsilon?: number }) {
    this.metric = params.metric;
    this.epsilon = params.epsilon ?? 0.1;
  }

  async select(
    candidates: ModelMetadata[],
    _: SelectionContext
  ): Promise<ModelMetadata> {
    if (_.isEmpty(candidates)) {
      throw new Error('[MABStrategy] No candidates supplied.');
    }

    // Exploration
    if (Math.random() < this.epsilon) {
      return _.sample(candidates)!;
    }

    // Exploitation
    const best = _.maxBy(candidates, c => c.metrics[this.metric] ?? -Infinity);
    if (!best) {
      // Fallback to random if metric is missing
      return _.sample(candidates)!;
    }
    return best;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Factory Pattern – Strategy Factory
 * -----------------------------------------------------------------------------------------------*/

export type StrategyType = 'ab_test' | 'champion_challenger' | 'multi_armed_bandit';

export interface StrategyConfig {
  type: StrategyType;
  params?: Record<string, unknown>;
}

/**
 * Translates runtime configuration into instantiated strategy objects.
 */
export class ModelSelectionStrategyFactory {
  static create(config: StrategyConfig): ModelSelectionStrategy {
    switch (config.type) {
      case 'ab_test':
        return new ABTestingStrategy();
      case 'champion_challenger':
        return new ChampionChallengerStrategy({
          metric: (config.params?.metric as string) || 'roc_auc',
          improvementThreshold: (config.params?.improvementThreshold as number) || 0.02,
        });
      case 'multi_armed_bandit':
        return new MultiArmedBanditStrategy({
          metric: (config.params?.metric as string) || 'roc_auc',
          epsilon: (config.params?.epsilon as number) ?? 0.05,
        });
      default:
        throw new Error(`[ModelSelectionStrategyFactory] Unknown strategy: ${config.type}`);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Observer Pattern – Event Subscribers
 * -----------------------------------------------------------------------------------------------*/

export interface ModelVersioningObserver {
  onSwitch(event: ModelSwitchEvent): Promise<void>;
}

/**
 * Example observer that simply logs to stdout (could be replaced by Winston / Datadog, etc.)
 */
export class ConsoleLoggingObserver implements ModelVersioningObserver {
  async onSwitch(event: ModelSwitchEvent): Promise<void> {
    // In production you may wire this into a structured logger.
    // eslint-disable-next-line no-console
    console.info(
      `[ModelVersioning] Switch Event ${event.id} at ${event.timestamp.toISOString()}: ` +
        `${event.oldVersion?.version ?? 'none'} → ${event.newVersion.version} (${event.reason})`
    );
  }
}

/* -------------------------------------------------------------------------------------------------
 * Application Service – ModelVersioningService
 * -----------------------------------------------------------------------------------------------*/

export class ModelVersioningService {
  private readonly registry: ModelRegistryPort;
  private readonly observers: Set<ModelVersioningObserver>;
  private strategy: ModelSelectionStrategy;

  constructor(params: {
    registry: ModelRegistryPort;
    strategyConfig: StrategyConfig;
    observers?: ModelVersioningObserver[];
  }) {
    this.registry = params.registry;
    this.strategy = ModelSelectionStrategyFactory.create(params.strategyConfig);
    this.observers = new Set(params.observers ?? []);
  }

  /**
   * Swap selection strategy on the fly (e.g. via feature flag).
   */
  public updateStrategy(config: StrategyConfig): void {
    this.strategy = ModelSelectionStrategyFactory.create(config);
  }

  /**
   * Main orchestration entry-point: evaluates candidates, chooses a winner, promotes it,
   * and notifies observers.
   */
  public async evaluateAndPromote(
    modelId: string,
    ctx: SelectionContext
  ): Promise<ModelMetadata> {
    const candidates = await this.registry.listModelVersions(modelId);
    if (candidates.length === 0) {
      throw new Error(`[ModelVersioningService] No versions found for model ${modelId}.`);
    }

    const chosen = await this.strategy.select(candidates, ctx);

    // Get current production version, if any.
    const currentProd = candidates.find(c => c.tags.includes('production'));

    if (!currentProd || currentProd.version !== chosen.version) {
      // Promote winner and demote previous prod (if needed).
      await this.registry.promoteToProduction(chosen);

      const event: ModelSwitchEvent = {
        id: randomUUID(),
        timestamp: new Date(),
        oldVersion: currentProd,
        newVersion: chosen,
        reason: `Selected by ${this.strategy.name}`,
      };

      // Notify observers asynchronously – do not block main flow.
      await Promise.allSettled(Array.from(this.observers).map(obs => obs.onSwitch(event)));

      // Optionally log to registry / audit trail.
      if (this.registry.logModelSwitch) {
        await this.registry.logModelSwitch(event);
      }
    }

    return chosen;
  }

  /**
   * Register an observer at runtime.
   */
  public addObserver(observer: ModelVersioningObserver): void {
    this.observers.add(observer);
  }

  /**
   * Deregister an observer.
   */
  public removeObserver(observer: ModelVersioningObserver): void {
    this.observers.delete(observer);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Example Usage (would live in an adapter layer, but helpful for tests / docs)
 * -----------------------------------------------------------------------------------------------*/

// Fake in-memory registry for demonstration/testing.
class InMemoryModelRegistry implements ModelRegistryPort {
  private readonly store: Record<string, ModelMetadata[]> = {};

  constructor(seedData: ModelMetadata[]) {
    for (const meta of seedData) {
      if (!this.store[meta.modelId]) this.store[meta.modelId] = [];
      this.store[meta.modelId].push(meta);
    }
  }

  async listModelVersions(modelId: string): Promise<ModelMetadata[]> {
    return _.cloneDeep(this.store[modelId] ?? []);
  }

  async promoteToProduction(model: ModelMetadata): Promise<void> {
    const versions = this.store[model.modelId];
    if (!versions) throw new Error(`Model ${model.modelId} not found.`);
    versions.forEach(v => _.pull(v.tags, 'production'));
    const target = versions.find(v => v.version === model.version);
    if (target) target.tags.push('production');
  }

  async logModelSwitch(event: ModelSwitchEvent): Promise<void> {
    // eslint-disable-next-line no-console
    console.debug(`[InMemoryRegistry] Logged switch event ${event.id}`);
  }
}

// (Delete or comment-out in real production code; left here for easier module-level tests)
async function demo() {
  const registry = new InMemoryModelRegistry([
    {
      modelId: 'customer-churn',
      version: '1.0.0',
      createdAt: new Date('2023-01-01'),
      metrics: { roc_auc: 0.81 },
      tags: ['production'],
      trafficPercentage: 80,
    },
    {
      modelId: 'customer-churn',
      version: '1.1.0',
      createdAt: new Date('2023-02-01'),
      metrics: { roc_auc: 0.83 },
      tags: ['candidate'],
      trafficPercentage: 20,
    },
  ]);

  const service = new ModelVersioningService({
    registry,
    strategyConfig: {
      type: 'ab_test',
    },
    observers: [new ConsoleLoggingObserver()],
  });

  await service.evaluateAndPromote('customer-churn', { time: new Date() });
}

// Only run demo when executed directly (not when imported by Jest / other tests).
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  demo();
}
```