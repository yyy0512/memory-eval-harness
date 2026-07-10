```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * File: src/module_51.ts
 * Responsibility: Core domain service for Model Versioning (inside the hexagon)
 *
 * This service encapsulates all business rules surrounding semantic
 * versioning, environment promotion, and aliasing (A/B-test variants,
 * canary, production, etc.).  It depends ONLY on abstract ports
 * (repositories, event publishers) and therefore stays technology-agnostic.
 */

import { v4 as uuidv4 } from 'uuid';      // RFC-4122 compliant UUID generator
import semver from 'semver';              // Strict semantic-version parser/validator

/**********************************************************************************************************************
 * DOMAIN TYPES & PORTS
 **********************************************************************************************************************/

/** Environments supported by InsightHexaAI */
export enum Environment {
  DEV        = 'dev',
  STAGING    = 'staging',
  PRODUCTION = 'production',
}

/** Release types accepted when bumping semantic versions */
export enum ReleaseType {
  MAJOR = 'major',
  MINOR = 'minor',
  PATCH = 'patch',
}

/** Core domain entity representing an immutable model version */
export interface ModelVersion {
  id: string;                     // UUID
  modelName: string;              // e.g. "customer-churn-xgboost"
  version: string;                // semantic version string (MAJOR.MINOR.PATCH)
  metadata: Record<string, any>;  // arbitrary user-defined, JSON-serialisable
  createdAt: Date;                // ISO timestamp
  environment: Environment;       // dev / staging / production
  aliases: string[];              // e.g. ["production", "ab-test-A"]
}

/** Hexagonal port allowing persistence operations without knowing the adapter */
export interface ModelVersionRepository {
  getLatestVersion(modelName: string, env: Environment): Promise<ModelVersion | null>;
  save(version: ModelVersion): Promise<void>;
  findByAlias(modelName: string, alias: string, env: Environment): Promise<ModelVersion | null>;
  list(modelName: string, env?: Environment): Promise<ModelVersion[]>;
}

/** Event interface for Observer Pattern */
export interface DomainEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

/** Hexagonal port for publishing domain events */
export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

/**********************************************************************************************************************
 * DOMAIN ERRORS
 **********************************************************************************************************************/

export class ModelVersioningError extends Error {
  constructor(message: string) {
    super(`[ModelVersioning] ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidSemVerError extends ModelVersioningError {}
export class NotFoundError extends ModelVersioningError {}
export class AliasConflictError extends ModelVersioningError {}

/**********************************************************************************************************************
 * HELPER UTILITIES
 **********************************************************************************************************************/

/**
 * Compute the next semantic version based on release type.
 */
function computeNextVersion(
  currentVersion: string | null,
  bump: ReleaseType,
): string {
  if (!currentVersion) {
    // First-time registration starts at 1.0.0
    return '1.0.0';
  }

  const next = semver.inc(currentVersion, bump);
  if (!next) {
    throw new InvalidSemVerError(
      `Cannot increment version "${currentVersion}" with bump "${bump}"`,
    );
  }
  return next;
}

/**********************************************************************************************************************
 * DOMAIN SERVICE
 **********************************************************************************************************************/

/**
 * ModelVersioningService – orchestrates all version lifecycle activities.
 */
export class ModelVersioningService {
  constructor(
    private readonly repository: ModelVersionRepository,
    private readonly publisher: EventPublisher,
  ) {}

  /**
   * Register a brand-new model version.
   */
  async registerInitialVersion(
    modelName: string,
    metadata: Record<string, any> = {},
    env: Environment = Environment.DEV,
  ): Promise<ModelVersion> {
    const version = computeNextVersion(null, ReleaseType.MAJOR);

    const entity: ModelVersion = {
      id: uuidv4(),
      modelName,
      version,
      metadata,
      createdAt: new Date(),
      environment: env,
      aliases: [], // no alias by default
    };

    await this.repository.save(entity);
    await this.publisher.publish(this.buildEvent('ModelVersionRegistered', entity));

    return entity;
  }

  /**
   * Bump version (major, minor, patch) within the same environment.
   */
  async bumpVersion(
    modelName: string,
    bumpType: ReleaseType,
    metadataUpdate: Record<string, any> = {},
    env: Environment = Environment.DEV,
  ): Promise<ModelVersion> {
    const latest = await this.repository.getLatestVersion(modelName, env);
    const nextVersion = computeNextVersion(latest?.version ?? null, bumpType);

    const entity: ModelVersion = {
      id: uuidv4(),
      modelName,
      version: nextVersion,
      metadata: { ...latest?.metadata, ...metadataUpdate },
      createdAt: new Date(),
      environment: env,
      aliases: [],
    };

    await this.repository.save(entity);
    await this.publisher.publish(this.buildEvent('ModelVersionBumped', {
      previous: latest,
      current : entity,
      bump    : bumpType,
    }));

    return entity;
  }

  /**
   * Promote the latest version from a source environment (e.g. staging) to a
   * target environment (e.g. production).  The semantic version itself is NOT
   * modified; instead we create a copy in the new environment.
   */
  async promoteLatest(
    modelName: string,
    from: Environment,
    to: Environment,
  ): Promise<ModelVersion> {
    if (from === to) {
      throw new ModelVersioningError('Source and target environments must differ.');
    }

    const latest = await this.repository.getLatestVersion(modelName, from);
    if (!latest) {
      throw new NotFoundError(
        `No version found for model "${modelName}" in env "${from}"`,
      );
    }

    // Clone the version for the new environment
    const promoted: ModelVersion = {
      ...latest,
      id         : uuidv4(),
      createdAt  : new Date(),
      environment: to,
      aliases    : [], // Reset aliases for new env
    };

    await this.repository.save(promoted);
    await this.publisher.publish(this.buildEvent('ModelVersionPromoted', {
      source: latest,
      target: promoted,
    }));

    return promoted;
  }

  /**
   * Attach a human-readable alias to a given version.  Each alias must be
   * unique per (model, environment).
   */
  async attachAlias(
    modelName: string,
    version: string,
    alias: string,
    env: Environment,
  ): Promise<ModelVersion> {
    const existing = await this.repository.findByAlias(modelName, alias, env);
    if (existing) {
      throw new AliasConflictError(
        `Alias "${alias}" already assigned to version "${existing.version}"`,
      );
    }

    const versions = await this.repository.list(modelName, env);
    const target   = versions.find(v => v.version === version);
    if (!target) {
      throw new NotFoundError(
        `Version "${version}" not found for model "${modelName}" in env "${env}"`,
      );
    }

    target.aliases.push(alias);
    await this.repository.save(target);

    await this.publisher.publish(this.buildEvent('ModelVersionAliased', {
      version: target,
      alias,
    }));

    return target;
  }

  /********************************************************************************************************************
   * PRIVATE UTILITIES
   *******************************************************************************************************************/

  private buildEvent(type: string, payload: unknown): DomainEvent {
    return {
      type,
      payload,
      occurredAt: new Date(),
    };
  }
}
```