```typescript
/**
 * src/module_3.ts
 *
 * Domain-level implementation for model versioning within the hexagonal core of
 * InsightHexaAI.  The service encapsulates all business rules about how model
 * versions are assigned, validated, and persisted—independent of any concrete
 * registry (MLflow, S3, TensorFlow Hub, etc.).  A Strategy + Factory pattern
 * makes versioning policies (SemVer, Calendar Versioning, incremental, …)
 * completely swappable at runtime, while the registry itself is accessed solely
 * through a “port” interface (IModelRegistryPort).
 */

import { inc as semverInc, maxSatisfying, valid as isSemVerValid } from 'semver';

/* -------------------------------------------------------------------------- */
/*                               Custom Errors                                */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the generated version already exists in the registry.
 */
export class VersionConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VersionConflictError';
    }
}

/**
 * Thrown when a candidate version is invalid for the chosen strategy.
 */
export class InvalidVersionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidVersionError';
    }
}

/* -------------------------------------------------------------------------- */
/*                               Strategy Types                               */
/* -------------------------------------------------------------------------- */

/**
 * Policy identifiers for the VersioningStrategyFactory.
 */
export enum VersioningStrategyType {
    SEMVER = 'SEMVER',
    CALVER = 'CALVER',
    INCREMENTAL = 'INCREMENTAL',
}

/**
 * Shape of an implementation that can generate and validate model versions.
 */
export interface VersioningStrategy {
    /**
     * Produce the next version string, given an existing set of versions.
     */
    getNextVersion(currentVersions: readonly string[]): string;

    /**
     * Validate an externally supplied version string.
     */
    validate(version: string): boolean;
}

/* -------------------------------------------------------------------------- */
/*                       Strategy Implementations (3×)                        */
/* -------------------------------------------------------------------------- */

/**
 * Versioning that follows semantic-versioning (major.minor.patch).
 */
class SemVerStrategy implements VersioningStrategy {
    private readonly bump: 'major' | 'minor' | 'patch';

    constructor(bump: 'major' | 'minor' | 'patch' = 'patch') {
        this.bump = bump;
    }

    public getNextVersion(currentVersions: readonly string[]): string {
        const validVersions = currentVersions.filter(v => isSemVerValid(v));
        const latest = maxSatisfying(validVersions, '*') ?? '0.0.0';
        const next = semverInc(latest, this.bump);

        if (!next) {
            throw new InvalidVersionError(`Unable to bump version from ${latest}`);
        }
        return next;
    }

    public validate(version: string): boolean {
        return Boolean(isSemVerValid(version));
    }
}

/**
 * Calendar versioning: YYYY.MM.DD[.n]
 * If multiple releases occur on the same day, the optional counter is incremented.
 */
class CalendarVersionStrategy implements VersioningStrategy {
    public getNextVersion(currentVersions: readonly string[]): string {
        const todayPrefix = this.todayPrefix(); // e.g., 2024.03.01
        const todaysVersions = currentVersions
            .filter(v => v.startsWith(todayPrefix))
            .map(v => Number(v.split('.')[3] ?? 0));

        const nextCounter = (todaysVersions.length ? Math.max(...todaysVersions) : 0) + 1;
        return `${todayPrefix}.${nextCounter}`;
    }

    public validate(version: string): boolean {
        return /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(version);
    }

    private todayPrefix(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getUTCFullYear()}.${pad(now.getUTCMonth() + 1)}.${pad(now.getUTCDate())}`;
    }
}

/**
 * Simple integer increments: 1, 2, 3, …
 */
class IncrementalStrategy implements VersioningStrategy {
    public getNextVersion(currentVersions: readonly string[]): string {
        const numeric = currentVersions
            .map(v => Number(v))
            .filter(n => !Number.isNaN(n));

        const next = (numeric.length ? Math.max(...numeric) : 0) + 1;
        return `${next}`;
    }

