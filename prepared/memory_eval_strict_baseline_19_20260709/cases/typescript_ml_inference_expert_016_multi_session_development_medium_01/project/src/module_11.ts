```typescript
/***************************************************************************************************
 *  File:          src/module_11.ts
 *  Project:       InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *  Description:   Pluggable model-selection engine (Strategy + Factory patterns) that chooses
 *                 amongst candidate model versions at inference-time (A/B testing, epsilon-greedy
 *                 multi-armed bandit, etc.). Emits KPI-drift events through an Observer pattern,
 *                 enabling dashboards/alerting systems to react in real-time. Core logic is kept
 *                 framework-agnostic to satisfy hexagonal-architecture guidelines.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/* ================================================================================================
 * Section 1. DOMAIN TYPES
 * ------------------------------------------------------------------------------------------------
 * Business-oriented value objects and type aliases.
 * ==============================================================================================*/

/**
 * Metadata associated with a deployable model artefact.
 */
export interface ModelMetadata {
    readonly id: string;              // Unique identifier (could be the model registry hash)
    readonly version: string;         // SemVer or lineage tag
    readonly createdAt: Date;         // Registration timestamp
    readonly features: string[];      // Features consumed by the model
    readonly businessKpi: string;     // KPI that this model optimizes (e.g., 'clv', 'churn')
}

/**
 * Metric captured after serving a prediction that is necessary for reward computation.
 */
export interface ServingFeedback {
    modelId: string;
    timestamp: number;                // Unix epoch millis
    kpiValue: number;                 // Observed KPI value (e.g., profit)
}

/**
 * Unified error type for selection pipeline.
 */
export class ModelSelectionError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(`[model-selection] ${message}`);
        this.name = 'ModelSelectionError';
    }
}

/* ================================================================================================
 * Section 2. PORTS (Interfaces)
 * ------------------------------------------------------------------------------------------------
 * Hexagonal 'ports'—abstractions that allow adapters to plug-in without touching domain logic.
 * ==============================================================================================*/

export interface ModelRepositoryPort {
    /**
     * Returns the set of candidate models eligible for selection.
     */
    fetchCandidateModels(kpi: string): Promise<ModelMetadata[]>;
}

export interface RewardRepositoryPort {
    /**
     * Accumulates reward signal for the specified model.
     */
    recordReward(modelId: string, reward: number): Promise<void>;

    /**
     * Returns mean reward so far; if unknown, returns undefined.
     */
    fetchMeanReward(modelId: string): Promise<number | undefined>;

    /**
     * Returns the number of observations logged for the model.
     */
    fetchTotalObservations(modelId: string): Promise<number>;
}

/* ================================================================================================
 * Section 3. OBSERVER PATTERN – KPI Event Emitter
 * ==============================================================================================*/

/**
 * Domain-level events that can be emitted.
 */
export enum KpiEventType {
    DRIFT_DETECTED = 'DRIFT_DETECTED',
    REWARD_RECORDED = 'REWARD_RECORDED'
}

export interface DriftEventPayload {
    kpi: string;
    currentValue: number;
    baselineValue: number;
    severity: 'low' | 'medium' | 'high';
}

export type RewardRecordedPayload = ServingFeedback;

class KpiEventEmitter extends EventEmitter {
    emitDrift(payload: DriftEventPayload): void {
        this.emit(KpiEventType.DRIFT_DETECTED, payload);
    }
    emitRewardRecorded(payload: RewardRecordedPayload): void {
        this.emit(KpiEventType.REWARD_RECORDED, payload);
    }
}

/* ================================================================================================
 * Section 4. STRATEGY PATTERN – Model Selection Strategies
 * ==============================================================================================*/

export interface ModelSelectionStrategy {
    select(models: ModelMetadata[]): Promise<ModelMetadata>;
    onFeedback(feedback: ServingFeedback): Promise<void>;
}

/**
 * Simple A/B testing strategy that evenly splits traffic across candidates.
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
    private readonly rng: () => number;
    constructor(
        private readonly rewardRepo: RewardRepositoryPort,
        rng: () => number = Math.random
    ) {
        this.rng = rng;
    }

    async select(models: ModelMetadata[]): Promise<ModelMetadata> {
        if (models.length === 0) {
            throw new ModelSelectionError('No models available for A/B selection.');
        }
        const index = Math.floor(this.rng() * models.length);
        return models[index];
    }

    async onFeedback(feedback: ServingFeedback): Promise<void> {
        await this.rewardRepo.recordReward(feedback.modelId, feedback.kpiValue);
    }
}

/**
 * Epsilon-greedy multi-armed bandit (MAB) strategy.
 *
 *  - With probability ε, explore (uniform random pick).
 *  - Otherwise, exploit (pick model with highest mean reward).
 */
export class EpsilonGreedyBanditStrategy implements ModelSelectionStrategy {
    private readonly rng: () => number;

    constructor(
        private readonly rewardRepo: RewardRepositoryPort,
        private readonly epsilon: number = 0.1,
        rng: () => number = Math.random
    ) {
        if (epsilon < 0 || epsilon > 1) {
            throw new ModelSelectionError('Epsilon must be between 0 and 1.');
        }
        this.rng = rng;
    }

    async select(models: ModelMetadata[]): Promise<ModelMetadata> {
        if (models.length === 0) {
            throw new ModelSelectionError('No models available for MAB selection.');
        }

        const explore = this.rng() < this.epsilon;
        if (explore) {
            // --- Exploration branch ---
            const index = Math.floor(this.rng() * models.length);
            return models[index];
        }

        // --- Exploitation branch ---
        let bestModel: ModelMetadata | null = null;
        let bestReward = -Infinity;
        // Fetch mean reward for each model; default is 0 if none recorded yet
        await Promise.all(
            models.map(async (model) => {
                const reward = (await this.rewardRepo.fetchMeanReward(model.id)) ?? 0;
                if (reward > bestReward) {
                    bestReward = reward;
                    bestModel = model;
                }
            })
        );

        return bestModel ?? models[0];
    }

    async onFeedback(feedback: ServingFeedback): Promise<void> {
        await this.rewardRepo.recordReward(feedback.modelId, feedback.kpiValue);
    }
}

/* ================================================================================================
 * Section 5. FACTORY PATTERN – Strategy Factory
 * ==============================================================================================*/

export enum StrategyKind {
    AB_TESTING = 'AB_TESTING',
    EPSILON_GREEDY_BANDIT = 'EPSILON_GREEDY_BANDIT'
}

export interface StrategyFactoryOptions {
    kind: StrategyKind;
    epsilon?: number; // Only relevant for epsilon-greedy
}

/**
 * Produces a concrete ModelSelectionStrategy based on runtime configuration.
 */
export class ModelSelectionStrategyFactory {
    static create(
        options: StrategyFactoryOptions,
        rewardRepo: RewardRepositoryPort
    ): ModelSelectionStrategy {
        switch (options.kind) {
            case StrategyKind.AB_TESTING:
                return new ABTestingStrategy(rewardRepo);
            case StrategyKind.EPSILON_GREEDY_BANDIT:
                return new EpsilonGreedyBanditStrategy(
                    rewardRepo,
                    options.epsilon ?? 0.1
                );
            default:
                throw new ModelSelectionError(`Unsupported strategy kind: ${options.kind as string}`);
        }
    }
}

/* ================================================================================================
 * Section 6. IN-MEMORY ADAPTERS
 * ------------------------------------------------------------------------------------------------
 * Lightweight, in-process implementations useful for unit tests or PoCs. Production adapters would
 * use Postgres, Redis, or Feature Store APIs instead.
 * ==============================================================================================*/

/**
 * Naïve in-memory repository that resets on process restart.
 */
export class InMemoryRewardRepository implements RewardRepositoryPort {
    private readonly rewardSum: Map<string, number> = new Map();
    private readonly observations: Map<string, number> = new Map();

    async recordReward(modelId: string, reward: number): Promise<void> {
        const newSum = (this.rewardSum.get(modelId) ?? 0) + reward;
        const newCount = (this.observations.get(modelId) ?? 0) + 1;
        this.rewardSum.set(modelId, newSum);
        this.observations.set(modelId, newCount);
    }

    async fetchMeanReward(modelId: string): Promise<number | undefined> {
        const sum = this.rewardSum.get(modelId);
        const count = this.observations.get(modelId);
        if (sum === undefined || count === undefined || count === 0) {
            return undefined;
        }
        return sum / count;
    }

    async fetchTotalObservations(modelId: string): Promise<number> {
        return this.observations.get(modelId) ?? 0;
    }
}

export class InMemoryModelRepository implements ModelRepositoryPort {
    private readonly models: Map<string, ModelMetadata> = new Map();

    /**
     * Registers a model candidate.
     */
    upsert(model: Omit<ModelMetadata, 'id' | 'createdAt'>): ModelMetadata {
        const id = randomUUID();
        const metadata: ModelMetadata = {
            id,
            createdAt: new Date(),
            ...model
        };
        this.models.set(id, metadata);
        return metadata;
    }

    async fetchCandidateModels(kpi: string): Promise<ModelMetadata[]> {
        return [...this.models.values()].filter((m) => m.businessKpi === kpi);
    }
}

/* ================================================================================================
 * Section 7. POSITIONED APPLICATION SERVICE
 * ------------------------------------------------------------------------------------------------
 * Orchestrates interaction of strategy + repositories + event emitter. Could be injected into
 * a controller (REST, gRPC, GraphQL, Kafka, etc.) or used inside a Serverless function.
 * ==============================================================================================*/

export class ModelServingOrchestrator {
    private readonly eventEmitter: KpiEventEmitter;

    constructor(
        private readonly modelRepo: ModelRepositoryPort,
        private readonly strategy: ModelSelectionStrategy,
        eventEmitter?: KpiEventEmitter
    ) {
        this.eventEmitter = eventEmitter ?? new KpiEventEmitter();
    }

    /**
     * Select a model for the given KPI under chosen strategy.
     */
    async chooseModel(kpi: string): Promise<ModelMetadata> {
        const candidates = await this.modelRepo.fetchCandidateModels(kpi);
        if (candidates.length === 0) {
            throw new ModelSelectionError(`No eligible models for KPI: ${kpi}`);
        }
        return this.strategy.select(candidates);
    }

    /**
     * Record post-serving feedback and propagate events.
     */
    async recordFeedback(feedback: ServingFeedback): Promise<void> {
        await this.strategy.onFeedback(feedback);
        this.eventEmitter.emitRewardRecorded(feedback);
    }

    /**
     * External observers can listen to KPI drift / reward events.
     */
    getEmitter(): KpiEventEmitter {
        return this.eventEmitter;
    }

    /**
     * Utility: compute drift severity (trivial z-score style for demo).
     */
    async detectAndEmitDrift(
        kpi: string,
        currentValue: number,
        baselineValue: number
    ): Promise<void> {
        const delta = Math.abs(currentValue - baselineValue) / (baselineValue || 1);
        let severity: DriftEventPayload['severity'] = 'low';
        if (delta > 0.3) severity = 'high';
        else if (delta > 0.15) severity = 'medium';

        if (severity !== 'low') {
            this.eventEmitter.emitDrift({
                kpi,
                currentValue,
                baselineValue,
                severity
            });
        }
    }
}

/* ================================================================================================
 * Section 8. EXAMPLE – Wiring everything together
 * ------------------------------------------------------------------------------------------------
 * NOTE: This is purely illustrative; remove or replace with proper I/O adapters in production.
 * ==============================================================================================*/

async function demo(): Promise<void> {
    const modelRepo = new InMemoryModelRepository();
    const rewardRepo = new InMemoryRewardRepository();

    // Register dummy models that optimise the 'profit' KPI
    modelRepo.upsert({
        version: '1.0.0',
        features: ['age', 'income'],
        businessKpi: 'profit'
    });
    modelRepo.upsert({
        version: '1.1.0',
        features: ['age', 'income', 'segment'],
        businessKpi: 'profit'
    });

    // Use epsilon-greedy strategy
    const strategy = ModelSelectionStrategyFactory.create(
        { kind: StrategyKind.EPSILON_GREEDY_BANDIT, epsilon: 0.2 },
        rewardRepo
    );

    const orchestrator = new ModelServingOrchestrator(modelRepo, strategy);
    orchestrator.getEmitter().on(KpiEventType.DRIFT_DETECTED, (payload) => {
        console.warn('[KPI-DRIFT]', payload);
    });

    // Simulate 5 rounds of inference
    for (let i = 0; i < 5; i++) {
        const chosen = await orchestrator.chooseModel('profit');
        console.log(`Round ${i}: chose model ${chosen.version}`);

        // Fake feedback (profit dollar value)
        const feedback: ServingFeedback = {
            modelId: chosen.id,
            timestamp: Date.now(),
            kpiValue: Math.random() * 100 // Simulated profit
        };
        await orchestrator.recordFeedback(feedback);
    }

    // Simulate KPI drift detection
    await orchestrator.detectAndEmitDrift('profit', 75, 100);
}

// Only run demo when executed directly (not when imported as a module)
if (require.main === module) {
    demo().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
```