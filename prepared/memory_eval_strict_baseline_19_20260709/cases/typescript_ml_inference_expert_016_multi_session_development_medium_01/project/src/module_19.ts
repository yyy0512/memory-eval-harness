```typescript
/********************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs (ml_inference)
 * ------------------------------------------------------------------------------------------
 *  File:        src/module_19.ts
 *  Responsibility:
 *      Core-domain module for Model Versioning—encapsulates all business rules necessary
 *      for creating, bumping, promoting, rolling-back, and deprecating model versions.
 *
 *  Architectural notes:
 *  ────────────────────
 *  • Hexagonal (ports-and-adapters) isolation: domain services rely exclusively on ports.
 *  • Strategy Pattern: pluggable versioning strategies (Semantic, Calendar, …).
 *  • Factory Pattern: central factory resolves requested strategy at runtime.
 *  • Observer Pattern: lifecycle-event emitter notifies external dashboards/alerting.
 *
 *  Production-readiness:
 *  • Robust error domain with typed, actionable errors.
 *  • Strict typing, readonly value objects, immutability where feasible.
 *  • Exhaustive state-transition validation.
 *  • Granular audit trail hooks.
 ********************************************************************************************/

// External dependencies ----------------------------------------------------
import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import * as semver from 'semver'; // npm i semver

/*********************************************************************************
 *                              Value Objects & Types
 *********************************************************************************/

/**
 * Lifecycle state of a model version within the platform.
 */
export enum VersionLifecycleState {
    Draft = 'DRAFT',
    Staging = 'STAGING',
    Production = 'PRODUCTION',
    Deprecated = 'DEPRECATED',
    Archived = 'ARCHIVED',
}

/**
 * Metadata bag associated with a model version.
 */
export interface VersionMetadata {
    trainedBy: string;               // e.g., "pipeline-42"
    trainingDataRef: string;         // e.g., "s3://bucket/path"
    metrics: Record<string, number>; // e.g., { auc: 0.92, f1: 0.78 }
    notes?: string;
    [key: string]: unknown;          // forward-compatibility
}

/**
 * Immutable domain entity representing a single model version.
 */
export class ModelVersion {
    public readonly id: string;
    public readonly modelId: string;
    public readonly version: string;
    public readonly metadata: VersionMetadata;
    public readonly createdAt: Date;
    public readonly state: VersionLifecycleState;

    constructor(params: {
        id?: string;
        modelId: string;
        version: string;
        metadata: VersionMetadata;
        createdAt?: Date;
        state?: VersionLifecycleState;
    }) {
        this.id = params.id ?? uuid();
        this.modelId = params.modelId;
        this.version = params.version;
        this.metadata = Object.freeze({ ...params.metadata });
        this.createdAt = params.createdAt ?? new Date();
        this.state = params.state ?? VersionLifecycleState.Draft;
        Object.freeze(this); // Deep immutability not guaranteed, but shallow freeze for safety
    }

    public withState(state: VersionLifecycleState): ModelVersion {
        return new ModelVersion({
            id: this.id,
            modelId: this.modelId,
            version: this.version,
            metadata: this.metadata,
            createdAt: this.createdAt,
            state,
        });
    }
}

/*********************************************************************************
 *                                Error Domain
 *********************************************************************************/

export class VersioningError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VersioningError';
    }
}

export class VersionConflictError extends VersioningError {
    constructor(version: string) {
        super(`Version conflict—model version "${version}" already exists.`);
        this.name = 'VersionConflictError';
    }
}

export class NotFoundError extends VersioningError {
    constructor(entity: string) {
        super(`${entity} not found.`);
        this.name = 'NotFoundError';
    }
}

export class InvalidStateTransitionError extends VersioningError {
    constructor(from: VersionLifecycleState, to: VersionLifecycleState) {
        super(`Invalid lifecycle transition from ${from} to ${to}.`);
        this.name = 'InvalidStateTransitionError';
    }
}

/*********************************************************************************
 *                         Ports (Hexagonal Interfaces)
 *********************************************************************************/

/**
 * Port for persistence of model versions. Implemented by adapters (e.g., SQL, NoSQL).
 */
export interface IModelRepositoryPort {
    fetchLatest(modelId: string): Promise<ModelVersion | null>;
    fetchByVersion(modelId: string, version: string): Promise<ModelVersion | null>;
    save(version: ModelVersion): Promise<void>;
    update(version: ModelVersion): Promise<void>;
}

/**
 * Port for audit-trail logging. Adapters can write to Kafka, Snowflake, etc.
 */
export interface IAuditTrailPort {
    record(event: AuditTrailEvent): Promise<void>;
}

/**
 * Audit-trail event schema.
 */
export interface AuditTrailEvent {
    id: string;
    type: 'MODEL_VERSION_CREATED' | 'MODEL_VERSION_PROMOTED' | 'MODEL_VERSION_ROLLED_BACK' | 'MODEL_VERSION_DEPRECATED';
    modelId: string;
    version: string;
    metadata: Record<string, unknown>;
    timestamp: number;
}

/*********************************************************************************
 *                    Versioning Strategy (Strategy Pattern)
 *********************************************************************************/

/**
 * Input describing the bump that should be applied to the previous version.
 * For Semantic versioning, 'bump' could be "major" | "minor" | "patch".
 */
export type VersionBumpInfo = Record<string, unknown>;

export interface IVersioningStrategy {
    /**
     * Compute the next version string given the previous version and bump directives.
     */
    computeNextVersion(previousVersion: string | null, bumpInfo: VersionBumpInfo): string;
}

class SemanticVersionStrategy implements IVersioningStrategy {
    computeNextVersion(previousVersion: string | null, bumpInfo: VersionBumpInfo): string {
        const bump = bumpInfo.bump ?? 'patch';
        if (!previousVersion) {
            return '1.0.0';
        }
        if (!semver.valid(previousVersion)) {
            throw new VersioningError(`Previous version "${previousVersion}" is not valid semver.`);
        }
        return semver.inc(previousVersion, bump as semver.ReleaseType) ?? (() => {
            throw new VersioningError('Unable to increment semver.');
        })();
    }
}

class CalendarVersionStrategy implements IVersioningStrategy {
    /**
     * Calendar versioning: YYYY.MM.DD[.N]
     * If multiple versions created on same day, suffix increments.
     */
    computeNextVersion(previousVersion: string | null): string {
        const datePrefix = new Date().toISOString().substring(0, 10).replace(/-/g, '.'); // YYYY.MM.DD
        if (!previousVersion?.startsWith(datePrefix)) {
            return `${datePrefix}.0`;
        }
        const lastNumber = Number(previousVersion.split('.').pop() ?? 0);
        return `${datePrefix}.${lastNumber + 1}`;
    }
}

/**
 * Factory Pattern—resolves concrete strategy by name.
 */
export class VersioningStrategyFactory {
    static get(strategyName: 'semantic' | 'calendar' = 'semantic'): IVersioningStrategy {
        switch (strategyName) {
            case 'semantic':
                return new SemanticVersionStrategy();
            case 'calendar':
                return new CalendarVersionStrategy();
            default: {
                // Exhaustive safeguard
                const _exhaustiveCheck: never = strategyName;
                throw new VersioningError(`Unsupported strategy "${_exhaustiveCheck}".`);
            }
        }
    }
}

/*********************************************************************************
 *                    Observer Pattern ‑ Lifecycle Event Bus
 *********************************************************************************/

export type ModelVersioningEvents =
    | { type: 'created'; payload: ModelVersion }
    | { type: 'promoted'; payload: ModelVersion }
    | { type: 'rolled_back'; payload: ModelVersion }
    | { type: 'deprecated'; payload: ModelVersion };

export class ModelVersioningEventBus extends EventEmitter {
    emitEvent(event: ModelVersioningEvents): boolean {
        return this.emit(event.type, event.payload);
    }
}

/*********************************************************************************
 *                             Domain Service
 *********************************************************************************/

/**
 * Domain service encapsulating all business rules around Model Versioning.
 */
export class ModelVersioningService {
    private readonly repo: IModelRepositoryPort;
    private readonly audit: IAuditTrailPort;
    private readonly strategy: IVersioningStrategy;
    private readonly eventBus: ModelVersioningEventBus;

    constructor(
        repo: IModelRepositoryPort,
        audit: IAuditTrailPort,
        strategy: IVersioningStrategy,
        eventBus: ModelVersioningEventBus,
    ) {
        this.repo = repo;
        this.audit = audit;
        this.strategy = strategy;
        this.eventBus = eventBus;
    }

    /**
     * Register the first version for a given model.
     */
    async registerInitialVersion(modelId: string, metadata: VersionMetadata): Promise<ModelVersion> {
        const existing = await this.repo.fetchLatest(modelId);
        if (existing) {
            throw new VersionConflictError(existing.version);
        }

        const version = this.strategy.computeNextVersion(null, {});

        const modelVersion = new ModelVersion({
            modelId,
            version,
            metadata,
        });

        await this.repo.save(modelVersion);
        await this.emitAuditAndEvent('MODEL_VERSION_CREATED', modelVersion);
        return modelVersion;
    }

    /**
     * Bump a model to the next version following the configured versioning strategy.
     */
    async bumpVersion(
        modelId: string,
        bumpInfo: VersionBumpInfo,
        metadata: VersionMetadata,
    ): Promise<ModelVersion> {
        const latest = await this.repo.fetchLatest(modelId);
        const nextVersion = this.strategy.computeNextVersion(latest?.version ?? null, bumpInfo);

        // pessimistic check to avoid duplicates
        if ((await this.repo.fetchByVersion(modelId, nextVersion)) !== null) {
            throw new VersionConflictError(nextVersion);
        }

        const newVersion = new ModelVersion({ modelId, version: nextVersion, metadata });
        await this.repo.save(newVersion);
        await this.emitAuditAndEvent('MODEL_VERSION_CREATED', newVersion);
        return newVersion;
    }

    /**
     * Promote a version through lifecycle stages. Allowed transitions:
     * Draft → Staging → Production
     * Production → Deprecated → Archived
     */
    async promoteVersion(modelId: string, targetVersion: string, toState: VersionLifecycleState): Promise<ModelVersion> {
        const current = await this.repo.fetchByVersion(modelId, targetVersion);
        if (!current) {
            throw new NotFoundError(`Model version ${targetVersion}`);
        }

        if (!this.isValidTransition(current.state, toState)) {
            throw new InvalidStateTransitionError(current.state, toState);
        }

        const updated = current.withState(toState);
        await this.repo.update(updated);

        const auditEventType = toState === VersionLifecycleState.Production
            ? 'MODEL_VERSION_PROMOTED'
            : toState === VersionLifecycleState.Deprecated
                ? 'MODEL_VERSION_DEPRECATED'
                : 'MODEL_VERSION_CREATED';

        await this.emitAuditAndEvent(auditEventType as AuditTrailEvent['type'], updated);
        return updated;
    }

    /**
     * Roll-back to a previous production version.
     * 1. Target previousVersion must be Production.
     * 2. Current production version becomes Deprecated.
     */
    async rollbackToVersion(modelId: string, previousVersion: string): Promise<{ newProd: ModelVersion; deprecated: ModelVersion }> {
        const target = await this.repo.fetchByVersion(modelId, previousVersion);
        if (!target) {
            throw new NotFoundError(`Model version ${previousVersion}`);
        }
        if (target.state !== VersionLifecycleState.Production) {
            throw new InvalidStateTransitionError(target.state, VersionLifecycleState.Production);
        }

        // Deprecate current production
        const latest = await this.repo.fetchLatest(modelId);
        if (latest && latest.version !== target.version && latest.state === VersionLifecycleState.Production) {
            const deprecated = latest.withState(VersionLifecycleState.Deprecated);
            await this.repo.update(deprecated);
            await this.emitAuditAndEvent('MODEL_VERSION_DEPRECATED', deprecated);
        }

        // (Re)promote target to Production
        const promoted = target.withState(VersionLifecycleState.Production);
        await this.repo.update(promoted);
        await this.emitAuditAndEvent('MODEL_VERSION_ROLLED_BACK', promoted);

        return { newProd: promoted, deprecated: latest! };
    }

    /*********************************************************************************
     *                          Private / Helper Functions
     *********************************************************************************/

    private async emitAuditAndEvent(type: AuditTrailEvent['type'], version: ModelVersion): Promise<void> {
        const audit: AuditTrailEvent = {
            id: uuid(),
            type,
            modelId: version.modelId,
            version: version.version,
            metadata: { state: version.state },
            timestamp: Date.now(),
        };
        await this.audit.record(audit);

        // Observer notifications are fire-and-forget
        this.eventBus.emitEvent({
            type:
                type === 'MODEL_VERSION_CREATED' ? 'created'
                    : type === 'MODEL_VERSION_PROMOTED' ? 'promoted'
                        : type === 'MODEL_VERSION_ROLLED_BACK' ? 'rolled_back'
                            : 'deprecated',
            payload: version,
        });
    }

    private isValidTransition(from: VersionLifecycleState, to: VersionLifecycleState): boolean {
        const allowed: Record<VersionLifecycleState, VersionLifecycleState[]> = {
            [VersionLifecycleState.Draft]: [VersionLifecycleState.Staging],
            [VersionLifecycleState.Staging]: [VersionLifecycleState.Production],
            [VersionLifecycleState.Production]: [VersionLifecycleState.Deprecated],
            [VersionLifecycleState.Deprecated]: [VersionLifecycleState.Archived],
            [VersionLifecycleState.Archived]: [],
        };
        return allowed[from].includes(to);
    }
}

/*********************************************************************************
 *                              MOCK / STUB ADAPTERS
 *      NOTE: For demonstration purposes only. Real adapters will live in the
 *            infrastructure layer (outside the hexagon).
 *********************************************************************************/

class InMemoryModelRepositoryAdapter implements IModelRepositoryPort {
    private store = new Map<string, ModelVersion[]>();

    async fetchLatest(modelId: string): Promise<ModelVersion | null> {
        const versions = this.store.get(modelId) ?? [];
        // latest defined as max createdAt
        return versions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
    }

    async fetchByVersion(modelId: string, version: string): Promise<ModelVersion | null> {
        return (this.store.get(modelId) ?? []).find(v => v.version === version) ?? null;
    }

    async save(version: ModelVersion): Promise<void> {
        const arr = this.store.get(version.modelId) ?? [];
        arr.push(version);
        this.store.set(version.modelId, arr);
    }

    async update(version: ModelVersion): Promise<void> {
        const arr = this.store.get(version.modelId) ?? [];
        const idx = arr.findIndex(v => v.version === version.version);
        if (idx === -1) throw new NotFoundError(`Model version ${version.version}`);
        arr[idx] = version;
        this.store.set(version.modelId, arr);
    }
}

class ConsoleAuditTrailAdapter implements IAuditTrailPort {
    async record(event: AuditTrailEvent): Promise<void> {
        // In production, write to Kafka, S3, Snowflake…
        // eslint-disable-next-line no-console
        console.info('[AUDIT]', JSON.stringify(event, null, 2));
    }
}

/*********************************************************************************
 *                             USAGE EXAMPLE (DEV ONLY)
 *********************************************************************************/

// The following block serves as a smoke test and illustration; remove in production.
if (process.env.NODE_ENV !== 'production') {
    (async () => {
        const repo = new InMemoryModelRepositoryAdapter();
        const audit = new ConsoleAuditTrailAdapter();
        const eventBus = new ModelVersioningEventBus();

        // Subscribe to Observer events
        eventBus.on('created', v => console.log(`Observer: New version created ${v.version}`));
        eventBus.on('promoted', v => console.log(`Observer: Version promoted ${v.version}`));

        const strategy = VersioningStrategyFactory.get('semantic');
        const service = new ModelVersioningService(repo, audit, strategy, eventBus);

        const mv1 = await service.registerInitialVersion('model-A', { trainedBy: 'init', trainingDataRef: 's3://...' });
        await service.promoteVersion('model-A', mv1.version, VersionLifecycleState.Staging);
        await service.promoteVersion('model-A', mv1.version, VersionLifecycleState.Production);

        const mv2 = await service.bumpVersion('model-A', { bump: 'minor' }, { trainedBy: 'pipeline-2', trainingDataRef: 's3://...' });
        console.log('Created version:', mv2.version);
    })().catch(err => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
    });
}
```