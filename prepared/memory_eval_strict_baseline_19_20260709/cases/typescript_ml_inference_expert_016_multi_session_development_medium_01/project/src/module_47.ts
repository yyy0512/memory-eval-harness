```typescript
/***************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  module_47.ts – Model-Selection Hexagon (Domain Service)
 *
 *  This module encapsulates business rules for choosing which predictive model should serve a
 *  request, while remaining agnostic to concrete infrastructure.  It implements:
 *
 *    • Strategy Pattern ................ Swap selection algorithms at runtime (A/B, Bandit, etc.)
 *    • Factory  Pattern ................ Create strategies from configuration
 *    • Observer Pattern ................ Notify interested parties whenever the active model changes
 *
 *  NOTE: All dependencies on IO concerns (DBs, message buses, registries, etc.) are expressed as
 *  ports (interfaces).  Adapters live elsewhere and plug into these ports without polluting logic.
 *
 *  © 2023–Present InsightHexaAI, Inc.  All Rights Reserved.  Confidential & Proprietary.
 ***************************************************************************************************/

import { randomUUID } from 'crypto';
import { Logger } from 'pino'; // Logger adapter provided elsewhere in the project

/* ----------------------------------------------------------------------------------------------
 *  Errors
 * ----------------------------------------------------------------------------------------------*/

export class StrategyConfigurationError extends Error {
    constructor(message: string) {
        super(`StrategyConfigurationError: ${message}`);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class ModelNotFoundError extends Error {
    constructor(modelId: string) {
        super(`ModelNotFoundError: Model "${modelId}" not found in registry.`);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

/* ----------------------------------------------------------------------------------------------
 *  Domain Types & Interfaces
 * ----------------------------------------------------------------------------------------------*/

/**
 * Represents the bare-minimum metadata every model must expose to be eligible for selection.
 * Infrastructure (TensorFlow, Sklearn, XGBoost, etc.) sits behind adapters that satisfy this shape.
 */
export interface ModelMetadata {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** Higher score == better (e.g., profit uplift). Domain team defines what "score" means. */
    readonly kpiScore: number;
    /** Timestamp when the score was last measured. */
    readonly scoreTimestamp: Date;
    /** Arbitrary tags to allow filtering (e.g., "region:EU", "tier:premium"). */
    readonly tags?: Record<string, string>;
}

/**
 * Port exposing READ-ONLY access to the Project’s Model Registry.
 * Adapters will talk to S3, MLflow, TensorFlow Serving, etc.
 */
export interface ModelRegistryPort {
    fetchModels(filter?: Record<string, string>): Promise<ModelMetadata[]>;
}

/**
 * Contract every model-selection algorithm must satisfy.
 */
export interface ModelSelectionStrategy {
    /**
     * Choose a model to serve.
     * @throws {ModelNotFoundError} when unable to return a valid model.
     */
    selectModel(): Promise<ModelMetadata>;
    /**
     * Update internal statistics after an inference response finished.
     * This enables online-learning strategies (e.g., multi-armed bandit) to adapt.
     */
    recordOutcome(modelId: string, loss: number): Promise<void>;
    /**
     * Clean up any resources & listeners (idempotent).
     */
    dispose(): Promise<void>;
}

/* ----------------------------------------------------------------------------------------------
 *  Observer Pattern — Events & Subscriptions
 * ----------------------------------------------------------------------------------------------*/

/**
 * Events emitted by strategies. Observers may listen for KPI drift, model switches, etc.
 */
export type ModelSelectionEvent =
    | {
          type: 'MODEL_SELECTED';
          requestId: string;
          model: ModelMetadata;
      }
    | {
          type: 'MODEL_OUTCOME_RECORDED';
          requestId: string;
          modelId: string;
          loss: number;
      };

/**
 * Simplistic local EventBus for in-process observers.
 * For distributed systems, an adapter would publish these events to Kafka/Redis/etc.
 */
export class EventBus {
    private listeners = new Set<(event: ModelSelectionEvent) => void>();

    subscribe(listener: (event: ModelSelectionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(event: ModelSelectionEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                /* Non-blocking — observers should never crash domain flow */
                console.error('[EventBus] listener error', err);
            }
        }
    }
}

/* ----------------------------------------------------------------------------------------------
 *  Concrete Strategies
 * ----------------------------------------------------------------------------------------------*/

/**
 * A/B Testing Strategy — deterministically routes traffic between two or more candidate models
 * according to fixed traffic weights.
 */
export class ABTestStrategy implements ModelSelectionStrategy {
    private readonly trafficTable: Array<{ model: ModelMetadata; cumulativeWeight: number }> = [];
    private readonly eventBus: EventBus;
    private readonly logger: Logger;

    constructor(
        private readonly registry: ModelRegistryPort,
        private readonly weights: Record<string, number>, // modelId -> percent weight
        deps: { eventBus: EventBus; logger: Logger }
    ) {
        this.eventBus = deps.eventBus;
        this.logger = deps.logger;
        this.validateWeights();
    }

    private async buildTrafficTable(): Promise<void> {
        const models = await this.registry.fetchModels();
        let cumulative = 0;

        this.trafficTable.length = 0; // reset
        for (const model of models) {
            const weight = this.weights[model.id] ?? 0;
            if (weight <= 0) continue;
            cumulative += weight;
            this.trafficTable.push({ model, cumulativeWeight: cumulative });
        }

        if (cumulative !== 100) {
            throw new StrategyConfigurationError(
                `Total A/B weights must equal 100. Received ${cumulative}.`
            );
        }
    }

    private validateWeights(): void {
        const total = Object.values(this.weights).reduce((acc, v) => acc + v, 0);
        if (total !== 100) {
            throw new StrategyConfigurationError(
                `Total A/B weights must equal 100. Received ${total}.`
            );
        }
    }

    async selectModel(): Promise<ModelMetadata> {
        if (this.trafficTable.length === 0) {
            await this.buildTrafficTable();
        }

        const rand = Math.random() * 100;
        const item = this.trafficTable.find(({ cumulativeWeight }) => rand < cumulativeWeight);

        if (!item) throw new ModelNotFoundError('Unknown');
        const requestId = randomUUID();
        this.eventBus.emit({ type: 'MODEL_SELECTED', requestId, model: item.model });
        return item.model;
    }

    /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
    async recordOutcome(_modelId: string, _loss: number): Promise<void> {
        /* A/B strategy is stateless — ignore outcome */
    }

    async dispose(): Promise<void> {
        // Nothing to clean up for this stateless strategy
    }
}

/**
 * Multi-Armed Bandit Strategy — uses epsilon-greedy exploration to maximise reward.
 */
export class EpsilonGreedyStrategy implements ModelSelectionStrategy {
    private readonly stats = new Map<
        string,
        { wins: number; trials: number; metadata: ModelMetadata }
    >();
    private readonly eventBus: EventBus;
    private readonly logger: Logger;

    constructor(
        private readonly registry: ModelRegistryPort,
        private readonly epsilon: number = 0.05, // 5% exploration
        deps: { eventBus: EventBus; logger: Logger }
    ) {
        if (epsilon < 0 || epsilon > 1) {
            throw new StrategyConfigurationError(
                `Epsilon must be in [0,1]. Received ${epsilon}.`
            );
        }
        this.eventBus = deps.eventBus;
        this.logger = deps.logger;
    }

    private async ensureStats(): Promise<void> {
        if (this.stats.size > 0) return;

        const models = await this.registry.fetchModels();
        for (const model of models) {
            this.stats.set(model.id, { wins: 0, trials: 0, metadata: model });
        }
        if (this.stats.size === 0) {
            throw new StrategyConfigurationError('No models available for bandit strategy.');
        }
    }

    async selectModel(): Promise<ModelMetadata> {
        await this.ensureStats();
        const requestId = randomUUID();

        let candidate: { wins: number; trials: number; metadata: ModelMetadata } | undefined;

        if (Math.random() < this.epsilon) {
            /* Explore — pick random model */
            const all = [...this.stats.values()];
            candidate = all[Math.floor(Math.random() * all.length)];
            this.logger.debug(
                { requestId, modelId: candidate.metadata.id },
                'Exploration step chosen.'
            );
        } else {
            /* Exploit — pick model with highest empirical win rate */
            let bestScore = -Infinity;
            for (const stat of this.stats.values()) {
                const score = stat.trials === 0 ? 0 : stat.wins / stat.trials;
                if (score > bestScore) {
                    bestScore = score;
                    candidate = stat;
                }
            }
            if (!candidate) throw new ModelNotFoundError('Unknown');
            this.logger.debug({ requestId, modelId: candidate.metadata.id }, 'Exploitation step.');
        }

        this.eventBus.emit({
            type: 'MODEL_SELECTED',
            requestId,
            model: candidate.metadata
        });

        return candidate.metadata;
    }

    async recordOutcome(modelId: string, loss: number): Promise<void> {
        const requestId = randomUUID();
        const stat = this.stats.get(modelId);
        if (!stat) {
            this.logger.warn({ modelId }, 'Outcome recorded for unknown model. Ignored.');
            return;
        }
        stat.trials += 1;
        if (loss < 0.01) {
            // Domain rule: treat low loss as a "win"
            stat.wins += 1;
        }
        this.eventBus.emit({
            type: 'MODEL_OUTCOME_RECORDED',
            requestId,
            modelId,
            loss
        });
    }

    async dispose(): Promise<void> {
        this.stats.clear();
    }
}

/* ----------------------------------------------------------------------------------------------
 *  Factory — create strategy instances from configuration
 * ----------------------------------------------------------------------------------------------*/

export enum SelectionStrategyKind {
    AB_TEST = 'AB_TEST',
    EPSILON_GREEDY = 'EPSILON_GREEDY'
}

export interface StrategyFactoryConfig {
    kind: SelectionStrategyKind;
    /* Strategy-specific params */
    params: Record<string, unknown>;
}

/**
 * StrategyFactory is a PURE domain service. It takes an abstract ModelRegistryPort
 * and spits out a concrete strategy.  No knowledge of HTTP, gRPC, or DB layers.
 */
export class StrategyFactory {
    constructor(
        private readonly registry: ModelRegistryPort,
        private readonly deps: { eventBus: EventBus; logger: Logger }
    ) {}

    create(config: StrategyFactoryConfig): ModelSelectionStrategy {
        switch (config.kind) {
            case SelectionStrategyKind.AB_TEST: {
                const { weights } = config.params as { weights: Record<string, number> };
                if (!weights) {
                    throw new StrategyConfigurationError('A/B strategy requires weights param.');
                }
                return new ABTestStrategy(this.registry, weights, this.deps);
            }
            case SelectionStrategyKind.EPSILON_GREEDY: {
                const { epsilon } = config.params as { epsilon?: number };
                return new EpsilonGreedyStrategy(
                    this.registry,
                    epsilon ?? 0.05,
                    this.deps
                );
            }
            default:
                throw new StrategyConfigurationError(`Unknown strategy kind: ${config.kind}`);
        }
    }
}

/* ----------------------------------------------------------------------------------------------
 *  Context Wrapper — 1-liner convenience around strategy & disposal life-cycle.
 * ----------------------------------------------------------------------------------------------*/

/**
 * ModelSelectionContext glues together factory, strategy and observers in an ergonomic façade.
 */
export class ModelSelectionContext {
    private strategy: ModelSelectionStrategy;

    constructor(
        registry: ModelRegistryPort,
        initialConfig: StrategyFactoryConfig,
        deps: { eventBus: EventBus; logger: Logger }
    ) {
        this.strategy = new StrategyFactory(registry, deps).create(initialConfig);
    }

    async select(): Promise<ModelMetadata> {
        return this.strategy.selectModel();
    }

    async record(modelId: string, loss: number): Promise<void> {
        await this.strategy.recordOutcome(modelId, loss);
    }

    async switchStrategy(newConfig: StrategyFactoryConfig, factoryDeps: {
        registry: ModelRegistryPort;
        eventBus: EventBus;
        logger: Logger;
    }): Promise<void> {
        await this.strategy.dispose();
        this.strategy = new StrategyFactory(
            factoryDeps.registry,
            { eventBus: factoryDeps.eventBus, logger: factoryDeps.logger }
        ).create(newConfig);
    }

    async dispose(): Promise<void> {
        await this.strategy.dispose();
    }
}

/* ----------------------------------------------------------------------------------------------
 *  Example usage (would live in an adapter layer, not here) — LEFT AS COMMENT
 * ----------------------------------------------------------------------------------------------*/

/**
 * // Composition Root (e.g., in an HTTP server adapter):
 *
 * import { createLogger } from 'pino';
 * import { S3ModelRegistryAdapter } from './adapters/S3ModelRegistryAdapter';
 *
 * const logger = createLogger({ level: 'info' });
 * const eventBus = new EventBus();
 * const registry = new S3ModelRegistryAdapter('s3://hexa-model-registry');
 *
 * const selectionCtx = new ModelSelectionContext(
 *     registry,
 *     { kind: SelectionStrategyKind.EPSILON_GREEDY, params: { epsilon: 0.03 } },
 *     { eventBus, logger }
 * );
 *
 * // Inside request handler:
 * const model = await selectionCtx.select();
 * const prediction = await callModelInference(model, payload);
 * const loss = computeLoss(prediction, expected);
 * await selectionCtx.record(model.id, loss);
 */
```