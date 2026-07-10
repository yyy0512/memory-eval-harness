```typescript
/**************************************************************************************************
 * File:        src/module_57.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * Purpose:     KPI-Drift Monitoring Domain Service
 *              --------------------------------------------------
 *              • Detects KPI distribution drift using interchangeable strategies (Strategy Pattern)
 *              • Publishes domain events when drift is detected (Observer Pattern/Event Bus)
 *              • Remains 100 % agnostic of infrastructure concerns (hexagonal architecture)
 *
 * Author:      InsightHexaAI Core Team
 *************************************************************************************************/

import { mean, sumBy, chunk, range } from 'lodash'; // lightweight numeric helpers

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Domain Layer – Value Objects & Types                                                          */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Represents a single KPI observation at a given timestamp.
 */
export interface KpiDataPoint {
  readonly timestamp: Date;
  readonly value: number;
}

/**
 * Collection type for KPI time series.
 */
export type KpiTimeSeries = ReadonlyArray<KpiDataPoint>;

/**
 * Immutable result of a drift-detection operation.
 */
export interface DriftResult {
  readonly driftScore: number;       // e.g. PSI value or KS statistic
  readonly driftDetected: boolean;   // true if above strategy-specific threshold
  readonly algorithm: string;        // human-readable name of algorithm
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Strategy Pattern – Drift Detection Algorithms                                                 */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Strategy contract for detecting drift between two KPI samples.
 */
export interface DriftDetectionStrategy {
  /**
   * Detects drift between the "expected"/reference distribution and the "actual"/live distribution.
   *
   * @param baseline   Historical reference observations
   * @param current    Live or recent observations
   */
  detectDrift(baseline: KpiTimeSeries, current: KpiTimeSeries): DriftResult;
}

/**
 * Concrete Strategy: Population Stability Index (PSI)
 * Widely used for monitoring scorecards and probabilistic models in finance.
 */
export class PopulationStabilityIndexStrategy implements DriftDetectionStrategy {
  private static readonly DEFAULT_BUCKETS = 10;
  private static readonly DEFAULT_THRESHOLD = 0.2; // PSI > 0.2 indicates significant drift

  public constructor(
    private readonly bucketCount: number = PopulationStabilityIndexStrategy.DEFAULT_BUCKETS,
    private readonly threshold: number = PopulationStabilityIndexStrategy.DEFAULT_THRESHOLD
  ) {}

  public detectDrift(baseline: KpiTimeSeries, current: KpiTimeSeries): DriftResult {
    if (!baseline.length || !current.length) {
      throw new Error('PSI Strategy: baseline and current series must be non-empty.');
    }

    // determine min / max boundaries across both samples
    const allValues = [...baseline, ...current].map(d => d.value);
    const min = Math.min(...allValues);
    const max = Math.max(...allValues);

    const bucketSize = (max - min) / this.bucketCount;

    const toBucket = (val: number) =>
      bucketSize === 0 ? 0 : Math.min(this.bucketCount - 1, Math.floor((val - min) / bucketSize));

    const baselineBuckets = Array(this.bucketCount).fill(0);
    const currentBuckets = Array(this.bucketCount).fill(0);

    baseline.forEach(point => baselineBuckets[toBucket(point.value)]++);
    current.forEach(point => currentBuckets[toBucket(point.value)]++);

    const baselineTotal = baseline.length;
    const currentTotal = current.length;

    let psi = 0;
    for (let i = 0; i < this.bucketCount; i++) {
      const expectedFrac = baselineBuckets[i] / baselineTotal || 1e-10; // avoid log(0)
      const actualFrac = currentBuckets[i] / currentTotal || 1e-10;
      psi += (actualFrac - expectedFrac) * Math.log(actualFrac / expectedFrac);
    }

    return {
      driftScore: psi,
      driftDetected: psi > this.threshold,
      algorithm: 'Population Stability Index'
    };
  }
}

/**
 * Concrete Strategy: Kolmogorov–Smirnov (KS) statistic
 * Non-parametric test for equality of continuous distributions.
 */
export class KolmogorovSmirnovStrategy implements DriftDetectionStrategy {
  private static readonly DEFAULT_THRESHOLD = 0.1; // KS statistic > 0.1 ≈ drift (rule-of-thumb, user-tunable)

  public constructor(private readonly threshold: number = KolmogorovSmirnovStrategy.DEFAULT_THRESHOLD) {}

  public detectDrift(baseline: KpiTimeSeries, current: KpiTimeSeries): DriftResult {
    if (!baseline.length || !current.length) {
      throw new Error('KS Strategy: baseline and current series must be non-empty.');
    }

    const baselineSorted = [...baseline].map(d => d.value).sort((a, b) => a - b);
    const currentSorted = [...current].map(d => d.value).sort((a, b) => a - b);

    const n = baselineSorted.length;
    const m = currentSorted.length;

    let i = 0;
    let j = 0;
    let cdf1 = 0;
    let cdf2 = 0;
    let d = 0;

    while (i < n && j < m) {
      const val1 = baselineSorted[i];
      const val2 = currentSorted[j];

      if (val1 <= val2) {
        i++;
        cdf1 = i / n;
      } else {
        j++;
        cdf2 = j / m;
      }
      d = Math.max(d, Math.abs(cdf1 - cdf2));
    }

    return {
      driftScore: d,
      driftDetected: d > this.threshold,
      algorithm: 'Kolmogorov–Smirnov'
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Factory Pattern – Create Strategies Dynamically                                               */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Supported drift detection algorithms.
 */
export enum DriftDetectionAlgorithm {
  PSI = 'psi',
  KS = 'ks'
}

/**
 * Factory for producing drift detection strategies.
 */
export class DriftDetectionStrategyFactory {
  public static create(
    algorithm: DriftDetectionAlgorithm,
    options?: Partial<{ bucketCount: number; threshold: number }>
  ): DriftDetectionStrategy {
    switch (algorithm) {
      case DriftDetectionAlgorithm.PSI:
        return new PopulationStabilityIndexStrategy(
          options?.bucketCount,
          options?.threshold
        );
      case DriftDetectionAlgorithm.KS:
        return new KolmogorovSmirnovStrategy(
          options?.threshold
        );
      default:
        throw new Error(`Unknown drift-detection algorithm: ${algorithm}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Observer Pattern – Domain Event Bus                                                           */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Base interface for all domain events.
 */