    public validate(version: string): boolean {
        return /^\d+$/.test(version);
    }
}

/* -------------------------------------------------------------------------- */
/*                         Strategy Factory (Abstract)                        */
/* -------------------------------------------------------------------------- */

export interface VersioningStrategyFactoryOptions {
    bump?: 'major' | 'minor' | 'patch'; // Only used by SemVerStrategy
}

export class VersioningStrategyFactory {
    public static create(
        type: VersioningStrategyType,
        opts: VersioningStrategyFactoryOptions = {},
    ): VersioningStrategy {
        switch (type) {
            case VersioningStrategyType.SEMVER:
                return new SemVerStrategy(opts.bump);
            case VersioningStrategyType.CALVER:
                return new CalendarVersionStrategy();
            case VersioningStrategyType.INCREMENTAL:
                return new IncrementalStrategy();
            default:
                /* c8 ignore next */
                throw new Error(`Unsupported strategy type: ${type}`);
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                              Registry “Port”                               */
/* -------------------------------------------------------------------------- */

/**
 * Hexagonal outbound-port (left side of the hexagon) for interacting with a
 * concrete model registry.  Implementations live in the “adapter” layer.
 */
export interface IModelRegistryPort {
    /**
     * Return all versions of a model, ordered ascending alphanumerically.
     * Implementations should cache or paginate internally as needed.
     */
    listModelVersions(modelName: string): Promise<string[]>;

    /**
     * Register the provided version along with free-form metadata (hash,
     * dataset ID, hyper-params, evaluator metrics, …).
     */
    registerModelVersion(
        modelName: string,
        version: string,
        metadata: Record<string, unknown>,
    ): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                            Domain Service (core)                           */
/* -------------------------------------------------------------------------- */

/**
 * Core domain service responsible for assigning model versions.  All business
 * rules—conflict detection, policy selection, validation—are enforced here.
 */
export class ModelVersioningService {
    private readonly registry: IModelRegistryPort;
    private readonly strategy: VersioningStrategy;

    constructor(registry: IModelRegistryPort, strategy: VersioningStrategy) {
        this.registry = registry;
        this.strategy = strategy;
    }

    /**
     * Registers a new model version generated via the configured strategy.
     *
     * @param modelName - Canonical model identifier.
     * @param metadata  - Arbitrary JSON serializable metadata.
     * @returns The version string that was persisted.
     *
     * @throws VersionConflictError  If the generated version already exists.
     * @throws InvalidVersionError   If validation fails.
     * @throws Error                 Bubble-up from registry port.
     */
    public async registerNewVersion(
        modelName: string,
        metadata: Record<string, unknown> = {},
    ): Promise<string> {
        const existing = await this.registry.listModelVersions(modelName);
        const nextVersion = this.strategy.getNextVersion(existing);

        if (existing.includes(nextVersion)) {
            throw new VersionConflictError(
                `Version '${nextVersion}' for model '${modelName}' already exists.`,
            );
        }

        if (!this.strategy.validate(nextVersion)) {
            throw new InvalidVersionError(
                `Version '${nextVersion}' is invalid for chosen strategy.`,
            );
        }

        await this.registry.registerModelVersion(modelName, nextVersion, metadata);
        return nextVersion;
    }
}

/* -------------------------------------------------------------------------- */
/*                         Convenience Factory Function                       */
/* -------------------------------------------------------------------------- */

/**
 * Helper that wires a registry port + strategy in one call.  This is purely for
 * ergonomics in composition-root code (e.g., dependency‐injection container).
 */
export function createModelVersioningService(
    registryPort: IModelRegistryPort,
    strategyType: VersioningStrategyType = VersioningStrategyType.SEMVER,
    strategyOpts: VersioningStrategyFactoryOptions = {},
): ModelVersioningService {
    const strategy = VersioningStrategyFactory.create(strategyType, strategyOpts);
    return new ModelVersioningService(registryPort, strategy);
}
```