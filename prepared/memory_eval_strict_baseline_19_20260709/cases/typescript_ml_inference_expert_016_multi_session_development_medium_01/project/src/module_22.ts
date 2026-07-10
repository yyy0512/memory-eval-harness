```typescript
/***************************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_22.ts
 * Responsibility:
 *   • Domain-level “Model Version Selection” service that decides which model version should serve
 *     an inference request.                                                                   
 *   • Implements Strategy Pattern + Factory Pattern to allow pluggable decision strategies
 *     (A/B, multi-armed bandit, performance-weighted, static).                               
 *   • Publishes domain events (Observer Pattern) every time a model version gets selected so
 *     that external dashboards/alerting adapters can react.                                  
 *                                                                                           
 * NOTE: All dependencies referenced here are either Node.js built-ins or part of the core
 *       InsightHexaAI domain; the code is safe to live inside the hexagon.                  
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* ================================================================================================
 * Domain Types & Ports
 * ==============================================================================================*/

/**
 * Snapshot of objective/subjective metrics associated with a model version.
 * Keeps business-critical KPIs close to the core.
 */
export interface ModelMetrics {
    latencyMsP50: number;     // Median latency
    accuracy: number;         // e.g. classification accuracy (0-1)
    f1Score: number;          // F1 for imbalanced classes
    costPer1k: number;        // $ cost for 1k predictions
}

/**
 * Minimal representation of a model artifact stored in the registry.
 */
export interface ModelMetadata {
    id: string;               // Globally unique model identifier
    name: string;             // Human-friendly name
    version: string;          // SemVer
    createdAt: Date;          // Registry timestamp
    tags: Record<string, string>;
    status: 'ACTIVE' | 'ARCHIVED';
    metrics: ModelMetrics;
}

/**
 * Context provided by the application layer when requesting a model for inference.
 */
export interface SelectionContext {
    kpi: string;                  // Which business KPI the inference will support
    customerSegment?: string;     // e.g. "high_value", "prospect"
    requestId: string;            // Traceability for auditing
    timestamp: Date;              // ISO time
}

/**
 * Hexagonal port for talking to the model registry (out-going side).
 */
export interface IModelRegistryPort {
    /**
     * List all active models related to a KPI.
     */
    fetchActiveModels(kpi: string): Promise<ModelMetadata[]>;

    /**
     * Persist that a model version was chosen for a specific request (audit + online learning).
     */
    recordSelection(modelId: string, context: SelectionContext): Promise<void>;
}

/* ================================================================================================
 * Strategy Pattern: decide which model to pick
 * ==============================================================================================*/

/**
 * Error thrown when a strategy cannot make a decision.
 */
export class StrategyDecisionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StrategyDecisionError';
    }
}

/**
 * Abstraction for any model-selection strategy.
 */
export interface IModelSelectorStrategy {
    /**
     * Decide which ModelMetadata to serve for this request.
     * @throws StrategyDecisionError if decision cannot be made.
     */
    select(models: ModelMetadata[], context: SelectionContext): Promise<ModelMetadata>;
}

/**
 * Implementation: always pick a hard-coded, static model (usually “latest stable”).
 */
export class StaticStrategy implements IModelSelectorStrategy {
    constructor(private readonly pinnedModelId: string) {}

    async select(models: ModelMetadata[]): Promise<ModelMetadata> {
        const model = models.find(m => m.id === this.pinnedModelId && m.status === 'ACTIVE');
        if (!model) {
            throw new StrategyDecisionError(
                `Pinned model ${this.pinnedModelId} is not ACTIVE or does not exist.`,
            );
        }
        return model;
    }
}

/**
 * Implementation: performance-weighted scoring (accuracy + latency + cost + recency).
 * Shows how to apply domain-specific business rules.
 */
export class PerformanceWeightedStrategy implements IModelSelectorStrategy {
    constructor(
        private readonly weightAccuracy = 0.55,
        private readonly weightLatency = 0.25,
        private readonly weightCost = 0.1,
        private readonly weightRecency = 0.1,
    ) {}

    async select(models: ModelMetadata[]): Promise<ModelMetadata> {
        if (!models.length) {
            throw new StrategyDecisionError('No ACTIVE models available.');
        }

        // Determine ranges for normalization
        const maxAccuracy = Math.max(...models.map(m => m.metrics.accuracy));
        const minLatency = Math.min(...models.map(m => m.metrics.latencyMsP50));
        const minCost = Math.min(...models.map(m => m.metrics.costPer1k));
        const latestCreatedAt = Math.max(...models.map(m => m.createdAt.getTime()));

        let bestModel: ModelMetadata | null = null;
        let bestScore = -Infinity;

        for (const model of models) {
            const accScore =
                maxAccuracy === 0 ? 0 : model.metrics.accuracy / maxAccuracy; // 0-1
            const latencyScore =
                model.metrics.latencyMsP50 === 0
                    ? 1
                    : minLatency / model.metrics.latencyMsP50; // inverse, lower is better
            const costScore = minCost / model.metrics.costPer1k; // cheaper is higher score
            const recencyScore =
                model.createdAt.getTime() / latestCreatedAt; // newer ~ 1, older ~ 0-1

            const composite =
                accScore * this.weightAccuracy +
                latencyScore * this.weightLatency +
                costScore * this.weightCost +
                recencyScore * this.weightRecency;

            if (composite > bestScore) {
                bestScore = composite;
                bestModel = model;
            }
        }

        if (!bestModel) {
            throw new StrategyDecisionError('Could not compute performance score for models.');
        }

        return bestModel;
    }
}

/**
 * Implementation: simple A/B split based on deterministic hashing of requestId.
 */
export class ABTestStrategy implements IModelSelectorStrategy {
    constructor(
        private readonly modelAId: string,
        private readonly modelBId: string,
        private readonly percentModelA = 0.5,
    ) {
        if (percentModelA < 0 || percentModelA > 1) {
            throw new Error('percentModelA must be between 0 and 1.');
        }
    }

    async select(models: ModelMetadata[], context: SelectionContext): Promise<ModelMetadata> {
        if (!models.length) throw new StrategyDecisionError('No ACTIVE models available.');

        const modelA = models.find(m => m.id === this.modelAId && m.status === 'ACTIVE');
        const modelB = models.find(m => m.id === this.modelBId && m.status === 'ACTIVE');

        if (!modelA || !modelB) {
            throw new StrategyDecisionError('A/B models are not both ACTIVE.');
        }

        // Deterministic pseudo-random: hash requestId -> [0,1)
        const hash = this.simpleHash(context.requestId);
        return hash < this.percentModelA ? modelA : modelB;
    }

    private simpleHash(str: string): number {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
        return Math.abs(h) % 10000 / 10000; // 0-0.9999
    }
}

/**
 * Implementation: Epsilon-greedy multi-armed bandit.
 * Stores reward counts in memory; in production this would be persisted (Redis/Snowflake).
 */
export class EpsilonGreedyBanditStrategy implements IModelSelectorStrategy {
    private readonly rewardCounts = new Map<string, { wins: number; pulls: number }>();

    constructor(
        private readonly epsilon = 0.1, // Exploration probability
    ) {
        if (epsilon < 0 || epsilon > 1) throw new Error('epsilon must be [0,1].');
    }

    async select(models: ModelMetadata[]): Promise<ModelMetadata> {
        if (!models.length) throw new StrategyDecisionError('No ACTIVE models available.');

        // Initialise counts for unseen models
        for (const m of models) {
            if (!this.rewardCounts.has(m.id)) {
                this.rewardCounts.set(m.id, { wins: 0, pulls: 0 });
            }
        }

        // Explore
        if (Math.random() < this.epsilon) {
            return models[Math.floor(Math.random() * models.length)];
        }

        // Exploit: pick highest empirical win-rate
        let bestModel = models[0];
        let bestRate = -Infinity;

        for (const m of models) {
            const { wins, pulls } = this.rewardCounts.get(m.id)!;
            // Add 1 to denominator for Laplace smoothing to avoid div-by-0.
            const rate = pulls === 0 ? 0 : wins / pulls;
            if (rate > bestRate) {
                bestRate = rate;
                bestModel = m;
            }
        }

        return bestModel;
    }

    /**
     * To be called by application layer when ground-truth feedback arrives.
     */
    public recordReward(modelId: string, reward: boolean): void {
        const entry = this.rewardCounts.get(modelId);
        if (!entry) return;
        entry.pulls += 1;
        if (reward) entry.wins += 1;
    }
}

/* ================================================================================================
 * Factory Pattern for choosing strategy at runtime
 * ==============================================================================================*/

export enum StrategyKind {
    STATIC = 'STATIC',
    PERFORMANCE_WEIGHTED = 'PERFORMANCE_WEIGHTED',
    AB_TEST = 'AB_TEST',
    EPSILON_GREEDY_BANDIT = 'EPSILON_GREEDY_BANDIT',
}

export interface StrategyConfigBase {
    kind: StrategyKind;
}

export type StrategyConfig =
    | (StrategyConfigBase & {
          kind: StrategyKind.STATIC;
          pinnedModelId: string;
      })
    | (StrategyConfigBase & {
          kind: StrategyKind.PERFORMANCE_WEIGHTED;
          weights?: {
              accuracy?: number;
              latency?: number;
              cost?: number;
              recency?: number;
          };
      })
    | (StrategyConfigBase & {
          kind: StrategyKind.AB_TEST;
          modelAId: string;
          modelBId: string;
          percentModelA?: number;
      })
    | (StrategyConfigBase & {
          kind: StrategyKind.EPSILON_GREEDY_BANDIT;
          epsilon?: number;
      });

/**
 * Transforms configuration objects into concrete Strategy instances.
 */
export class ModelSelectorStrategyFactory {
    static create(config: StrategyConfig): IModelSelectorStrategy {
        switch (config.kind) {
            case StrategyKind.STATIC:
                return new StaticStrategy(config.pinnedModelId);

            case StrategyKind.PERFORMANCE_WEIGHTED:
                return new PerformanceWeightedStrategy(
                    config.weights?.accuracy,
                    config.weights?.latency,
                    config.weights?.cost,
                    config.weights?.recency,
                );

            case StrategyKind.AB_TEST:
                return new ABTestStrategy(
                    config.modelAId,
                    config.modelBId,
                    config.percentModelA,
                );

            case StrategyKind.EPSILON_GREEDY_BANDIT:
                return new EpsilonGreedyBanditStrategy(config.epsilon);

            default:
                /* eslint-disable-next-line @typescript-eslint/restrict-template-expressions */
                throw new Error(`Unsupported strategy kind ${(config as any).kind}`);
        }
    }
}

/* ================================================================================================
 * Domain Events (Observer Pattern)
 * ==============================================================================================*/

/**
 * Payload emitted whenever a model has been chosen to serve a request.
 */
export interface ModelSelectedEvent {
    model: ModelMetadata;
    context: SelectionContext;
}

export class ModelSelectionEventPublisher extends EventEmitter {
    static readonly MODEL_SELECTED = 'model-selected';

    emitModelSelected(event: ModelSelectedEvent): boolean {
        return this.emit(ModelSelectionEventPublisher.MODEL_SELECTED, event);
    }
}

/* ================================================================================================
 * Application Service: orchestrates registry + strategy + events
 * ==============================================================================================*/

export class ModelSelectionService {
    constructor(
        private readonly registryPort: IModelRegistryPort,
        private readonly strategy: IModelSelectorStrategy,
        private readonly publisher = new ModelSelectionEventPublisher(),
    ) {}

    /**
     * Fetch ACTIVE models, pick one through the strategy, record & publish.
     */
    async selectModel(context: SelectionContext): Promise<ModelMetadata> {
        const models = await this.registryPort.fetchActiveModels(context.kpi);

        if (!models.length) {
            throw new Error(`No ACTIVE models found for KPI ${context.kpi}`);
        }

        const chosen = await this.strategy.select(models, context);

        await this.registryPort.recordSelection(chosen.id, context);

        // fire-and-forget; do not await listeners
        this.publisher.emitModelSelected({ model: chosen, context });

        return chosen;
    }

    /**
     * Allows external adapters (dashboards, logs, alerts) to subscribe.
     */
    onModelSelected(listener: (event: ModelSelectedEvent) => void): void {
        this.publisher.on(ModelSelectionEventPublisher.MODEL_SELECTED, listener);
    }

    /**
     * Expose publisher for advanced usages (e.g., once, off, etc.).
     */
    get eventPublisher(): ModelSelectionEventPublisher {
        return this.publisher;
    }
}

/* ================================================================================================
 * Example in-memory registry adapter (for unit tests / local dev only)
 * ==============================================================================================*/

export class InMemoryModelRegistryAdapter implements IModelRegistryPort {
    private readonly storeByKpi = new Map<string, ModelMetadata[]>();

    async fetchActiveModels(kpi: string): Promise<ModelMetadata[]> {
        return (this.storeByKpi.get(kpi) ?? []).filter(m => m.status === 'ACTIVE');
    }

    async recordSelection(): Promise<void> {
        // In-memory adapter does not persist audit logs; no-op.
    }

    // Helpers for test data
    public saveModel(kpi: string, meta: ModelMetadata): void {
        const list = this.storeByKpi.get(kpi) ?? [];
        list.push(meta);
        this.storeByKpi.set(kpi, list);
    }
}
```