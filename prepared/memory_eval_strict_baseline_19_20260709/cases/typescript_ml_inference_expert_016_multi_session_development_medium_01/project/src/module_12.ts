```typescript
/* =====================================================================================
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * File: src/module_12.ts
 *
 * Domain: Model Versioning (Hexagonal Architecture – Core Domain Layer)
 * -------------------------------------------------------------------------------------
 * Responsibilities
 *  - Provide pluggable strategies for automatically generating model versions.
 *  - Persist versions via a repository port (left to adapters).
 *  - Notify external observers (dashboards, audit trails, billing, etc.).
 *
 * Architectural Patterns Demonstrated
 *  - Strategy Pattern           : Different version‐generation algorithms.
 *  - Factory Pattern            : Resolve the concrete strategy at runtime.
 *  - Observer Pattern           : Broadcast versioning domain events.
 *
 * NOTE: External IO (DBs, message buses, etc.) is abstracted behind ports so the core
 *       remains pure and independently testable.
 * ===================================================================================*/

import { EventEmitter } from 'events';

/* ------------------------------------------------------------------------
 * Domain Types
 * --------------------------------------------------------------------- */

/** Immutable representation of a model version. */
export interface ModelVersion {
  /** Canonical string representation (e.g., "v1.2.3" or "2024.05.05-01"). */
  readonly tag: string;
  /** Arbitrary metadata—for example, git SHA, dataset hash, or training params. */
  readonly metadata: Record<string, unknown>;
  /** RFC3339 timestamp of when the version was created. */
  readonly createdAt: string;
}

/** Context supplied to a strategy when generating the next model version. */
export interface VersionContext {
  readonly previousVersion: ModelVersion | null;
  readonly metrics: Record<string, number>;
  readonly timestamp: Date;
}

/* ------------------------------------------------------------------------
 * Ports (Hexagonal Interfaces)
 * --------------------------------------------------------------------- */

/** Persistence port—implemented by adapters (PostgreSQL, Mongo, Snowflake, etc.). */
export interface ModelVersionRepositoryPort {
  getLatestVersion(modelId: string): Promise<ModelVersion | null>;
  saveVersion(modelId: string, version: ModelVersion): Promise<void>;
}

/** Configuration port—implemented by an adapter (env vars, config service, etc.). */
export interface VersioningConfigProviderPort {
  /** Returns the configured strategy for a model, defaults to "semantic". */
  getStrategyKey(modelId: string): Promise<string>;
  /** Custom parameters passed into a strategy, if any. */
  getStrategyParams(modelId: string): Promise<Record<string, unknown>>;
}

/* ------------------------------------------------------------------------
 * Strategy Pattern – Version Generators
 * --------------------------------------------------------------------- */

/** Strategy contract for generating the next model version tag. */
export interface VersionStrategyPort {
  generateNextVersion(
    modelId: string,
    ctx: VersionContext
  ): Promise<ModelVersion>;
}

/* --------------------------------------------------
 * Semantic Versioning Strategy (v<major>.<minor>.<patch>)
 * -------------------------------------------------- */
export class SemanticVersionStrategy implements VersionStrategyPort {
  async generateNextVersion(
    _modelId: string,
    ctx: VersionContext
  ): Promise<ModelVersion> {
    let major = 1,
      minor = 0,
      patch = 0;

    if (ctx.previousVersion) {
      const matches = ctx.previousVersion.tag.match(
        /^v(\d+)\.(\d+)\.(\d+)$/
      );
      if (!matches) {
        throw new VersioningError(
          `Previous version "${ctx.previousVersion.tag}" is not semantic`
        );
      }
      major = parseInt(matches[1], 10);
      minor = parseInt(matches[2], 10);
      patch = parseInt(matches[3], 10);
    }

    /* Simple rule-of-thumb: if primary KPI improved ≥ 5%, bump minor; else patch. */
    const kpiImprovement =
      (ctx.metrics['primary_kpi_delta'] as number | undefined) ?? 0;

    if (kpiImprovement >= 0.05) {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }

    const tag = `v${major}.${minor}.${patch}`;
    return {
      tag,
      metadata: { kpiImprovement },
      createdAt: ctx.timestamp.toISOString(),
    };
  }
}

/* --------------------------------------------------
 * Calendar Versioning Strategy (YYYY.MM.DD[-index])
 * -------------------------------------------------- */
export class CalendarVersionStrategy implements VersionStrategyPort {
  async generateNextVersion(
    _modelId: string,
    ctx: VersionContext
  ): Promise<ModelVersion> {
    const datePart = this.formatDate(ctx.timestamp);
    let index = 0;

    if (ctx.previousVersion) {
      const re = /^(\d{4}\.\d{2}\.\d{2})-(\d+)$/;
      const matches = ctx.previousVersion.tag.match(re);
      if (matches && matches[1] === datePart) {
        index = parseInt(matches[2], 10) + 1;
      }
    }

    const tag = `${datePart}-${this.pad(index)}`;

    return {
      tag,
      metadata: {},
      createdAt: ctx.timestamp.toISOString(),
    };
  }

  private formatDate(d: Date): string {
    const yyyy = d.getUTCFullYear();
    const mm = this.pad(d.getUTCMonth() + 1);
    const dd = this.pad(d.getUTCDate());
    return `${yyyy}.${mm}.${dd}`;
  }
  private pad(n: number): string {
    return n.toString().padStart(2, '0');
  }
}

/* ------------------------------------------------------------------------
 * Factory Pattern – Strategy Resolution
 * --------------------------------------------------------------------- */

/** Allowed strategy identifiers. */
export const STRATEGY_KEYS = {
  SEMANTIC: 'semantic',
  CALENDAR: 'calendar',
} as const;

export type StrategyKey = (typeof STRATEGY_KEYS)[keyof typeof STRATEGY_KEYS];

export class VersionStrategyFactory {
  constructor(private readonly config: VersioningConfigProviderPort) {}

  /** Lazily resolve a strategy for the given model. */
  async forModel(modelId: string): Promise<VersionStrategyPort> {
    const key = ((await this.config.getStrategyKey(modelId)) ??
      STRATEGY_KEYS.SEMANTIC) as StrategyKey;

    switch (key) {
      case STRATEGY_KEYS.CALENDAR:
        return new CalendarVersionStrategy();
      case STRATEGY_KEYS.SEMANTIC:
      default:
        return new SemanticVersionStrategy();
    }
  }
}

/* ------------------------------------------------------------------------
 * Observer Pattern – Domain Events
 * --------------------------------------------------------------------- */

/** Domain event payloads indexed by event name. */
export interface VersioningDomainEvents {
  'model.version.created': {
    modelId: string;
    version: ModelVersion;
  };
}

/** Type-safe wrapper around Node’s EventEmitter. */
export class VersionObserverRegistry {
  private readonly bus = new EventEmitter({ captureRejections: true });

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof VersioningDomainEvents>(
    event: K,
    listener: (payload: VersioningDomainEvents[K]) => void
  ): () => void {
    this.bus.on(event, listener);
    return () => this.bus.off(event, listener);
  }

  /** Emit an event to all observers. */
  notify<K extends keyof VersioningDomainEvents>(
    event: K,
    payload: VersioningDomainEvents[K]
  ): void {
    this.bus.emit(event, payload);
  }
}

/* ------------------------------------------------------------------------
 * Service Layer – Application Logic (Still inside the hexagon)
 * --------------------------------------------------------------------- */

export class ModelVersioningService {
  constructor(
    private readonly repository: ModelVersionRepositoryPort,
    private readonly strategyFactory: VersionStrategyFactory,
    private readonly observers: VersionObserverRegistry
  ) {}

  /**
   * Registers a new model version.
   *
   * 1. Retrieve previous version.
   * 2. Generate next version via strategy.
   * 3. Persist to repository.
   * 4. Emit domain event.
   */
  async registerNewVersion(
    modelId: string,
    metrics: Record<string, number>,
    timestamp: Date = new Date()
  ): Promise<ModelVersion> {
    const ctx: VersionContext = {
      previousVersion: await this.repository.getLatestVersion(modelId),
      metrics,
      timestamp,
    };

    const strategy = await this.strategyFactory.forModel(modelId);
    const nextVersion = await strategy.generateNextVersion(modelId, ctx);

    await this.repository.saveVersion(modelId, nextVersion);
    this.observers.notify('model.version.created', { modelId, version: nextVersion });

    return nextVersion;
  }
}

/* ------------------------------------------------------------------------
 * Domain Errors
 * --------------------------------------------------------------------- */

export class VersioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VersioningError';
  }
}
```