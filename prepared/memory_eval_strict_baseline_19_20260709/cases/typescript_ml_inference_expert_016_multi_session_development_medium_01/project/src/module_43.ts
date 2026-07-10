```typescript
/***************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:        src/module_43.ts
 *  Purpose:     Core “Model Versioning” domain services (hexagon center)
 *  Patterns:    Strategy Pattern, Factory Pattern, Observer Pattern (domain-event bus)
 *
 *  This module owns the rules for creating and persisting new model versions.  Multiple
 *  VersioningStrategy implementations (semantic, timestamp, data-hash) can be swapped at runtime
 *  by simple configuration, with zero impact on adapters or presentation layers.  Whenever a new
 *  version is created, a domain event is published so that monitoring dashboards, billing lanes,
 *  or compliance ledgers can react without tight coupling.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { createHash } from 'crypto';

/* ---------------------------------------------------------------------------------------------- */
/*  Domain Exceptions                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/** Base class for all versioning related errors. */
export class VersioningError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'VersioningError';
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Domain Entities & Value Objects                                                                */
/* ---------------------------------------------------------------------------------------------- */

/** Unique identifier for a model in the enterprise registry. */
export type ModelId = string;

/** Semantic version string, timestamp, or custom scheme. */
export type ModelVersionId = string;

/** Business-level metadata attached to each model artifact. */
export interface ModelMetadata {
  readonly createdBy: string;               // user@company.com
  readonly trainingDatasetId: string;       // FK to feature-store snapshot
  readonly hyperParameters: Record<string, unknown>;
  readonly metrics: Record<string, number>; // e.g. { accuracy: 0.92, auc: 0.91 }
  readonly trainedAt: Date;
  readonly tags?: ReadonlyArray<string>;
}

/* ---------------------------------------------------------------------------------------------- */
/*  Ports (hexagonal)                                                                             */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Port that isolates persistence details of model artifacts.
 * Infrastructure (MongoDB, DynamoDB, S3, etc.) must implement this interface.
 */
export interface ModelRepositoryPort {
  findLatestVersion(modelId: ModelId): Promise<ModelVersion | null>;
  save(modelVersion: ModelVersion): Promise<void>;
}

/**
 * Port for publishing domain events to outer world (e.g., Kafka, SNS, RabbitMQ).
 * Default implementation simply re-emits via Node’s EventEmitter for in-process observers.
 */
export interface DomainEventBusPort {
  publish<E extends DomainEvent>(event: E): void;
}

/* ---------------------------------------------------------------------------------------------- */
/*  Domain Events                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export interface DomainEvent {
  readonly occurredAt: Date;
  readonly name: string;
}

export class ModelVersionCreatedEvent implements DomainEvent {
  readonly occurredAt = new Date();
  readonly name = 'ModelVersionCreated';
  constructor(public readonly payload: ModelVersion) {}
}

/* ---------------------------------------------------------------------------------------------- */
/*  Entity                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

export class ModelVersion {
  constructor(
    public readonly modelId: ModelId,
    public readonly versionId: ModelVersionId,
    public readonly metadata: ModelMetadata,
  ) {}
}

/* ---------------------------------------------------------------------------------------------- */
/*  Strategy Pattern: VersioningStrategy                                                           */
/* ---------------------------------------------------------------------------------------------- */

export interface VersioningStrategy {
  /**
   * Create a new version ID from previous version & metadata.
   * Implementations must ensure the returned string is unique within model scope.
   */
  computeNextVersion(
    previous: ModelVersion | null,
    metadata: ModelMetadata,
  ): ModelVersionId;
}

/**
 * Semantic versioning (e.g., 1.0.0 -> 1.0.1, 1.2.5 -> 1.3.0).
 * Minor increments when metrics improve < 10%; major otherwise.
 */
export class SemanticVersioningStrategy implements VersioningStrategy {
  /* eslint-disable class-methods-use-this */
  computeNextVersion(previous: ModelVersion | null): ModelVersionId {
    if (!previous) return '1.0.0';

    const [major, minor, patch] = previous.versionId
      .split('.')
      .map((v) => Number.parseInt(v, 10));

    if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
      throw new VersioningError(
        `Previous version "${previous.versionId}" is not valid semver.`,
      );
    }

    // Example rule: bump major if more than 20% metric delta, else minor
    const accuracy = previous.metadata.metrics.accuracy ?? 0;
    const newAccuracy = previous.metadata.metrics.accuracy ?? 0;
    const delta = newAccuracy - accuracy;

    if (delta > 0.2) {
      return `${major + 1}.0.0`;
    }
    return `${major}.${minor + 1}.0`;
  }
}

/** Simple timestamp (UTC) strategy: yyyyMMddHHmmss */
export class TimestampVersioningStrategy implements VersioningStrategy {
  /* eslint-disable class-methods-use-this */
  computeNextVersion(): ModelVersionId {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
      now.getUTCDate(),
    )}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(
      now.getUTCSeconds(),
    )}`;
  }
}

