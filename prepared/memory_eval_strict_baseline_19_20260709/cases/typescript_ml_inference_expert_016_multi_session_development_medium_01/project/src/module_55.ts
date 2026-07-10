```typescript
// File: src/module_55.ts
// Project: InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
//
// Purpose:
//   Core domain service for governing model versioning inside the hexagon.
//   The service exposes an API for creating semantic model versions based on
//   evaluation metrics and defined strategies while emitting domain events
//   whenever a new version is created.
//
// Architectural alignment:
//   • Strategy_Pattern: Choose between multiple version-bumping policies.
//   • Factory_Pattern : Centralised factory to obtain concrete strategies.
//   • Observer_Pattern: Emits “versionCreated” domain events to subscribed
//                        adapters (e.g., audit log, PowerBI dashboards, etc.).
//
// Note: This file purposefully contains no concrete IO code (DB writes, HTTP
//       calls, etc.); all side-effects belong in adapter layers outside the
//       hexagon.

import { EventEmitter } from 'events';
import { v4 as uuidV4 } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                               Domain Models                                */
/* -------------------------------------------------------------------------- */

/**
 * Immutable representation of a semantic version.
 */
export class SemVer {
  public readonly major: number;
  public readonly minor: number;
  public readonly patch: number;

  private static readonly REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

  constructor(major: number, minor: number, patch: number) {
    if (!SemVer.isValidSegment(major) || !SemVer.isValidSegment(minor) || !SemVer.isValidSegment(patch)) {
      throw new DomainValidationError(`Invalid semantic version segments: ${major}.${minor}.${patch}`);
    }

    this.major = major;
    this.minor = minor;
    this.patch = patch;

    Object.freeze(this);
  }

  /**
   * Parses a SemVer string into a SemVer instance.
   */
  public static parse(raw: string): SemVer {
    const match = SemVer.REGEX.exec(raw);

    if (!match) {
      throw new DomainValidationError(`String "${raw}" is not valid semantic versioning`);
    }

    return new SemVer(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
  }

  public toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }

  /**
   * Returns –1, 0, 1 for <, =, > respectively.
   */
  public compare(other: SemVer): number {
    if (this.major !== other.major) return this.major > other.major ? 1 : -1;
    if (this.minor !== other.minor) return this.minor > other.minor ? 1 : -1;
    if (this.patch !== other.patch) return this.patch > other.patch ? 1 : -1;
    return 0;
  }

  /**
   * Create a new SemVer with selected component incremented and
   * all lower-order components reset to zero.
   */
  public bump(level: VersionBumpLevel): SemVer {
    switch (level) {
      case 'major':
        return new SemVer(this.major + 1, 0, 0);
      case 'minor':
        return new SemVer(this.major, this.minor + 1, 0);
      case 'patch':
        return new SemVer(this.major, this.minor, this.patch + 1);
      default:
        // Exhaustiveness check
        /* istanbul ignore next */
        throw new DomainValidationError(`Unknown bump level: ${(level as never)}`);
    }
  }

  private static isValidSegment(num: number): boolean {
    return Number.isInteger(num) && num >= 0;
  }
}

/**
 * Performance metrics emitted from the evaluation pipeline.
 * Keeps only domain-relevant KPIs; raw full metrics stay in adapters.
 */
export interface EvaluationMetrics {
  accuracy: number;      // 0-1
  f1Score: number;       // 0-1
  latencyMs: number;     // lower is better
  memoryMb: number;      // lower is better
  timestamp: Date;
}

/* -------------------------------------------------------------------------- */
/*                            Strategy Interfaces                             */
/* -------------------------------------------------------------------------- */

export type VersionBumpLevel = 'major' | 'minor' | 'patch';

/**
 * Determines what kind of SemVer bump (major/minor/patch) should apply
 * when a new model candidate is being considered.
 */
export interface VersionBumpStrategy {
  /**
   * Decide bump level based on previous & current metrics.
   * @throws DomainValidationError if metrics are invalid.
   */
  decideBumpLevel(
    previousMetrics: EvaluationMetrics | undefined,
    currentMetrics: EvaluationMetrics,
  ): VersionBumpLevel;
}

/* -------------------------------------------------------------------------- */
/*                    Concrete Strategy Implementations                       */
/* -------------------------------------------------------------------------- */

/**
 * Strategy that bumps MAJOR if accuracy drops, MINOR if accuracy increases
 * beyond a configured threshold, otherwise PATCH.
 */
export class AccuracySensitiveStrategy implements VersionBumpStrategy {
  constructor(
    private readonly improvementThreshold: number = 0.01, // +1% accuracy → minor bump
  ) {}

  decideBumpLevel(
    previous: EvaluationMetrics | undefined,
    current: EvaluationMetrics,
  ): VersionBumpLevel {
    if (!previous) return 'major'; // First version ever
    if (current.accuracy < previous.accuracy) return 'major';

    const accuracyDelta = current.accuracy - previous.accuracy;
    if (accuracyDelta >= this.improvementThreshold) return 'minor';

    return 'patch';
  }
}

/**
 * Strategy that promotes performance (latency / memory) over accuracy.
 */
export class LatencyOptimisedStrategy implements VersionBumpStrategy {
  constructor(
    private readonly latencyImprovementPct = 10, // 10% latency improvement → minor
  ) {}

  decideBumpLevel(
    previous: EvaluationMetrics | undefined,
    current: EvaluationMetrics,
  ): VersionBumpLevel {
    if (!previous) return 'major';

    const percentageImprovement =
      ((previous.latencyMs - current.latencyMs) / previous.latencyMs) * 100;

    if (percentageImprovement >= this.latencyImprovementPct) {
      return 'minor';
    }

    return 'patch';
  }
}

/* -------------------------------------------------------------------------- */
/*                             Strategy Factory                               */
/* -------------------------------------------------------------------------- */

export enum StrategyKind {
  ACCURACY_SENSITIVE = 'ACCURACY_SENSITIVE',
  LATENCY_OPTIMISED  = 'LATENCY_OPTIMISED',
}

/**
 * Resolves concrete VersionBumpStrategy implementations.
 * Additional strategies can be added without touching consumer code.
 */
export class VersionBumpStrategyFactory {
  public static create(kind: StrategyKind, options?: Record<string, unknown>): VersionBumpStrategy {
    switch (kind) {
      case StrategyKind.ACCURACY_SENSITIVE:
        return new AccuracySensitiveStrategy(
          (options?.['improvementThreshold'] as number | undefined) ?? 0.01,
        );
      case StrategyKind.LATENCY_OPTIMISED:
        return new LatencyOptimisedStrategy(
          (options?.['latencyImprovementPct'] as number | undefined) ?? 10,
        );
      default:
        /* istanbul ignore next */
        throw new DomainValidationError(`Unhandled strategy kind: ${kind satisfies never}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Events                                    */
