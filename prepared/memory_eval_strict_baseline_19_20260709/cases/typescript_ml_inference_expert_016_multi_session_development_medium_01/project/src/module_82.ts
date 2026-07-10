```typescript
/* -----------------------------------------------------------------------------
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * File:        src/module_82.ts
 * Author:      InsightHexaAI Core Team
 *
 * Description:
 *   Model monitoring hex-module responsible for detecting KPI drift in real time
 *   and notifying interested adapters (dashboards, alerting systems, etc.)
 *   through an Observer-pattern publisher.  The service is entirely side-effect
 *   free; integrations live in outer layers that subscribe to the events.
 * ---------------------------------------------------------------------------*/

import { EventEmitter } from 'events';
import { mean, standardDeviation, tTestTwoSample } from 'simple-statistics';

/* -------------------------------------------------------------------------- */
/*                           Domain-Level Type Declarations                   */
/* -------------------------------------------------------------------------- */

/**
 * Key-Performance-Indicator (KPI) names recognised by the platform.
 * For extensibility the literal union is open-ended via `string`.
 */
export type KPIName =
  | 'CTR'
  | 'ConversionRate'
  | 'CustomerLifetimeValue'
  | 'ChurnRate'
  | string;

/**
 * An individual measurement of a KPI at a given point in time.
 */
export interface KPIDataPoint {
  readonly kpi: KPIName;
  readonly timestamp: number; // epoch millis
  readonly value: number;
}

/**
 * Outcome of a drift-detection pass.
 */
export interface DriftReport {
  readonly kpi: KPIName;
  readonly pValue: number;
  readonly driftDetected: boolean;
  readonly baselineStats: { mean: number; stdev: number };
  readonly targetStats: { mean: number; stdev: number };
  readonly strategy: string;
  readonly generatedAt: number;
}

/* -------------------------------------------------------------------------- */
/*                       Strategy Pattern — Drift Detection                   */
/* -------------------------------------------------------------------------- */

/**
 * All drift-detection strategies must implement this interface so that the core
 * monitoring service can remain agnostic of the algorithmic details.
 */
export interface DriftDetectionStrategy {
  readonly name: string;
  detectDrift(
    baselineWindow: ReadonlyArray<number>,
    targetWindow: ReadonlyArray<number>
  ): DriftReport;
}

/**
 * Student’s T-test implementation.
 * Suitable for mean-shift detection assuming (approx.) normal distributions.
 */
class TTestDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'student-t-test';

  detectDrift(
    baselineWindow: ReadonlyArray<number>,
    targetWindow: ReadonlyArray<number>
  ): DriftReport {
    if (!baselineWindow.length || !targetWindow.length) {
      throw new Error(
        '[TTestDriftStrategy] Both baseline and target windows must be non-empty.'
      );
    }

    const pValue = tTestTwoSample(baselineWindow, targetWindow);
    const driftDetected = pValue < 0.05; // 95 % confidence

    return {
      kpi: 'N/A', // will be overwritten by the caller
      pValue,
      driftDetected,
      baselineStats: {
        mean: mean(baselineWindow),
        stdev: standardDeviation(baselineWindow),
      },
      targetStats: {
        mean: mean(targetWindow),
        stdev: standardDeviation(targetWindow),
      },
      strategy: this.name,
      generatedAt: Date.now(),
    };
  }
}

/**
 * Population-Stability-Index (PSI) strategy.
 * Frequently used for monitoring scorecard stability in production.
 * Note: PSI is discretised; here we provide a simplified bucketed version.
 */
class PSIDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'population-stability-index';

  private static readonly DEFAULT_BUCKETS = 10;
  private static readonly DRIFT_THRESHOLD = 0.2; // rule-of-thumb

  detectDrift(
    baselineWindow: ReadonlyArray<number>,
    targetWindow: ReadonlyArray<number>
  ): DriftReport {
    if (!baselineWindow.length || !targetWindow.length) {
      throw new Error(
        '[PSIDriftStrategy] Both baseline and target windows must be non-empty.'
      );
    }

    const buckets = PSIDriftStrategy.DEFAULT_BUCKETS;
    const boundaries = this.buildQuantileBoundaries(baselineWindow, buckets);

    let psi = 0;

    for (let i = 0; i < buckets; i++) {
      const lower = boundaries[i];
      const upper = boundaries[i + 1];

      const expectedCount = baselineWindow.filter(
        (v) => v >= lower && v < upper
      ).length;
      const actualCount = targetWindow.filter((v) => v >= lower && v < upper)
        .length;

      const expectedPct = expectedCount / baselineWindow.length || 1e-12;
      const actualPct = actualCount / targetWindow.length || 1e-12;

      psi += (actualPct - expectedPct) * Math.log(actualPct / expectedPct);
    }

    const driftDetected = psi > PSIDriftStrategy.DRIFT_THRESHOLD;

    return {
      kpi: 'N/A',
      pValue: psi, // PSI is not a p-value but used analogously here
      driftDetected,
      baselineStats: {
        mean: mean(baselineWindow),
        stdev: standardDeviation(baselineWindow),
      },
      targetStats: {
        mean: mean(targetWindow),
        stdev: standardDeviation(targetWindow),
      },
      strategy: this.name,
      generatedAt: Date.now(),
    };
  }

  /**
   * Build quantile boundaries (including min & max) for PSI bucketisation.
   */
  private buildQuantileBoundaries(
    values: ReadonlyArray<number>,
    bucketCount: number
  ): number[] {
    const sorted = [...values].sort((a, b) => a - b);
    const boundaries: number[] = [];

    for (let i = 0; i <= bucketCount; i++) {
      const idx = Math.floor((i * (sorted.length - 1)) / bucketCount);
      boundaries.push(sorted[idx]);
    }

    // Ensure last boundary captures max inclusive
    boundaries[boundaries.length - 1] =
      sorted[sorted.length - 1] + Number.EPSILON;

    return boundaries;
  }
}

/**
 * Simple factory for creating detectors from descriptive names. Can be extended
 * without modifying client code (Open-Closed Principle).
 */
export class DriftDetectorFactory {
  static create(name: 't-test' | 'psi' = 't-test'): DriftDetectionStrategy {
    switch (name) {
      case 'psi':
        return new PSIDriftStrategy();
      case 't-test':
      default:
        return new TTestDriftStrategy();
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                            Observer Pattern Core                           */
/* -------------------------------------------------------------------------- */

/**
 * Subscribers implement this interface to receive drift events.
 * Implementations are provided by outer adapters such as Slack notifications,
 * Prometheus exporters, etc.
 */
export interface DriftSubscriber {
  onDrift(report: DriftReport): void;
}

/**
 * Publisher uses Node’s EventEmitter under the hood but exposes
 * a type-safe API for subscribing to drift events.
 */
export class DriftEventPublisher {
  private readonly emitter = new EventEmitter();

  subscribe(subscriber: DriftSubscriber): void {
    this.emitter.on('drift', subscriber.onDrift.bind(subscriber));
  }

  unsubscribe(subscriber: DriftSubscriber): void {
    this.emitter.off('drift', subscriber.onDrift.bind(subscriber));
  }

  publish(report: DriftReport): void {
    this.emitter.emit('drift', report);
  }
}

/* -------------------------------------------------------------------------- */
/*                        Misc. Utilities — Circular Buffer                  */
/* -------------------------------------------------------------------------- */

class CircularBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private index = 0;
  private filled = false;

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('Capacity must be positive.');
    this.buffer = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.buffer[this.index] = item;
    this.index = (this.index + 1) % this.capacity;
    if (this.index === 0) this.filled = true;
  }

  toArray(): T[] {
    return (this.filled
      ? this.buffer
      : this.buffer.slice(0, this.index)
    ).filter((x): x is T => x !== undefined);
  }

  isFull(): boolean {
    return this.filled;
  }
}

/* -------------------------------------------------------------------------- */
/*                 Domain Service — Real-Time Model Monitor                   */
/* -------------------------------------------------------------------------- */

export interface ModelMonitorConfig {
  readonly detector: 't-test' | 'psi';
  /**
   * Window size (number of observations) for baseline and monitoring windows.
   * Both windows are fixed-length & rolling.
   */
  readonly windowSize: number;
  /** Minimum number of new samples before each drift evaluation run. */
  readonly evaluationFrequency: number;
  /** KPI to monitor (one monitor per KPI). */
  readonly kpi: KPIName;
}

/**
 * The service maintains two rolling windows:
 *   1. baselineWindow – golden reference distribution (e.g., last training set)
 *   2. targetWindow   – live production measurements
 *
 * Every `evaluationFrequency` pushes to the targetWindow, drift detection runs.
 */
export class ModelMonitorService {
  private readonly baselineWindow: CircularBuffer<number>;
  private readonly targetWindow: CircularBuffer<number>;
  private readonly detector: DriftDetectionStrategy;
  private readonly publisher: DriftEventPublisher;

  private sinceLastEval = 0;

  constructor(
    private readonly config: ModelMonitorConfig,
    publisher?: DriftEventPublisher,
    detectorFactory = DriftDetectorFactory
  ) {
    if (config.windowSize < 10)
      throw new Error(
        `Window size ${config.windowSize} too small for statistical power.`
      );

    this.baselineWindow = new CircularBuffer<number>(config.windowSize);
    this.targetWindow = new CircularBuffer<number>(config.windowSize);
    this.detector = detectorFactory.create(config.detector);
    this.publisher = publisher ?? new DriftEventPublisher();
  }

  /**
   * Seed the baseline window. Usually called with a batch from offline storage.
   */
  seedBaseline(values: ReadonlyArray<number>): void {
    values.forEach((v) => this.baselineWindow.push(v));
    if (!this.baselineWindow.isFull()) {
      console.warn(
        `[ModelMonitorService] Baseline window not full (${values.length}/${this.config.windowSize}). ` +
          'Statistical tests may be unstable.'
      );
    }
  }

  /**
   * Ingest a single production data point. Might be invoked thousands of times
   * per second in high-QPS environments.
   */
  ingest(point: KPIDataPoint): void {
    if (point.kpi !== this.config.kpi) return; // ignore other KPIs
    this.targetWindow.push(point.value);
    this.sinceLastEval++;

    if (
      this.targetWindow.isFull() &&
      this.sinceLastEval >= this.config.evaluationFrequency
    ) {
      this.evaluateDrift();
      this.sinceLastEval = 0;
    }
  }

  /**
   * Perform drift detection and publish a report to the event bus.
   */
  private evaluateDrift(): void {
    const baseline = this.baselineWindow.toArray();
    const target = this.targetWindow.toArray();

    if (!baseline.length || !target.length) {
      console.warn(
        '[ModelMonitorService] Skipping evaluation: insufficient data.'
      );
      return;
    }

    try {
      const report = this.detector.detectDrift(baseline, target);
      // override KPI name (strategy doesn’t know it)
      const enrichedReport: DriftReport = { ...report, kpi: this.config.kpi };

      this.publisher.publish(enrichedReport);
    } catch (err) {
      console.error(
        `[ModelMonitorService] Drift evaluation failed: ${(err as Error).message}`,
        err
      );
    }
  }

  /* Expose publisher for adapters to subscribe without violating encapsulation */
  get eventPublisher(): DriftEventPublisher {
    return this.publisher;
  }
}

/* -------------------------------------------------------------------------- */
/*                     Example — Console Logging Subscriber                   */
/* -------------------------------------------------------------------------- */

/**
 * A minimal subscriber used mostly for testing. Production adapters should live
 * in separate infra modules (e.g., Prometheus, Splunk, Slack).
 */
export class ConsoleDriftLogger implements DriftSubscriber {
  onDrift(report: DriftReport): void {
    const status = report.driftDetected ? '⚠️  DRIFT' : '✅  Stable';
    /* eslint-disable no-console */
    console.log(
      `[ConsoleDriftLogger] [${new Date(report.generatedAt).toISOString()}] ` +
        `${status} | KPI=${report.kpi} | p/psi=${report.pValue.toFixed(4)} ` +
        `| strategy=${report.strategy}`
    );
    /* eslint-enable no-console */
  }
}
```