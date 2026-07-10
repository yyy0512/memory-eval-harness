```typescript
/**************************************************************************************************
 * InsightHexaAI : Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 *  File:          src/module_9.ts
 *  Responsibility: Model-Versioning Domain Service (Hexagon Core)
 *
 *  Context:
 *    • Handles semantic version generation for newly-trained models
 *    • Emits lifecycle events to observers (dashboards/alerts/audit trail)
 *    • Strictly depends on abstract ports; concrete adapters live elsewhere
 *
 *  Architectural patterns demonstrated:
 *    • Strategy Pattern          – Pluggable version-bump logic
 *    • Factory Pattern           – Selects a bump strategy based on config at runtime
 *    • Observer Pattern          – Notifies interested parties of new/failed versions
 *    • Hexagonal Architecture    – Core business logic isolated from IO concerns
 **************************************************************************************************/

import { EventEmitter } from 'events';
import { v4 as uuidV4 } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                               Domain Primitives                            */
/* -------------------------------------------------------------------------- */

/**
 * A minimal yet extensible representation of evaluation metrics.
 * Real systems would commonly store many more KPIs (ROC-AUC, latency, etc.).
 */
export interface ModelMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  [additionalMetric: string]: number;
}

/**
 * Semantic wrapper for a specific model version.
 */
export interface ModelVersion {
  id: string;                 // Unique identifier (UUID v4)
  modelId: string;            // Business-level model identifier
  version: string;            // SemVer string (e.g., "2.1.0")
  createdAt: Date;            // Canonical creation timestamp (UTC)
  metrics: ModelMetrics;      // Metrics achieved by this version
  artifactsPath: string;      // URI to artifact storage (S3, GCS, etc.)
}

/* -------------------------------------------------------------------------- */
/*                                   Ports (Interfaces)                       */
/* -------------------------------------------------------------------------- */

/**
 * Persistence port – The core has no knowledge of infrastructure.
 * Adapters implement this for Postgres, DynamoDB, S3, etc.
 */
export interface ModelVersionRepository {
  getLatestVersion(modelId: string): Promise<ModelVersion | null>;
  saveVersion(modelVersion: ModelVersion): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*                     Strategy Pattern: Version Bumping                      */
/* -------------------------------------------------------------------------- */

/**
 * Strategy contract for deciding the next version string.
 */
export interface VersionBumpStrategy {
  /**
   * Computes the next version for a candidate model.
   *
   * @param previousVersion - SemVer of last production model (null if first)
   * @param candidateMetrics - Metrics of the newly-trained model
   * @param baselineMetrics - Metrics of last production model
   */
  computeNextVersion(
    previousVersion: string | null,
    candidateMetrics: ModelMetrics,
    baselineMetrics?: ModelMetrics | null
  ): string;
}

/**
 * Compares major KPIs and bumps accordingly:
 *  • +0.1.0 for meaningful improvement
 *  • +0.0.1 for negligible change
 *  • +1.0.0 if breaking changes are flagged (via metric keys mismatch)
 */
export class SemanticVersionBumpStrategy implements VersionBumpStrategy {
  private static readonly IMPROVEMENT_THRESHOLD = 0.02; // +2 % relative improvement considered meaningful

  public computeNextVersion(
    previousVersion: string | null,
    candidateMetrics: ModelMetrics,
    baselineMetrics?: ModelMetrics | null
  ): string {
    if (!previousVersion) {
      return '1.0.0'; // first release
    }

    const [major, minor, patch] = previousVersion.split('.').map(Number);

    if (!baselineMetrics) {
      // No baseline metrics? Default to minor bump.
      return `${major}.${minor + 1}.0`;
    }

    const hasBreakingChange =
      Object.keys(candidateMetrics).sort().join('|') !==
      Object.keys(baselineMetrics).sort().join('|');

    if (hasBreakingChange) {
      // Feature set changed; likely incompatible downstream
      return `${major + 1}.0.0`;
    }

    const improvement =
      (candidateMetrics.f1 - baselineMetrics.f1) / (baselineMetrics.f1 || 1);

    if (improvement > SemanticVersionBumpStrategy.IMPROVEMENT_THRESHOLD) {
      return `${major}.${minor + 1}.0`;
    }

    return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Simplest strategy: monotonically increment patch number.
 */
export class SimpleIncrementStrategy implements VersionBumpStrategy {
  public computeNextVersion(
    previousVersion: string | null
  ): string {
    if (!previousVersion) return '1.0.0';

    const [major, minor, patch] = previousVersion.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                     Factory Pattern: Strategy Selection                    */
/* -------------------------------------------------------------------------- */

export interface VersioningConfig {
  strategyType: 'semantic' | 'simple';
}

export class VersionBumpStrategyFactory {
  private static readonly DEFAULT_STRATEGY = 'semantic';

  public static create(config: VersioningConfig): VersionBumpStrategy {
    switch (config.strategyType ?? VersionBumpStrategyFactory.DEFAULT_STRATEGY) {
      case 'simple':
        return new SimpleIncrementStrategy();
      case 'semantic':
      default:
        return new SemanticVersionBumpStrategy();
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                       Observer Pattern: Event Emitter                      */
/* -------------------------------------------------------------------------- */

export type VersioningEvent = 'version:created' | 'version:failed';

export interface VersionCreatedPayload {
  modelId: string;
  version: string;
  metrics: ModelMetrics;
  artifactsPath: string;
}

export interface VersionFailedPayload {
  modelId: string;
  reason: string | Error;
}

/**
 * Typed EventEmitter ensuring compile-time safety for listeners.
 */
export class VersioningEventEmitter extends EventEmitter {
  public emit(event: 'version:created', payload: VersionCreatedPayload): boolean;
  public emit(event: 'version:failed', payload: VersionFailedPayload): boolean;
  public emit(event: VersioningEvent, payload: unknown): boolean {
    return super.emit(event, payload);
  }

  public on(
    event: 'version:created',
    listener: (payload: VersionCreatedPayload) => void
  ): this;
  public on(
    event: 'version:failed',
    listener: (payload: VersionFailedPayload) => void
  ): this;
  public on(event: VersioningEvent, listener: (payload: unknown) => void): this {
    return super.on(event, listener);
  }
}

/* -------------------------------------------------------------------------- */
/*                      Domain Service: Model-Versioning                      */
/* -------------------------------------------------------------------------- */

export class ModelVersioningService {
  constructor(
    private readonly repo: ModelVersionRepository,
    private readonly strategy: VersionBumpStrategy,
    private readonly emitter: VersioningEventEmitter = new VersioningEventEmitter()
  ) {}

  /**
   * Registers a newly-trained model, deciding its SemVer and persisting it.
   *
   * @throws Error when version computation or persistence fails.
   */
  public async registerModelVersion(
    modelId: string,
    candidateMetrics: ModelMetrics,
    artifactsPath: string
  ): Promise<ModelVersion> {
    try {
      // 1. Load baseline
      const baseline = await this.repo.getLatestVersion(modelId);

      // 2. Compute next version
      const nextVersion = this.strategy.computeNextVersion(
        baseline?.version ?? null,
        candidateMetrics,
        baseline?.metrics ?? null
      );

      // 3. Assemble domain entity
      const newVersion: ModelVersion = {
        id: uuidV4(),
        modelId,
        version: nextVersion,
        createdAt: new Date(),
        metrics: candidateMetrics,
        artifactsPath
      };

      // 4. Persist
      await this.repo.saveVersion(newVersion);

      // 5. Notify subscribers
      this.emitter.emit('version:created', {
        modelId,
        version: nextVersion,
        metrics: candidateMetrics,
        artifactsPath
      });

      return newVersion;
    } catch (err) {
      const reason = err instanceof Error ? err : new Error(String(err));

      // Emit failure event for observability/AIOps
      this.emitter.emit('version:failed', {
        modelId,
        reason
      });

      // Re-throw to upstream
      throw reason;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                         Example Usage (Would Live Elsewhere)                */
/* -------------------------------------------------------------------------- */

/*
import { PostgresModelVersionRepository } from './adapters/postgres/PostgresModelVersionRepository';

const repo = new PostgresModelVersionRepository();
const strategy = VersionBumpStrategyFactory.create({ strategyType: 'semantic' });
const emitter = new VersioningEventEmitter();

emitter.on('version:created', payload => {
  console.log('[Analytics] New model version registered:', payload);
});

const versioningSvc = new ModelVersioningService(repo, strategy, emitter);

await versioningSvc.registerModelVersion(
  'customer-churn-predictor',
  { accuracy: 0.94, precision: 0.91, recall: 0.9, f1: 0.905 },
  's3://ml-artifacts/churn/2023-09-14T01:22:12Z'
);
*/

```