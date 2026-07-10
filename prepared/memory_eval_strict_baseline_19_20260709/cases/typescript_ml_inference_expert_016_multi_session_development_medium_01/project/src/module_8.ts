```typescript
/**************************************************************************************************
 *  File:        src/module_8.ts
 *  Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *  Description: Domain-level module implementing a pluggable model-selection mechanism that
 *               supports A/B testing as well as Bayesian Multi-Armed Bandit (MAB) strategies.
 *               The code adheres to Hexagonal Architecture principles by keeping all logic
 *               adapter-agnostic. Observers can subscribe to model-selection events in order to
 *               feed downstream dashboards or audit trails (Observer Pattern). A factory enables
 *               run-time strategy switching without touching IO layers (Factory + Strategy Pattern).
 **************************************************************************************************/

/* eslint-disable @typescript-eslint/no-empty-interface */

import { v4 as uuid } from 'uuid';

/**
 * Lightweight logger interface to avoid forcing a concrete implementation.
 * Adapters can provide bindings to Winston, Bunyan, Datadog, etc.
 */
export interface ILogger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string | Error, meta?: Record<string, unknown>): void;
}

/**
 * Fallback console-based logger (will be treeshaken in production if replaced by an adapter).
 */
const ConsoleLogger: ILogger = {
    debug: (msg, meta) => console.debug(`[DEBUG] ${msg}`, meta ?? {}),
    info: (msg, meta) => console.info(`[INFO] ${msg}`, meta ?? {}),
    warn: (msg, meta) => console.warn(`[WARN] ${msg}`, meta ?? {}),
    error: (msg, meta) => console.error(`[ERROR] ${msg}`, meta ?? {}),
};

/* ================================================================================================
 * Domain Types
 * ==============================================================================================*/

/**
 * Inference request as seen by the domain core.
 */
export interface InferenceRequest {
    readonly requestId: string;
    readonly userId: string;
    readonly features: Readonly<Record<string, number | string | boolean>>;
    readonly timestamp: number; // Unix ms
}

/**
 * Metadata about a candidate model that may be selected for inference.
 */
export interface ModelMetadata {
    readonly modelId: string;
    readonly version: string;
    /** Pre-computed offline metrics, e.g., accuracy or CTR. */
    readonly metrics: Readonly<Record<string, number>>;
    /** Traffic percentage for A/B or prior for MAB. */
    readonly weight: number;
}

/* ================================================================================================
 * Observer Pattern
 * ==============================================================================================*/

/**
 * Event emitted after a model has been selected by a strategy.
 */
export interface ModelSelectionEvent {
    readonly eventId: string;
    readonly strategy: string;
    readonly modelId: string;
    readonly userId: string;
    readonly requestId: string;
    readonly timestamp: number;
}

/**
 * Observer interface (ports). Adapters may persist events to a DB, push to Kafka, etc.
 */
export interface ISelectionObserver {
    /**
     * React to a new selection event.
     * Default implementation(s) MUST NOT throw; exceptions should be swallowed or handled internally.
     */
    update(event: ModelSelectionEvent): void;
}

/* ================================================================================================
 * Strategy Pattern
 * ==============================================================================================*/

/**
 * Contract for any model-selection strategy.
 */
export interface IModelSelectionStrategy {
    readonly name: string;
    /**
     * Decide which model should serve the provided inference request.
     * Implementations must be pure/domain-safe and side-effect free.
     */
    selectModel(
        request: InferenceRequest,
        candidates: ReadonlyArray<ModelMetadata>,
    ): ModelMetadata;
}

/**
 * Simple deterministic A/B (+n) strategy based on pre-assigned traffic weights.
 */
export class ABTestingStrategy implements IModelSelectionStrategy {
    public readonly name = 'AB_TESTING';

    public selectModel(
        request: InferenceRequest,
        candidates: ReadonlyArray<ModelMetadata>,
    ): ModelMetadata {
        if (candidates.length === 0) {
            throw new Error('No candidate models supplied to ABTestingStrategy');
        }

        // Convert weights to cumulative distribution for O(log n) binary search
        const total = candidates.reduce((acc, c) => acc + c.weight, 0);
        if (total === 0) {
            // Fallback to uniform distribution
            const idx = hashUser(request.userId) % candidates.length;
            return candidates[idx];
        }

        const r = (hashUser(request.userId) % total) + 1; // 1..total inclusive
        let cumulative = 0;
        for (const candidate of candidates) {
            cumulative += candidate.weight;
            if (r <= cumulative) {
                return candidate;
            }
        }
        // Should never reach here
        return candidates[candidates.length - 1];
    }
}

/**
 * Basic Epsilon-Greedy Multi-Armed Bandit strategy.
 * NOTE: Online updates are not part of the domain layer; adapters must persist reward updates.
 */
export class EpsilonGreedyBanditStrategy implements IModelSelectionStrategy {
    public readonly name = 'EPSILON_GREEDY_BANDIT';

    constructor(private readonly epsilon: number = 0.1) {
        if (epsilon < 0 || epsilon > 1) {
            throw new RangeError('epsilon must be in [0,1]');
        }
    }

    public selectModel(
        _request: InferenceRequest,
        candidates: ReadonlyArray<ModelMetadata>,
    ): ModelMetadata {
        if (candidates.length === 0) {
            throw new Error('No candidate models supplied to BanditStrategy');
        }
        if (Math.random() < this.epsilon) {
            // Explore uniformly
            return candidates[Math.floor(Math.random() * candidates.length)];
        }
        // Exploit: pick best according to some metric, e.g., reward or accuracy
        return [...candidates].sort(
            (a, b) => (b.metrics['reward'] ?? 0) - (a.metrics['reward'] ?? 0),
        )[0];
    }
}

/* ================================================================================================
 * Factory Pattern
 * ==============================================================================================*/

export enum StrategyType {
    AB_TESTING = 'AB_TESTING',
    EPSILON_GREEDY_BANDIT = 'EPSILON_GREEDY_BANDIT',
}

/**
 * Factory responsible for supplying the correct strategy instance based on config or run-time hints.
 */
export class ModelSelectionStrategyFactory {
    constructor(private readonly logger: ILogger = ConsoleLogger) {}

    public createStrategy(type: StrategyType, params?: Record<string, unknown>): IModelSelectionStrategy {
        this.logger.debug(`Creating strategy ${type}`, params);

        switch (type) {
            case StrategyType.AB_TESTING:
                return new ABTestingStrategy();

            case StrategyType.EPSILON_GREEDY_BANDIT: {
                const epsilon = typeof params?.epsilon === 'number' ? params.epsilon : 0.1;
                return new EpsilonGreedyBanditStrategy(epsilon);
            }

            default:
                this.logger.error(`Unsupported strategy type requested: ${type}`);
                throw new Error(`Unsupported strategy type: ${type}`);
        }
    }
}

/* ================================================================================================
 * Domain Service (Hexagon)
 * ==============================================================================================*/

export interface IModelSelector {
    handle(request: InferenceRequest): ModelMetadata;
}

/**
 * Core domain service that orchestrates model selection.  All dependencies are provided via ports,
 * so that adapters can wire actual implementations (e.g., SnowflakeFeatureStore, RedisCache).
 */
export class ModelSelector implements IModelSelector {
    private observers: Set<ISelectionObserver> = new Set();

    constructor(
        private readonly candidateProvider: () => Promise<ReadonlyArray<ModelMetadata>>,
        private readonly strategyFactory: ModelSelectionStrategyFactory,
        private readonly strategyTypeProvider: () => Promise<StrategyType>,
        private readonly logger: ILogger = ConsoleLogger,
    ) {}

    /**
     * Invoked by application/service layer for every inference request.
     */
    public async handle(request: InferenceRequest): Promise<ModelMetadata> {
        // Fetch run-time configuration and candidates in parallel
        const [strategyType, candidates] = await Promise.all([
            this.strategyTypeProvider(),
            this.candidateProvider(),
        ]);

        if (!candidates.length) {
            this.logger.error('No candidate models available', { requestId: request.requestId });
            throw new Error('No candidate models available');
        }

        const strategy = this.strategyFactory.createStrategy(strategyType);
        this.logger.debug(`Using strategy ${strategy.name} for request ${request.requestId}`);

        const selected = strategy.selectModel(request, candidates);

        this.notifyObservers({
            eventId: uuid(),
            strategy: strategy.name,
            modelId: selected.modelId,
            userId: request.userId,
            requestId: request.requestId,
            timestamp: Date.now(),
        });

        return selected;
    }

    /* ------------------------------ Observer management ------------------------------ */

    /**
     * Register a new observer (idempotent).
     */
    public addObserver(observer: ISelectionObserver): void {
        this.observers.add(observer);
    }

    /**
     * Deregister an existing observer (idempotent).
     */
    public removeObserver(observer: ISelectionObserver): void {
        this.observers.delete(observer);
    }

    private notifyObservers(event: ModelSelectionEvent): void {
        for (const observer of this.observers) {
            try {
                observer.update(event);
            } catch (err) {
                // Observers must not crash core business flow. Log and continue.
                this.logger.error('Observer threw during update', { error: err, observer });
            }
        }
    }
}

/* ================================================================================================
 * Utility Functions (pure)
 * ==============================================================================================*/

/**
 * Simple deterministic hash for strings.  Used for stable traffic splitting.
 * Implementation: FNV-1a 32-bit hash.
 */
function hashUser(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0; // >>> 0 ensures 32bit unsigned
    }
    return hash;
}
```