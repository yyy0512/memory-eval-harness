```typescript
/**
 * InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * File:        src/module_78.ts
 * Author:      InsightHexaAI Core Team
 *
 * Purpose:
 *   Domain-level service that detects KPI drift and broadcasts drift
 *   events to interested observers (dashboards, alert managers, audit
 *   trails, etc.) while remaining agnostic of infrastructure concerns.
 *
 * Architectural Notes:
 *   • Hexagonal / ports-and-adapters: no direct IO, only abstractions.
 *   • Strategy Pattern: interchangeable drift-detection algorithms.
 *   • Observer Pattern: plug-and-play subscribers for drift events.
 *
 * Usage:
 *   const monitor = new KPIDriftMonitor(
 *       StrategyFactory.build({ type: 'percentage', threshold: 0.05 }),
 *       [new LoggingObserver()]
 *   );
 *
 *   await monitor.monitorKPI(baselineSnapshot, latestSnapshot);
 */

 /* eslint-disable @typescript-eslint/no-floating-promises */

 // ───────────────────────────────────────────────────────────────────────────────
 // Imports & Type Aliases
 // ───────────────────────────────────────────────────────────────────────────────
import { v4 as uuid } from 'uuid'; // runtime dependency for drift event ids

// ───────────────────────────────────────────────────────────────────────────────
// Domain Types
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of a KPI value at a fixed point in time.
 */
export interface KPI {
  readonly id: string;            // Unique KPI identifier (e.g., 'CLV', 'Churn')
  readonly value: number;         // Numeric representation
  readonly timestamp: Date;       // ISO date of measurement
}

/**
 * Result returned when drift is detected.
 */
export interface DriftResult {
  readonly eventId: string;       // Universally-unique drift event id
  readonly kpiId: string;         // KPI that drifted
  readonly baseline: number;      // Baseline (historical) value
  readonly current: number;       // Latest measured value
  readonly driftPercentage: number; // Δ% = (current-baseline)/baseline
  readonly severity: 'low' | 'medium' | 'high';
  readonly detectedAt: Date;      // Event timestamp
}

/**
 * Abstraction of an algorithm that can detect drift between
 * two KPI snapshots.
 */
export interface DriftDetectionStrategy {
  /**
   * @throws DriftDetectionError when baseline is invalid or algorithm fails
   */
  detectDrift(baseline: KPI, current: KPI): DriftResult | null;
}

/**
 * Observer that reacts to drift events.
 * Concrete adapters live outside the hexagon (e.g., Slack, PagerDuty).
 */
export interface DriftObserver {
  /**
   * @param result Drift result to publish
   * @throws ObserverError when downstream sink fails
   */
  onDrift(result: DriftResult): Promise<void>;
}

// ───────────────────────────────────────────────────────────────────────────────
// Custom Errors
// ───────────────────────────────────────────────────────────────────────────────

export class DriftDetectionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DriftDetectionError';
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class ObserverError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ObserverError';
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Drift-Detection Strategy Implementations
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Config shape for factory assembly.
 */
export type StrategyConfig =
  | {
      type: 'percentage';
      threshold: number; // e.g., 0.05 → 5 %
    }
  | {
      type: 'cusum';
      upperBound: number;
      lowerBound: number;
    };

/**
 * Detects drift if absolute % difference exceeds threshold.
 */
class PercentageDriftStrategy implements DriftDetectionStrategy {
  constructor(private readonly threshold: number) {
    if (threshold <= 0) {
      throw new DriftDetectionError(
        `Threshold must be positive. Received: ${threshold}`
      );
    }
  }

  detectDrift(baseline: KPI, current: KPI): DriftResult | null {
    if (baseline.value === 0) {
      throw new DriftDetectionError('Baseline value cannot be zero.');
    }

    const diff = current.value - baseline.value;
    const driftPercentage = diff / baseline.value;

    if (Math.abs(driftPercentage) >= this.threshold) {
      return {
        eventId: uuid(),
        kpiId: current.id,
        baseline: baseline.value,
        current: current.value,
        driftPercentage,
        severity: this.mapSeverity(Math.abs(driftPercentage)),
        detectedAt: new Date()
      };
    }
    return null;
  }

  private mapSeverity(absPct: number): DriftResult['severity'] {
    if (absPct >= this.threshold * 3) return 'high';
    if (absPct >= this.threshold * 2) return 'medium';
    return 'low';
  }
}

/**
 * Simplified one-pass CUSUM drift detector.
 * Note: Production version would maintain stateful cumulative sums.
 */
class CUSUMDriftStrategy implements DriftDetectionStrategy {
  constructor(
    private readonly upperBound: number,
    private readonly lowerBound: number
  ) {
    if (upperBound <= 0 || lowerBound >= 0) {
      throw new DriftDetectionError(
        `CUSUM bounds must be positive (upper) and negative (lower).`
      );
    }
  }

  detectDrift(baseline: KPI, current: KPI): DriftResult | null {
    const deviation = current.value - baseline.value;

    if (deviation >= this.upperBound || deviation <= this.lowerBound) {
      const driftPercentage = deviation / baseline.value;
      return {
        eventId: uuid(),
        kpiId: current.id,
        baseline: baseline.value,
        current: current.value,
        driftPercentage,
        severity: deviation >= this.upperBound ? 'high' : 'medium',
        detectedAt: new Date()
      };
    }
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Strategy Factory (Factory Pattern)
// ───────────────────────────────────────────────────────────────────────────────

export class StrategyFactory {
  static build(config: StrategyConfig): DriftDetectionStrategy {
    switch (config.type) {
      case 'percentage':
        return new PercentageDriftStrategy(config.threshold);
      case 'cusum':
        return new CUSUMDriftStrategy(config.upperBound, config.lowerBound);
      default:
        // Compile-time exhaustive check
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _exhaustive: never = config;
        throw new DriftDetectionError(`Unknown strategy: ${(config as any).type}`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Observer Implementations
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Basic observer that writes drift events to console.
 * In production, adapters could be Prometheus, Kafka, Slack, etc.
 */
export class LoggingObserver implements DriftObserver {
  async onDrift(result: DriftResult): Promise<void> {
    // Never throw; we don't want logging failures to break pipeline
    try {
      // eslint-disable-next-line no-console
      console.info(
        `[DRIFT] ${result.kpiId} changed by ${(result.driftPercentage * 100).toFixed(
          2
        )}%  (severity=${result.severity})`
      );
    } catch (error) {
      throw new ObserverError('Logging observer failed', error);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Core Service — KPIDriftMonitor  (Observer Pattern Subject)
// ───────────────────────────────────────────────────────────────────────────────

export class KPIDriftMonitor {
  private readonly observers: Set<DriftObserver>;
  private readonly strategy: DriftDetectionStrategy;

  constructor(
    strategy: DriftDetectionStrategy,
    initialObservers: DriftObserver[] = []
  ) {
    this.strategy = strategy;
    this.observers = new Set(initialObservers);
  }

  /**
   * Register an observer at runtime. Returns a disposer function.
   */
  addObserver(observer: DriftObserver): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /**
   * Compare two KPI snapshots and broadcast drift event if any.
   *
   * @returns DriftResult when drift detected, otherwise null.
   */
  async monitorKPI(baseline: KPI, current: KPI): Promise<DriftResult | null> {
    const maybeDrift = this.strategy.detectDrift(baseline, current);

    if (maybeDrift) {
      await this.notifyObservers(maybeDrift);
      return maybeDrift;
    }
    return null;
  }

  /** Internal helper that fans-out notifications with fault-tolerance. */
  private async notifyObservers(result: DriftResult): Promise<void> {
    const settlements = await Promise.allSettled(
      Array.from(this.observers).map((observer) => observer.onDrift(result))
    );

    // Aggregate failures and surface if any
    const rejected = settlements.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected'
    );

    if (rejected.length > 0) {
      const reasons = rejected.map((r) => r.reason).join('; ');
      throw new ObserverError(
        `One or more observers failed while handling drift event ${result.eventId}: ${reasons}`
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Example Types For Downstream Hexagon Layers (DTOs)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * External representation for REST or gRPC layers.
 * Demonstrates how hexagon may expose DTOs without leaking internals.
 */
export interface DriftEventDTO {
  id: string;
  kpi: string;
  baseline: number;
  current: number;
  delta_pct: number;
  severity: 'low' | 'medium' | 'high';
  ts: string;
}

/**
 * Mapper from domain DriftResult to transport DTO.
 */
export function mapToDTO(result: DriftResult): DriftEventDTO {
  return {
    id: result.eventId,
    kpi: result.kpiId,
    baseline: result.baseline,
    current: result.current,
    delta_pct: Number((result.driftPercentage * 100).toFixed(2)),
    severity: result.severity,
    ts: result.detectedAt.toISOString()
  };
}
```