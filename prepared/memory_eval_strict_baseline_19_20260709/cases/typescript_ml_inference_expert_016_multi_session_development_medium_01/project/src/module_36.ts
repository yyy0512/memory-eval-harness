```typescript
/***************************************************************************************************
 *  InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:          src/module_36.ts
 *  Responsibility: Core Model-Versioning Domain Service + Strategy / Factory Implementation
 *  Author:        InsightHexaAI Core Team
 *
 *  Description:
 *      Production-grade implementation of the Model-Versioning core service.  The service
 *      encapsulates version-selection strategies (A/B, Canary, MAB) behind a factory, exposing a
 *      single hexagonal port (`ModelVersioningService`) to the rest of the domain.  The service
 *      notifies observers whenever a version has been selected, enabling adapters (dashboards,
 *      alerting, etc.) to react through the Observer Pattern.
 *
 *  Architectural Layer: Domain (inside the Hexagon)
 ***************************************************************************************************/

import { randomUUID } from 'crypto';
import { Subject } from 'rxjs';
import { EventEmitter } from 'events';

/* ------------------------------------------------------------------ *
 *  Domain Types & Errors                                             *
 * ------------------------------------------------------------------ */

/** Unique identifier for an ML model version. */
export type ModelVersionId = string;

/** Domain entity representing a registered ML model version. */
export interface ModelVersion {
    id: ModelVersionId;
    version: string;
    /** Arbitrary metadata attached by upstream processes (e.g. training job). */
    metadata: Record<string, unknown>;
    /** Aggregate online metrics (CTR, conversion-rate, etc.) collected post-deployment. */
    metrics: Record<string, number>;
    /** Weight used by some strategies (e.g. epsilon-greedy MAB). */
    weight: number;
    createdAt: Date;
}

/** Context passed in by the caller that might influence strategy decisions. */
export interface SelectionContext {
    userId?: string;
    requestId?: string;
    /** Fractional hash for sticky routing. */
    hash?: number;
}

/** Event emitted whenever a model version has been selected by the service. */
export interface VersionSelectedEvent {
    timestamp: Date;
    versionId: ModelVersionId;
    strategy: string;
    context: SelectionContext;
}

export class ModelVersioningError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ModelVersioningError';
    }
}

export class ModelVersionNotFoundError extends ModelVersioningError {
    constructor() {
        super('No model versions are available for selection.');
        this.name = 'ModelVersionNotFoundError';
    }
}

/* ------------------------------------------------------------------ *
 *  Repository Port (Hexagonal Outbound Port)                          *
 * ------------------------------------------------------------------ */

export interface IModelVersionRepository {
    /** Retrieve all versions that are currently eligible for serving. */
    fetchAvailableVersions(): Promise<ModelVersion[]>;

    /** Record feedback / reward for a given version (used by MAB strategies). */
    recordFeedback(versionId: ModelVersionId, reward: number): Promise<void>;
}

/**
 * In-memory repository – used in unit tests & local development only.
 * Production code should supply infra-specific adapters (Snowflake, DynamoDB, …).
 */
export class InMemoryModelVersionRepository implements IModelVersionRepository {
    private storage: Map<ModelVersionId, ModelVersion> = new Map();

    async fetchAvailableVersions(): Promise<ModelVersion[]> {
        return Array.from(this.storage.values());
    }

    async recordFeedback(versionId: string, reward: number): Promise<void> {
        const version = this.storage.get(versionId);
        if (!version) throw new ModelVersionNotFoundError();
        version.metrics.rewardSum = (version.metrics.rewardSum ?? 0) + reward;
        version.metrics.impressions = (version.metrics.impressions ?? 0) + 1;
    }

    /** Utility for tests. */
    add(version: ModelVersion): void {
        this.storage.set(version.id, version);
    }
}

/* ------------------------------------------------------------------ *
 *  Strategy Pattern                                                   *
 * ------------------------------------------------------------------ */

export interface IVersionSelectionStrategy {
    readonly name: string;

    /**
     * Select a single model version from the candidates.
     *
     * @throws ModelVersioningError if selection fails.
     */
    select(versions: ModelVersion[], context: SelectionContext): ModelVersion;
}

/* ---------------- A/B Test Strategy ------------------ */

export class ABTestStrategy implements IVersionSelectionStrategy {
    readonly name = 'AB_TEST';

    constructor(private readonly bucketPercent: number = 0.5) {
        if (bucketPercent <= 0 || bucketPercent >= 1) {
            throw new ModelVersioningError('bucketPercent must be in (0, 1).');
        }
    }

    select(versions: ModelVersion[], context: SelectionContext): ModelVersion {
        if (versions.length < 2) {
            return versions[0];
        }

        const hash = context.hash ?? Math.random();
        const index = hash < this.bucketPercent ? 0 : 1;
        return versions[index];
    }
}

/* ---------------- Canary Strategy ------------------ */

export class CanaryStrategy implements IVersionSelectionStrategy {
    readonly name = 'CANARY';

    /**
     * @param canaryVersionId – version to gradually release.
     * @param canaryTrafficRate – percentage of traffic routed to canary [0,1].
     */
    constructor(
        private readonly canaryVersionId: ModelVersionId,
        private readonly canaryTrafficRate: number = 0.1,
    ) {
        if (canaryTrafficRate < 0 || canaryTrafficRate > 1) {
            throw new ModelVersioningError(
                'canaryTrafficRate must be between 0 and 1.',
            );
        }
    }

    select(versions: ModelVersion[], context: SelectionContext): ModelVersion {
        const canary = versions.find((v) => v.id === this.canaryVersionId);
        const stable = versions.filter((v) => v.id !== this.canaryVersionId);

        if (!canary || stable.length === 0) {
            throw new ModelVersioningError('Invalid canary/stable versions.');
        }

        const rand = Math.random();
        return rand < this.canaryTrafficRate ? canary : stable[0];
    }
}

/* ---------------- Multi-Armed Bandit (ε-Greedy) Strategy ------------------ */

export class EpsilonGreedyStrategy implements IVersionSelectionStrategy {
    readonly name = 'EPSILON_GREEDY';

    constructor(private readonly epsilon: number = 0.05) {
        if (epsilon < 0 || epsilon > 1) {
            throw new ModelVersioningError('epsilon must be between 0 and 1.');
        }
    }

    select(versions: ModelVersion[]): ModelVersion {
        if (versions.length === 0) throw new ModelVersionNotFoundError();

        // Exploit – choose best so far.
        if (Math.random() > this.epsilon) {
            const sorted = versions.sort(
                (a, b) =>
                    (b.metrics.rewardSum ?? 0) / ((b.metrics.impressions ?? 1)) -
                    (a.metrics.rewardSum ?? 0) / ((a.metrics.impressions ?? 1)),
            );
            return sorted[0];
        }
        // Explore – random pick.
        const idx = Math.floor(Math.random() * versions.length);
        return versions[idx];
    }
}

/* ------------------------------------------------------------------ *
 *  Strategy Factory                                                   *
 * ------------------------------------------------------------------ */

export type StrategyConfig =
    | {
          type: 'AB_TEST';
          bucketPercent?: number;
      }
    | {
          type: 'CANARY';
          canaryVersionId: ModelVersionId;
          canaryTrafficRate?: number;
      }
    | {
          type: 'EPSILON_GREEDY';
          epsilon?: number;
      };

export class VersionSelectionStrategyFactory {
    static create(config: StrategyConfig): IVersionSelectionStrategy {
        switch (config.type) {
            case 'AB_TEST':
                return new ABTestStrategy(config.bucketPercent);
            case 'CANARY':
                return new CanaryStrategy(
                    config.canaryVersionId,
                    config.canaryTrafficRate,
                );
            case 'EPSILON_GREEDY':
                return new EpsilonGreedyStrategy(config.epsilon);
            default:
                // @ts-expect-error exhaustive check
                throw new ModelVersioningError(
                    `Unsupported strategy type: ${(config as any).type}`,
                );
        }
    }
}

/* ------------------------------------------------------------------ *
 *  ModelVersioningService – Hexagonal Domain Service                  *
 * ------------------------------------------------------------------ */

export class ModelVersioningService extends EventEmitter {
    /** RxJS alternative for Observers preferring reactive streams. */
    readonly events$ = new Subject<VersionSelectedEvent>();

    constructor(
        private readonly repository: IModelVersionRepository,
        private readonly strategy: IVersionSelectionStrategy,
    ) {
        super();
    }

    /**
     * Select an appropriate model version for the given request context.
     */
    async selectVersion(
        context: SelectionContext = {},
    ): Promise<ModelVersion> {
        const versions = await this.repository.fetchAvailableVersions();
        if (versions.length === 0) throw new ModelVersionNotFoundError();

        const selected = this.strategy.select(versions, {
            ...context,
            requestId: context.requestId ?? randomUUID(),
        });

        const evt: VersionSelectedEvent = {
            timestamp: new Date(),
            versionId: selected.id,
            strategy: this.strategy.name,
            context,
        };

        // Notify observers – both Node EventEmitter & RxJS Subject.
        this.emit('versionSelected', evt);
        this.events$.next(evt);

        return selected;
    }

    /**
     * Record feedback (reward) for an earlier served version.
     *
     * This feeds online-learning / MAB algorithms.
     */
    async recordFeedback(
        versionId: ModelVersionId,
        reward: number,
    ): Promise<void> {
        if (reward < 0)
            throw new ModelVersioningError('Reward must be non-negative.');
        await this.repository.recordFeedback(versionId, reward);
    }

    /**
     * Gracefully release resources (e.g., close DB connections, complete Observables).
     */
    async dispose(): Promise<void> {
        this.events$.complete();
        this.removeAllListeners();
    }
}

/* ------------------------------------------------------------------ *
 *  Module Default Export                                              *
 * ------------------------------------------------------------------ */

export default {
    ModelVersioningService,
    VersionSelectionStrategyFactory,
    InMemoryModelVersionRepository,
    Strategies: {
        ABTestStrategy,
        CanaryStrategy,
        EpsilonGreedyStrategy,
    },
    Errors: {
        ModelVersioningError,
        ModelVersionNotFoundError,
    },
};
```