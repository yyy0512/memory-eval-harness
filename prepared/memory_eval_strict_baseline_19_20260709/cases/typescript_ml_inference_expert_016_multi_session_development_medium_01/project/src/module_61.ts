```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_61.ts
 * Author:      InsightHexaAI Core Team
 * Description: Implements the core domain service responsible for Model Versioning.  The service
 *              encapsulates all business-rules around:
 *                  • Selecting the “right” model version (Strategy pattern)
 *                  • Promoting/archiving versions in the registry (Hexagonal Port)
 *                  • Emitting lifecycle events (Observer pattern)
 *                  • Guaranteeing concurrency-safety for promotions (optimistic locking)
 *
 * NOTE:        All external technologies (e.g. the concrete model registry, message bus, logger)
 *              are injected via Ports/Adapters so that the domain service remains pure.
 ***************************************************************************************************/

import { Mutex } from 'async-mutex';
import { v4 as uuidv4 } from 'uuid';

/* ───────────────────────────── Domain Types ───────────────────────────── */

export enum ModelStage {
    Staging       = 'STAGING',
    Production    = 'PRODUCTION',
    Archived      = 'ARCHIVED',
}

export type ModelStatus = 'SUCCESS' | 'FAILED' | 'IN_PROGRESS';

export interface ModelVersion {
    id: string;                      // e.g. UUID in registry
    modelName: string;               // logical name – “credit-scoring-v2”
    semanticVersion: string;         // semantic version – “2.4.1”
    createdAt: Date;
    metrics: Record<string, number>; // any KPIs like { accuracy: 0.93, f1: 0.88 }
    stage: ModelStage;
    status: ModelStatus;
    tags: string[];
}

/* ───────────────────────────── Domain Events ───────────────────────────── */

export interface DomainEvent<TPayload = unknown> {
    id: string;
    type: string;
    timestamp: Date;
    payload: TPayload;
}

export interface ModelPromotedEventPayload {
    modelName: string;
    fromVersion: string | null; // null ⇢ first time in prod
    toVersion: string;
}

export const MODEL_PROMOTED_EVENT = 'ModelPromoted';

/* ─────────────────────────────── Ports ────────────────────────────────── */

/**
 * Hexagonal Port to interact with any Model Registry implementation.
 * The port is synchronous to the application but may perform IO under the hood.
 */
export interface ModelRegistryPort {
    listVersions(modelName: string): Promise<ModelVersion[]>;
    promoteVersion(modelName: string, semanticVersion: string): Promise<void>;
    archiveVersion(modelName: string, semanticVersion: string): Promise<void>;
    getCurrentProduction(modelName: string): Promise<ModelVersion | null>;
}

/**
 * Observer Port – anything that can consume domain events (Kafka, RabbitMQ, WebSocket, …).
 */
export interface NotificationPort {
    publish<TPayload = unknown>(event: DomainEvent<TPayload>): Promise<void>;
}

/**
 * Minimalistic, domain-level logger abstraction.
 */
export interface LoggerPort {
    debug(msg: string, ctx?: Record<string, unknown>): void;
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
}

/* ───────────────────────── Version Selection Strategy ─────────────────── */

export interface VersionSelectionStrategy {
    readonly name: string;
    select(versions: ModelVersion[]): ModelVersion | null;
}

/**
 * Picks the newest version with a successful training status.
 */
export class LatestSuccessfulStrategy implements VersionSelectionStrategy {
    public readonly name = 'LatestSuccessful';

    select(versions: ModelVersion[]): ModelVersion | null {
        return versions
            .filter(v => v.status === 'SUCCESS')
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .at(0) ?? null;
    }
}

/**
 * Picks the newest version that contains a specific tag (e.g. “production-candidate”).
 */
export class TaggedVersionStrategy implements VersionSelectionStrategy {
    public readonly name: string;

    constructor(private readonly tag: string) {
        this.name = `Tagged(${tag})`;
    }

    select(versions: ModelVersion[]): ModelVersion | null {
        return versions
            .filter(v => v.status === 'SUCCESS' && v.tags.includes(this.tag))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
            .at(0) ?? null;
    }
}

/* ─────────────────────────────── Errors ───────────────────────────────── */

export class ModelVersioningError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export class ModelVersionNotFoundError extends ModelVersioningError {}
export class NoEligibleVersionError     extends ModelVersioningError {}
export class PromotionConflictError     extends ModelVersioningError {}

/* ──────────────────────── Model Versioning Service ────────────────────── */

export interface ModelVersioningServiceOptions {
    /**
     * Concurrency guard.  It is process-local; adapter implementations
     * should implement DB-level or optimistic locking if cross-process safety
     * is required.
     */
    mutex?: Mutex;
}

export class ModelVersioningService {
    private readonly mutex: Mutex;

    /**
     * @param registryPort  Port to any model-registry implementation
     * @param notificationPort Observer port to publish domain events
     * @param logger        Logger
     * @param selectionStrategies All available selection strategies in the runtime container
     * @param options       Misc tweaks (mainly mutex injection)
     */
    constructor(
        private readonly registryPort: ModelRegistryPort,
        private readonly notificationPort: NotificationPort,
        private readonly logger: LoggerPort,
        private readonly selectionStrategies: VersionSelectionStrategy[],
        options: ModelVersioningServiceOptions = {},
    ) {
        this.mutex = options.mutex ?? new Mutex();
    }

    /**
     * Promote a model into production according to a strategy name.
     *
     * @throws NoEligibleVersionError  No model satisfied the strategy
     * @throws PromotionConflictError  Another process promoted a version concurrently
     * @throws ModelVersioningError    Any unexpected IO/loading problem
     */
    async promote(
        modelName: string,
        strategyName: string,
    ): Promise<ModelVersion> {
        const strategy = this.selectionStrategies.find(s => s.name === strategyName);
        if (!strategy) {
            throw new ModelVersioningError(`Unknown strategy “${strategyName}” provided.`);
        }

        // Concurrency guard – serialise promotions for the same process
        return this.mutex.runExclusive(async () => {
            this.logger.debug('Acquired promotion lock', { modelName, strategy: strategy.name });

            // 1) Query registry
            const versions = await this.safeListVersions(modelName);

            // 2) Select the candidate
            const candidate = strategy.select(versions);
            if (!candidate) {
                throw new NoEligibleVersionError(
                    `No eligible version found with strategy “${strategy.name}” for model “${modelName}”.`
                );
            }

            // 3) Optimistic concurrency check
            const currentProd = await this.safeGetCurrentProduction(modelName);
            if (currentProd?.semanticVersion === candidate.semanticVersion) {
                this.logger.info('Model is already in production with requested version.', {
                    modelName,
                    version: candidate.semanticVersion,
                });
                return candidate;
            }

            // 4) Promote candidate + archive previous prod
            await this.safePromoteVersion(modelName, candidate.semanticVersion);

            if (currentProd) {
                await this.safeArchiveVersion(modelName, currentProd.semanticVersion);
            }

            // 5) Publish event
            const event: DomainEvent<ModelPromotedEventPayload> = {
                id: uuidv4(),
                type: MODEL_PROMOTED_EVENT,
                timestamp: new Date(),
                payload: {
                    modelName,
                    fromVersion: currentProd?.semanticVersion ?? null,
                    toVersion: candidate.semanticVersion,
                },
            };

            await this.safePublish(event);

            this.logger.info('Promotion complete.', {
                modelName,
                toVersion: candidate.semanticVersion,
                fromVersion: currentProd?.semanticVersion ?? null,
            });

            return candidate;
        });
    }

    /* ────────────────────────── Helper Functions ─────────────────────── */

    private async safeListVersions(modelName: string): Promise<ModelVersion[]> {
        try {
            return await this.registryPort.listVersions(modelName);
        } catch (err) {
            this.logger.error('Failed to list versions.', { modelName, err });
            throw new ModelVersioningError(`Unable to list versions for ${modelName}`, err);
        }
    }

    private async safeGetCurrentProduction(modelName: string): Promise<ModelVersion | null> {
        try {
            return await this.registryPort.getCurrentProduction(modelName);
        } catch (err) {
            this.logger.error('Failed to read current production version.', { modelName, err });
            throw new ModelVersioningError(`Unable to read current production for ${modelName}`, err);
        }
    }

    private async safePromoteVersion(modelName: string, semanticVersion: string): Promise<void> {
        try {
            await this.registryPort.promoteVersion(modelName, semanticVersion);
        } catch (err: any) {
            if (err?.code === 'CONFLICT') { // adapter-defined conflict marker
                throw new PromotionConflictError(
                    `Concurrent promotion detected for ${modelName}@${semanticVersion}`,
                    err,
                );
            }
            this.logger.error('Failed to promote version.', { modelName, semanticVersion, err });
            throw new ModelVersioningError(`Unable to promote version ${semanticVersion}`, err);
        }
    }

    private async safeArchiveVersion(modelName: string, semanticVersion: string): Promise<void> {
        try {
            await this.registryPort.archiveVersion(modelName, semanticVersion);
        } catch (err) {
            this.logger.warn('Archiving previous production failed (non-blocking).', {
                modelName,
                semanticVersion,
                err,
            });
            // Archiving errors are logged but do not fail the promotion
        }
    }

    private async safePublish(event: DomainEvent<any>): Promise<void> {
        try {
            await this.notificationPort.publish(event);
        } catch (err) {
            this.logger.error('Failed to publish domain event.', { event, err });
            // Non-blocking – business operation succeeded; alert but don’t fail
        }
    }
}

/* ────────────────────── Factory for Service Creation ──────────────────── */

export interface ModelVersioningServiceFactoryProps {
    registryPort: ModelRegistryPort;
    notificationPort: NotificationPort;
    logger: LoggerPort;
}

/**
 * Factory Pattern – centralises instantiation in one convenient helper to keep
 * the DI container configuration lean.
 */
export function createModelVersioningService(
    props: ModelVersioningServiceFactoryProps,
): ModelVersioningService {
    const strategies: VersionSelectionStrategy[] = [
        new LatestSuccessfulStrategy(),
        new TaggedVersionStrategy('production-candidate'),
    ];

    return new ModelVersioningService(
        props.registryPort,
        props.notificationPort,
        props.logger,
        strategies,
    );
}
```