export interface DomainEvent {
  readonly occurredAt: Date;
  readonly type: string;
}

/**
 * KPI-specific event raised when drift is discovered.
 */
export class KpiDriftDetectedEvent implements DomainEvent {
  public readonly occurredAt = new Date();
  public readonly type = 'KPI_DRIFT_DETECTED';

  public constructor(
    public readonly kpiName: string,
    public readonly result: DriftResult
  ) {}
}

/**
 * Domain Event Handler signature.
 */
export type DomainEventHandler<E extends DomainEvent = DomainEvent> = (event: E) => Promise<void>;

/**
 * Lightweight, in-memory event bus – can be replaced by more powerful adapters (Kafka, RabbitMQ).
 */
export class EventBus {
  private readonly handlers: Map<string, Set<DomainEventHandler>> = new Map();

  /**
   * Register an event handler for a given event type.
   */
  public subscribe<E extends DomainEvent>(eventType: string, handler: DomainEventHandler<E>): void {
    const set = this.handlers.get(eventType) ?? new Set();
    set.add(handler as DomainEventHandler);
    this.handlers.set(eventType, set);
  }

  /**
   * Publish a domain event to all subscribed handlers.
   */
  public async publish<E extends DomainEvent>(event: E): Promise<void> {
    const set = this.handlers.get(event.type);
    if (!set?.size) return;
    await Promise.all([...set].map(handler => handler(event)));
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Domain Service – KPI Drift Monitor                                                            */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Service responsible for comparing live KPIs with historical baselines and
 * emitting domain events when drift crosses configured thresholds.
 */
export class KpiDriftMonitorService {
  public constructor(
    private readonly baselineProvider: () => Promise<KpiTimeSeries>,
    private readonly currentProvider: () => Promise<KpiTimeSeries>,
    private readonly strategy: DriftDetectionStrategy,
    private readonly eventBus: EventBus = new EventBus(),
    private readonly logger: Pick<Console, 'info' | 'warn' | 'error'> = console
  ) {}

  /**
   * Runs drift detection, emitting an event when triggered.
   *
   * @param kpiName – Logical KPI identifier (e.g., 'customer_lifetime_value')
   */
  public async evaluate(kpiName: string): Promise<DriftResult> {
    try {
      const [baseline, current] = await Promise.all([
        this.baselineProvider(),
        this.currentProvider()
      ]);

      const result = this.strategy.detectDrift(baseline, current);

      if (result.driftDetected) {
        this.logger.warn(
          `[KPI-Drift-Monitor] Drift detected for "${kpiName}" using ${result.algorithm}. (score=${result.driftScore.toFixed(4)})`
        );
        await this.eventBus.publish(new KpiDriftDetectedEvent(kpiName, result));
      } else {
        this.logger.info(
          `[KPI-Drift-Monitor] No significant drift for "${kpiName}" (${result.algorithm}, score=${result.driftScore.toFixed(
            4
          )}).`
        );
      }

      return result;
    } catch (err) {
      // Ensure domain failures are surfaced explicitly
      this.logger.error(`[KPI-Drift-Monitor] Failed to evaluate drift for "${kpiName}":`, err);
      throw err;
    }
  }

  /**
   * Expose event-bus subscription for adapter modules (e.g., Slack alerts, dashboards).
   */
  public onDriftDetected(handler: DomainEventHandler<KpiDriftDetectedEvent>): void {
    this.eventBus.subscribe('KPI_DRIFT_DETECTED', handler);
  }
}

/* ────────────────────────────────────────────────────────────────────────────────────────────── */
/* Usage Example (kept self-contained; in production import into app layer)                      */
/* ────────────────────────────────────────────────────────────────────────────────────────────── */

// The following snippet demonstrates how this module might be used in the application layer.
// It is intentionally kept minimal and synchronous-looking for clarity. Remove or adapt as needed.

if (process.env.NODE_ENV === 'development') {
  (async () => {
    // Synthetic baseline (normal distribution)
    const baseline: KpiTimeSeries = range(0, 1000).map(() => ({
      timestamp: new Date(),
      value: Math.random() * 100
    }));

    // Synthetic current (shifted distribution)
    const current: KpiTimeSeries = range(0, 1000).map(() => ({
      timestamp: new Date(),
      value: Math.random() * 100 + 20 // +20 shift → drift
    }));

    // Providers fetch data from a feature store or metrics lake in real scenarios
    const baselineProvider = async () => baseline;
    const currentProvider = async () => current;

    const strategy = DriftDetectionStrategyFactory.create(DriftDetectionAlgorithm.PSI, {
      bucketCount: 12,
      threshold: 0.1
    });

    const monitor = new KpiDriftMonitorService(baselineProvider, currentProvider, strategy);

    // Register an observer to e.g., send Slack alerts
    monitor.onDriftDetected(async event => {
      // Replace with proper infrastructure adapter
      console.log(
        `🚨 Drift Alert for ${event.kpiName}: ${event.result.algorithm} score=${event.result.driftScore.toFixed(3)}`
      );
    });

    // Evaluate drift
    await monitor.evaluate('demo_kpi');
  })().catch(err => console.error(err));
}
```