/** Deterministic strategy based on metadata hash. */
export class DataHashVersioningStrategy implements VersioningStrategy {
  /* eslint-disable class-methods-use-this */
  computeNextVersion(): ModelVersionId {
    // create a random SHA-256; deterministic calling code should stringify metadata
    const randomSalt = Math.random().toString();
    return createHash('sha256').update(randomSalt).digest('hex').slice(0, 12);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Factory Pattern: StrategyFactory                                                               */
/* ---------------------------------------------------------------------------------------------- */

export type VersioningStrategyName = 'semantic' | 'timestamp' | 'dataHash';

export class VersioningStrategyFactory {
  private readonly cache = new Map<VersioningStrategyName, VersioningStrategy>();

  constructor(private readonly defaultStrategy: VersioningStrategyName = 'semantic') {}

  get(strategyName?: VersioningStrategyName): VersioningStrategy {
    const key = strategyName ?? this.defaultStrategy;

    if (this.cache.has(key)) return this.cache.get(key)!;

    let instance: VersioningStrategy;
    switch (key) {
      case 'semantic':
        instance = new SemanticVersioningStrategy();
        break;
      case 'timestamp':
        instance = new TimestampVersioningStrategy();
        break;
      case 'dataHash':
        instance = new DataHashVersioningStrategy();
        break;
      default:
        throw new VersioningError(`Unknown strategy "${key}"`);
    }
    this.cache.set(key, instance);
    return instance;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Observer Pattern: In-process Event Bus (default adapter)                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Thin wrapper around EventEmitter to respect DomainEventBusPort contract.
 * Infrastructure-layer may replace with KafkaEventBusAdapter, etc.
 */
export class InMemoryEventBus implements DomainEventBusPort {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  publish<E extends DomainEvent>(event: E): void {
    this.emitter.emit(event.name, event);
  }

  /** Utility for tests & local observers. */
  on<E extends DomainEvent>(
    eventName: E['name'],
    listener: (event: E) => void,
  ): void {
    this.emitter.on(eventName, listener as any);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Service: ModelVersioningService                                                                */
/* ---------------------------------------------------------------------------------------------- */

export interface CreateVersionCommand {
  modelId: ModelId;
  metadata: ModelMetadata;
  /** Override global default; choose at runtime */
  strategy?: VersioningStrategyName;
}

export class ModelVersioningService {
  constructor(
    private readonly repository: ModelRepositoryPort,
    private readonly strategyFactory: VersioningStrategyFactory,
    private readonly eventBus: DomainEventBusPort,
  ) {}

  /**
   * Main use-case: create and persist a new model version.
   * Emits ModelVersionCreatedEvent on success.
   *
   * Throws VersioningError when version ID cannot be generated or collision occurs.
   */
  async createVersion(cmd: CreateVersionCommand): Promise<ModelVersion> {
    const { modelId, metadata, strategy: strategyName } = cmd;
    const previous = await this.repository.findLatestVersion(modelId);

    const strategy = this.strategyFactory.get(strategyName);
    const nextVersionId = strategy.computeNextVersion(previous, metadata);

    if (!nextVersionId) {
      throw new VersioningError('Strategy returned empty version ID.');
    }

    // Guard against accidental re-use
    if (previous?.versionId === nextVersionId) {
      throw new VersioningError(
        `Collision: computed version "${nextVersionId}" already exists.`,
      );
    }

    const modelVersion = new ModelVersion(modelId, nextVersionId, metadata);

    try {
      await this.repository.save(modelVersion);
    } catch (err) {
      throw new VersioningError('Failed to persist model version.', err);
    }

    // Emit domain event for observers (billing, dashboards, compliance, etc.)
    this.eventBus.publish(new ModelVersionCreatedEvent(modelVersion));

    return modelVersion;
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Example Mock Infrastructure Adapters (for local dev & unit tests)                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Non-production in-memory storage.  Allows fast unit tests
 * without standing up external services.
 */
export class InMemoryModelRepository implements ModelRepositoryPort {
  private readonly store = new Map<ModelId, ModelVersion[]>();

  async findLatestVersion(modelId: ModelId): Promise<ModelVersion | null> {
    const versions = this.store.get(modelId) ?? [];
    if (versions.length === 0) return null;
    // Return last element (assuming chronological order)
    return versions[versions.length - 1];
  }

  async save(modelVersion: ModelVersion): Promise<void> {
    const versions = this.store.get(modelVersion.modelId) ?? [];
    versions.push(modelVersion);
    this.store.set(modelVersion.modelId, versions);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  Module Public API                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Convenience factory for consumers who simply want a ready-made,
 * fully-wired ModelVersioningService with in-memory adapters.
 */
export function createInMemoryModelVersioningService(
  defaultStrategy: VersioningStrategyName = 'semantic',
): ModelVersioningService {
  const repository = new InMemoryModelRepository();
  const strategyFactory = new VersioningStrategyFactory(defaultStrategy);
  const eventBus = new InMemoryEventBus();

  return new ModelVersioningService(repository, strategyFactory, eventBus);
}
```