/* -------------------------------------------------------------------------- */

/**
 * Domain event emitted after a new version is created within the hexagon.
 * Adapters (e.g., audit logs, dashboards) subscribe to relay this event
 * outside.
 */
export interface ModelVersionCreatedEvent {
  readonly id: string;
  readonly modelId: string;
  readonly semVer: SemVer;
  readonly createdAt: Date;
  readonly metrics: EvaluationMetrics;
}

/* -------------------------------------------------------------------------- */
/*                               Domain Errors                                */
/* -------------------------------------------------------------------------- */

export class DomainValidationError extends Error {
  public readonly name = 'DomainValidationError';

  constructor(message: string) {
    super(message);
    Error.captureStackTrace(this, DomainValidationError);
  }
}

/* -------------------------------------------------------------------------- */
/*                           Model Versioning Service                         */
/* -------------------------------------------------------------------------- */

export interface ModelVersioningServiceConfig {
  readonly strategyKind: StrategyKind;
  readonly strategyOptions?: Record<string, unknown>;
}

/**
 * Pure domain service responsible for creating new model versions.
 * Emits “versionCreated” events via Observer pattern for other hexagon
 * modules to react (e.g., experiment tracking, audit logging).
 */
export class ModelVersioningService extends EventEmitter {
  private readonly bumpStrategy: VersionBumpStrategy;

  /**
   * @param initialVersion Starting SemVer for the model (defaults to 0.0.0)
   *                       Stored in memory for simplicity; adapters can
   *                       persist the latest version elsewhere.
   */
  constructor(
    private currentVersion: SemVer = new SemVer(0, 0, 0),
    config: ModelVersioningServiceConfig = {
      strategyKind: StrategyKind.ACCURACY_SENSITIVE,
    },
  ) {
    super();
    this.bumpStrategy = VersionBumpStrategyFactory.create(
      config.strategyKind,
      config.strategyOptions,
    );
  }

  /**
   * Attempts to create a new SemVer based on evaluation metrics.
   * @returns Newly created SemVer
   */
  public createNextVersion(
    modelId: string,
    currentMetrics: EvaluationMetrics,
    previousMetrics?: EvaluationMetrics,
  ): SemVer {
    try {
      // Decide how to bump the version.
      const bumpLevel = this.bumpStrategy.decideBumpLevel(previousMetrics, currentMetrics);

      // Compute next version in immutable fashion.
      const nextVersion = this.currentVersion.bump(bumpLevel);

      // Update internal state.
      this.currentVersion = nextVersion;

      // Emit domain event.
      const event: ModelVersionCreatedEvent = {
        id: uuidV4(),
        modelId,
        semVer: nextVersion,
        createdAt: new Date(),
        metrics: currentMetrics,
      };
      this.emit('versionCreated', event);

      return nextVersion;
    } catch (err) {
      if (err instanceof DomainValidationError) throw err;
      // Wrap unknown errors in domain-typed error to avoid leaking internals.
      throw new DomainValidationError(`Unable to create next model version: ${(err as Error).message}`);
    }
  }

  /**
   * Provides read-only access to the service’s current version state.
   */
  public getCurrentVersion(): SemVer {
    return this.currentVersion;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Type Re-exports                               */
/* -------------------------------------------------------------------------- */

export type {
  ModelVersionCreatedEvent as VersionCreatedEvent,
  EvaluationMetrics as Metrics,
};
```