```typescript
/***************************************************************************************************
 * File:        src/module_5.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * Description:
 *   Domain service + supporting infrastructure for model versioning.  This module demonstrates a
 *   full hexagonal approach: core business rules are expressed as pure TypeScript classes while
 *   outside-world concerns (model registries, experiment trackers, dashboards) are accessed only
 *   through ports (interfaces).  It combines several of the project’s architectural patterns:
 *
 *      • Strategy Pattern         – interchangeable version-naming schemes
 *      • Factory Pattern          – run-time selection of the scheme
 *      • Observer Pattern         – KPI dashboards / monitoring hooks are notified on changes
 *
 *   Down-stream adapters can plug into any of the ports without the core having to know whether
 *   the actual implementation talks to S3, MLflow, Snowflake, etc.
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* -----------------------------------------------------------------------------------------------
 * Domain Ports (hexagon facing the outside world)
 * --------------------------------------------------------------------------------------------- */
import {
    ExperimentTrackerPort,
    ExperimentRunParams,
} from './ports/experiment-tracker.port';

import {
    ModelRegistryPort,
    ModelRegistrationParams,
    ModelArtifactLocation,
} from './ports/model-registry.port';

import {
    MonitoringNotificationPort,
    MonitoringEvent,
} from './ports/monitoring-notification.port';

/**
 * General-purpose error thrown when version generation fails for any reason.
 */
export class VersionGenerationError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'VersionGenerationError';
    }
}

/* -----------------------------------------------------------------------------------------------
 * Strategy Pattern – how should new model versions be named?
 * --------------------------------------------------------------------------------------------- */

/**
 * A list of built-in versioning schemes.  More can be added via the factory without changing
 * existing code paths.
 */
export enum VersioningScheme {
    Semantic = 'Semantic',
    Timestamp = 'Timestamp',
    Incremental = 'Incremental',
}

/**
 * Strategy interface – each concrete implementation produces a string representation of the
 * next version given the current one (if any).
 */
export interface VersioningStrategy {
    generateNextVersion(previousVersion?: string | null): string;
}

/**
 * Semantic Versioning:  MAJOR.MINOR.PATCH
 *  – MAJOR is incremented if previous version is undefined or null
 *  – Otherwise PATCH is incremented
 */
class SemanticVersioningStrategy implements VersioningStrategy {
    private readonly semverRegExp = /^\d+\.\d+\.\d+$/;

    generateNextVersion(previousVersion?: string | null): string {
        if (!previousVersion) {
            return '1.0.0';
        }

        if (!this.semverRegExp.test(previousVersion)) {
            throw new VersionGenerationError(
                `Cannot apply semantic strategy to non-semantic version '${previousVersion}'.`,
            );
        }

        const [major, minor, patch] = previousVersion.split('.').map(Number);

        /* Business rule: first release is 1.0.0, anything else increments PATCH by 1. */
        return `${major}.${minor}.${patch + 1}`;
    }
}

/**
 * Datetime/Timestamp Versioning:  e.g. 2023-03-23T14:22:01Z
 */
class TimestampVersioningStrategy implements VersioningStrategy {
    generateNextVersion(): string {
        return new Date().toISOString();
    }
}

/**
 * Incremental integers:  v1, v2, v3, …
 */
class IncrementalVersioningStrategy implements VersioningStrategy {
    private readonly incrementRegExp = /^v?(\d+)$/i;

    generateNextVersion(previousVersion?: string | null): string {
        if (!previousVersion) {
            return 'v1';
        }

        const match = previousVersion.match(this.incrementRegExp);
        if (!match) {
            throw new VersionGenerationError(
                `Cannot apply incremental strategy to malformed version '${previousVersion}'.`,
            );
        }

        const next = Number(match[1]) + 1;
        return `v${next}`;
    }
}

/* -----------------------------------------------------------------------------------------------
 * Factory Pattern – resolve a strategy at run-time depending on user preference / config
 * --------------------------------------------------------------------------------------------- */

export class VersioningStrategyFactory {
    static create(scheme: VersioningScheme): VersioningStrategy {
        switch (scheme) {
            case VersioningScheme.Semantic:
                return new SemanticVersioningStrategy();
            case VersioningScheme.Timestamp:
                return new TimestampVersioningStrategy();
            case VersioningScheme.Incremental:
                return new IncrementalVersioningStrategy();
            default:
                // Using 'never' exhaustiveness check
                const exhaustiveCheck: never = scheme;
                throw new Error(`Unknown scheme '${exhaustiveCheck as string}'`);
        }
    }
}

/* -----------------------------------------------------------------------------------------------
 * Observer Pattern – In-process pub/sub for versioning events
 * --------------------------------------------------------------------------------------------- */

/**
 * Domain event emitted whenever a new model version is successfully registered.
 */
export interface ModelVersionCreatedEvent {
    readonly modelName: string;
    readonly version: string;
    readonly registryLocation: ModelArtifactLocation;
    readonly timestamp: Date;
}

/**
 * Strongly-typed wrapper around Node's EventEmitter to enforce correct event signatures.
 */
class VersioningEventBus extends EventEmitter {
    emitNewVersion(event: ModelVersionCreatedEvent): boolean {
        return this.emit('ModelVersionCreated', event);
    }

    onNewVersion(
        listener: (event: ModelVersionCreatedEvent) => void,
    ): this {
        return this.on('ModelVersionCreated', listener);
    }
}

/* -----------------------------------------------------------------------------------------------
 * Core Domain Service – orchestrates model registration & experiment tracking
 * --------------------------------------------------------------------------------------------- */

export interface RegisterNewModelVersionOptions {
    scheme: VersioningScheme;

    /**
     * Optional – base version to increment from; can be fetched from registry beforehand.
     */
    previousVersion?: string | null;

    /**
     * Pointer to where artefacts (model.pkl, ONNX, etc.) have been persisted.
     * The adapter for ModelRegistryPort understands the scheme (S3, NFS, HDFS, …).
     */
    artifactLocation: ModelArtifactLocation;

    /**
     * Optional – metrics to be written both to experiment tracker and model registry.
     */
    metrics?: Record<string, number>;
}

export class ModelVersioningService {
    private readonly strategy: VersioningStrategy;
    private readonly eventBus = new VersioningEventBus();

    constructor(
        scheme: VersioningScheme,
        private readonly experimentTracker: ExperimentTrackerPort,
        private readonly registry: ModelRegistryPort,
        private readonly monitoringNotifier?: MonitoringNotificationPort,
    ) {
        this.strategy = VersioningStrategyFactory.create(scheme);
    }

    /**
     * Subscribe to in-process versioning events (Observer Pattern).
     */
    public subscribe(
        listener: (event: ModelVersionCreatedEvent) => void,
    ): () => void {
        this.eventBus.onNewVersion(listener);
        return () => this.eventBus.removeListener('ModelVersionCreated', listener);
    }

    /**
     * High-level use-case boundary for registering a new model version and tying the process to an
     * experiment tracking run.  This is pure business logic with no direct knowledge of external
     * technologies.
     */
    public async registerNewVersion(
        modelName: string,
        opts: RegisterNewModelVersionOptions,
    ): Promise<ModelVersionCreatedEvent> {
        // 1. Generate next version id via strategy
        const version = this.strategy.generateNextVersion(opts.previousVersion);

        // 2. Persist metadata in the model registry
        const registrationParams: ModelRegistrationParams = {
            modelName,
            version,
            createdAt: new Date(),
            artifactLocation: opts.artifactLocation,
            metrics: opts.metrics ?? {},
        };

        await this.registry.registerModelVersion(registrationParams);

        // 3. Log experiment run
        const experimentParams: ExperimentRunParams = {
            name: `${modelName}:${version}`,
            metrics: opts.metrics,
            tags: {
                modelName,
                version,
            },
        };

        await this.experimentTracker.logRun(experimentParams);

        // 4. Emit domain events (sync) and monitoring notifications (async)
        const event: ModelVersionCreatedEvent = {
            modelName,
            version,
            registryLocation: opts.artifactLocation,
            timestamp: registrationParams.createdAt,
        };

        this.eventBus.emitNewVersion(event);

        // Asynchronously inform monitoring systems (won't block the business flow)
        void this.monitoringNotifier
            ?.notify(<MonitoringEvent>{
                type: 'MODEL_VERSION_CREATED',
                payload: event,
            })
            .catch((err) =>
                // Surface the error but do not fail the main transaction
                console.error(
                    `[MonitoringNotifier] Failed to notify: ${(err as Error).message}`,
                ),
            );

        return event;
    }
}

/* -----------------------------------------------------------------------------------------------
 * EXAMPLE USAGE (non-production, would likely live in an adapter or controller layer)
 * --------------------------------------------------------------------------------------------- */

// The code below is intentionally commented-out; it illustrates how one would wire the service
// from an application service or adapter layer, but it should not execute during a library import.
/*
import { S3ModelRegistryAdapter } from './adapters/s3-model-registry.adapter';
import { MLflowExperimentTrackerAdapter } from './adapters/mlflow-experiment-tracker.adapter';
import { KafkaMonitoringNotifierAdapter } from './adapters/kafka-monitoring-notifier.adapter';

const registry  = new S3ModelRegistryAdapter(/* creds * /);
const tracker   = new MLflowExperimentTrackerAdapter(/* url * /);
const notifier  = new KafkaMonitoringNotifierAdapter(/* brokers * /);

const versionService = new ModelVersioningService(
    VersioningScheme.Semantic,
    tracker,
    registry,
    notifier,
);

versionService.subscribe((event) => {
    console.info(`[Observer] New version registered`, event);
});

await versionService.registerNewVersion('sales_forecaster', {
    scheme: VersioningScheme.Semantic,
    artifactLocation: { bucket: 'ml-models', key: 'sales/forecaster-v2' },
    metrics: { MAE: 0.037 },
});
*/

/***************************************************************************************************
 * End of file
 ***************************************************************************************************/
```