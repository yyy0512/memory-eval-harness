```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * Module 28 – Model Versioning Hexagon
 *
 * Scope
 * -----
 * 1. Domain entity representing a model version (sem-ver compliant)
 * 2. Strategies to increment a version (Strategy Pattern)
 * 3. Repository port to persist/retrieve model versions (Hexagonal architecture)
 * 4. Domain service that orchestrates version bumps & notifies observers
 * 5. Observer pattern implementation using Node.js EventEmitter
 *
 * NOTE:
 *  • Adapters (DB, REST, message bus, etc.) live in other files.
 *  • This file purposefully contains only the domain/hex-core logic.
 */

import { EventEmitter } from 'events';

//#region ──────────────────────────────────────────────────── Shared Types & Errors

/**
 * A plain Semantic Version.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  label?: string; // e.g., alpha, beta, rc.1
}

/**
 * Domain-level errors thrown by the versioning hexagon.
 */
export class ModelVersioningError extends Error {
  constructor(message: string) {
    super(`[ModelVersioning] ${message}`);
  }
}

//#endregion

//#region ──────────────────────────────────────────────────── Entity – ModelVersion

/**
 * Entity capturing immutable details for a single model release.
 */
export class ModelVersion {
  readonly id: string; // UUID or ULID provided by repository
  readonly semver: SemVer;
  readonly createdAt: Date;
  readonly createdBy: string; // userId, service account, etc.
  readonly commitHash?: string;
  readonly notes?: string;

  constructor(params: {
    id: string;
    semver: SemVer;
    createdAt: Date;
    createdBy: string;
    commitHash?: string;
    notes?: string;
  }) {
    this.id = params.id;
    this.semver = Object.freeze({ ...params.semver });
    this.createdAt = new Date(params.createdAt);
    this.createdBy = params.createdBy;
    this.commitHash = params.commitHash;
    this.notes = params.notes;
    Object.freeze(this);
  }

  toString(): string {
    const { major, minor, patch, label } = this.semver;
    const pre = label ? `-${label}` : '';
    return `v${major}.${minor}.${patch}${pre}`;
  }
}

//#endregion

//#region ──────────────────────────────────────────────────── Strategy Pattern

/**
 * Strategy contract for deciding how to go from one version to the next.
 * Different teams/clients might choose semantic bumping, calendar versioning, etc.
 */
export interface VersioningStrategy {
  readonly name: string;
  bump(current: SemVer): SemVer;
}

/**
 * Bumps patch → minor → major in Semantic Version order, depending on flags.
 */
export class SemanticVersioningStrategy implements VersioningStrategy {
  readonly name = 'semantic';

  constructor(private readonly importance: 'patch' | 'minor' | 'major' = 'patch') {}

  bump(current: SemVer): SemVer {
    const { major, minor, patch } = current;
    switch (this.importance) {
      case 'patch':
        return { major, minor, patch: patch + 1 };
      case 'minor':
        return { major, minor: minor + 1, patch: 0 };
      case 'major':
        return { major: major + 1, minor: 0, patch: 0 };
      default:
        throw new ModelVersioningError(`Unknown importance: ${this.importance}`);
    }
  }
}

/**
 * Calendar versioning (CalVer) strategy: YYYY.MM.DD[.n]
 * Multiple releases per day increment trailing revision.
 */
export class CalendarVersioningStrategy implements VersioningStrategy {
  readonly name = 'calendar';

  bump(current: SemVer): SemVer {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    if (current.major === year && current.minor === month && current.patch === day) {
      // same day ⇒ incremental revision label
      const revisionNbr = (current.label ? parseInt(current.label) : 0) + 1;
      return { major: year, minor: month, patch: day, label: revisionNbr.toString() };
    }
    return { major: year, minor: month, patch: day };
  }
}

/**
 * Factory that returns a concrete strategy implementation.
 * Future expansion: load from DI container or config service.
 */
export class VersioningStrategyFactory {
  static create(
    strategyName: string,
    options?: Record<string, unknown>,
  ): VersioningStrategy {
    switch (strategyName) {
      case 'semantic':
        return new SemanticVersioningStrategy(
          (options?.importance as 'patch' | 'minor' | 'major') ?? 'patch',
        );
      case 'calendar':
        return new CalendarVersioningStrategy();
      default:
        throw new ModelVersioningError(`Unsupported strategy: ${strategyName}`);
    }
  }
}

//#endregion

//#region ──────────────────────────────────────────────────── Ports (Hexagon)

/**
 * Hexagon port to persist/retrieve model versions.
 * Outgoing adapters: Postgres, DynamoDB, Snowflake, etc.
 */
export interface ModelVersionRepositoryPort {
  findLatest(modelId: string): Promise<ModelVersion | null>;
  save(modelId: string, version: ModelVersion): Promise<void>;
}

/**
 * Event fired when a new model version is created.
 * Observer pattern lets dashboards, alerting systems, etc. subscribe.
 */
export interface ModelVersionedEvent {
  modelId: string;
  version: ModelVersion;
}

/**
 * Observer interface for anything interested in version events.
 * Examples: SlackNotifier, MetricsCollector, WebhookPublisher, etc.
 */
export interface ModelVersionObserver {
  onModelVersioned(event: ModelVersionedEvent): Promise<void>;
}

//#endregion

//#region ──────────────────────────────────────────────────── Domain Service

/**
 * Domain service orchestrating model version creation.
 * Isolation of business rules from IO concerns.
 */
export class ModelVersioningService {
  private readonly emitter = new EventEmitter({ captureRejections: true });

  constructor(
    private readonly repository: ModelVersionRepositoryPort,
    private readonly strategy: VersioningStrategy,
  ) {
    // EventEmitter error handling
    this.emitter.on('error', (err) => {
      // Intentionally not re-throwing; could integrate with central logger
      // eslint-disable-next-line no-console
      console.error(err);
    });
  }

  /**
   * Attach observers to the internal event bus.
   */
  registerObserver(observer: ModelVersionObserver): void {
    this.emitter.on('model_versioned', (event: ModelVersionedEvent) =>
      observer.onModelVersioned(event).catch((err) => {
        this.emitter.emit('error', err);
      }),
    );
  }

  /**
   * The only method exposed to application layer: bump & persist version.
   */
  async createNextVersion(params: {
    modelId: string;
    actor: string;
    commitHash?: string;
    notes?: string;
  }): Promise<ModelVersion> {
    const { modelId, actor, commitHash, notes } = params;

    // 1. Retrieve current version
    const currentVersion = await this.repository.findLatest(modelId);
    const baseSemVer: SemVer = currentVersion
      ? currentVersion.semver
      : { major: 0, minor: 0, patch: 0 };

    // 2. Apply strategy bump
    let nextSemVer: SemVer;
    try {
      nextSemVer = this.strategy.bump(baseSemVer);
    } catch (err) {
      throw new ModelVersioningError(
        `Strategy failure for model "${modelId}": ${(err as Error).message}`,
      );
    }

    // 3. Create entity
    const next = new ModelVersion({
      id: crypto.randomUUID(),
      semver: nextSemVer,
      createdAt: new Date(),
      createdBy: actor,
      commitHash,
      notes,
    });

    // 4. Persist
    try {
      await this.repository.save(modelId, next);
    } catch (err) {
      throw new ModelVersioningError(
        `Repository failure for model "${modelId}": ${(err as Error).message}`,
      );
    }

    // 5. Emit observer event (fire-and-forget)
    this.emitter.emit('model_versioned', { modelId, version: next } satisfies ModelVersionedEvent);

    return next;
  }
}

//#endregion

//#region ──────────────────────────────────────────────────── Example Observer

/**
 * A simple built-in observer that prints to console (placeholder).
 * Real observers live in adapter layer.
 */
export class ConsoleVersionObserver implements ModelVersionObserver {
  async onModelVersioned(event: ModelVersionedEvent): Promise<void> {
    // eslint-disable-next-line no-console
    console.info(
      `[ModelVersioning] New version created: model="${event.modelId}" → ${event.version.toString()}`,
    );
  }
}

//#endregion

//#region ──────────────────────────────────────────────────── Helper

/* eslint-disable @typescript-eslint/consistent-type-imports */
// Fix for Deno/Vitest global namespace lacking crypto
declare const crypto: { randomUUID(): string };

/* istanbul ignore if - runtime fallback for Node<15 */
if (typeof globalThis.crypto === 'undefined') {
  // @ts-expect-error dynamic import
  // eslint-disable-next-line @typescript-eslint/no-var-requires, no-var
  const { randomUUID } = require('crypto') as typeof import('crypto');
  (globalThis as any).crypto = { randomUUID };
}
/* eslint-enable @typescript-eslint/consistent-type-imports */

//#endregion
```