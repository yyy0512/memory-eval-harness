```typescript
/* ============================================================================
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ----------------------------------------------------------------------------
 * File:          src/module_59.ts
 * Purpose:       Domain service for KPI–Drift monitoring. Implements the
 *                Observer & Strategy patterns to detect, classify and
 *                broadcast drift events to interested adapters (dashboards,
 *                incident managers, etc.) while remaining agnostic of the
 *                surrounding IO-layer.
 * Author:        InsightHexaAI Core Team
 * License:       MIT
 * ========================================================================== */

import { EventEmitter } from 'events';

/* ----------------------------------------------------------------------------
 * Shared / Domain-Types
 * -------------------------------------------------------------------------- */

/**
 * A point-in-time numeric sample for a given KPI.
 */
export interface MetricSample {
  readonly timestamp: Date;
  readonly value: number;
}

/**
 * Semantic description of a detected drift.
 */
export interface KPIDriftReport {
  readonly metricName: string;
  readonly baseline: number;
  readonly current: number;
  /**
   * Normalised drift magnitude in the range [0, 1].
   */
  readonly drift: number;
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

/**
 * Centralised error type for drift-monitoring failures.
 */
export class KPIDriftError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'KPIDriftError';
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}

/* ----------------------------------------------------------------------------
 * Strategy-Pattern – Drift Detection Algorithms
 * -------------------------------------------------------------------------- */

/**
 * Contract for any algorithm that quantifies drift between two KPI windows.
 */
export interface DriftDetectionStrategy {
  /**
   * @param baseline  Historical window to compare against.
   * @param current   Live window being analysed.
   * @returns         Normalised drift magnitude in the range [0, 1].
   */
  computeDrift(baseline: MetricSample[], current: MetricSample[]): number;
}

/**
 * Drift = |μ_current − μ_baseline| / max(μ_baseline, ε)
 */
export class PercentageDifferenceStrategy implements DriftDetectionStrategy {
  private static readonly EPSILON = 1e-9;

  public computeDrift(baseline: MetricSample[], current: MetricSample[]): number {
    if (baseline.length === 0 || current.length === 0) {
      throw new KPIDriftError('Baseline or current window is empty.');
    }
    const mean = (samples: MetricSample[]) =>
      samples.reduce((acc, s) => acc + s.value, 0) / samples.length;

    const μBaseline = mean(baseline);
    const μCurrent = mean(current);
    const denom = Math.max(Math.abs(μBaseline), PercentageDifferenceStrategy.EPSILON);

    return Math.min(Math.abs(μCurrent - μBaseline) / denom, 1);
  }
}

/**
 * Naïve Kolmogorov–Smirnov distance between empirical CDFs.
 * NOTE: For production workloads, consider a streaming approximation.
 */
export class KSStatisticStrategy implements DriftDetectionStrategy {
  public computeDrift(baseline: MetricSample[], current: MetricSample[]): number {
    if (baseline.length === 0 || current.length === 0) {
      throw new KPIDriftError('Baseline or current window is empty.');
    }

    // Sort ascending once for O(n log n).
    const sortedBase = [...baseline].sort((a, b) => a.value - b.value);
    const sortedCurr = [...current].sort((a, b) => a.value - b.value);

    let i = 0,
      j = 0,
      d = 0;

    while (i < sortedBase.length && j < sortedCurr.length) {
      const valBase = sortedBase[i].value;
      const valCurr = sortedCurr[j].value;
      const stepVal = valBase <= valCurr ? valBase : valCurr;

      while (i < sortedBase.length && sortedBase[i].value <= stepVal) i++;
      while (j < sortedCurr.length && sortedCurr[j].value <= stepVal) j++;

      const cdfBase = i / sortedBase.length;
      const cdfCurr = j / sortedCurr.length;
      d = Math.max(d, Math.abs(cdfBase - cdfCurr));
    }

    return Math.min(d, 1);
  }
}

/**
 * Factory helper to hide algorithm-selection logic.
 */
export class DriftDetectionStrategyFactory {
  public static create(
    type: 'percentage' | 'ks' = 'percentage'
  ): DriftDetectionStrategy {
    switch (type) {
      case 'percentage':
        return new PercentageDifferenceStrategy();
      case 'ks':
        return new KSStatisticStrategy();
      default:
        /* c8 ignore next */
        throw new KPIDriftError(`Unsupported strategy: ${type}`);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Observer-Pattern – Drift Handlers
 * -------------------------------------------------------------------------- */

/**
 * Observer interface for any component interested in drift reports.
 * Adapters outside the hexagon (e.g. Slack, PagerDuty, Kafka) implement this.
 */
export interface DriftObserver {
  /**
   * Acts on the provided drift report. Must never crash the caller.
   */
  handle(report: KPIDriftReport): Promise<void>;
}

/**
 * No-op fallback observer to guarantee at least one safe sink.
 */
export class NullObserver implements DriftObserver {
  public async handle(): Promise<void> {
    /* intentionally blank – makes sure EventEmitter has ≥1 listener */
  }
}

/* ----------------------------------------------------------------------------
 * Domain-Service – KPI Drift Monitor
 * -------------------------------------------------------------------------- */

/**
 * The core domain service that encapsulates KPI-drift detection. It
 * orchestrates:
 *  • strategy evaluation
 *  • severity classification
 *  • observer notification
 */
export class KPIDriftMonitor extends EventEmitter {
  private readonly observers: ReadonlyArray<DriftObserver>;

  /**
   * @param strategy         The algorithm used to quantify drift.
   * @param threshold        Minimum drift magnitude before reporting.
   * @param observers        Set of observers to notify.
   * @param severityBuckets  Optional custom mapping of drift → severity.
   */
  constructor(
    private readonly strategy: DriftDetectionStrategy = DriftDetectionStrategyFactory.create(),
    private readonly threshold: number = 0.05,
    observers: DriftObserver[] = [new NullObserver()],
    private readonly severityBuckets: Readonly<Record<'low' | 'medium' | 'high' | 'critical', number>> = {
      low: threshold,
      medium: Math.min(threshold * 2, 1),
      high: Math.min(threshold * 4, 1),
      critical: Math.min(threshold * 8, 1)
    }
  ) {
    super();
    this.observers = observers;
  }

  /**
   * Computes drift and emits a report if the threshold is exceeded.
   */
  public async evaluate(
    baseline: MetricSample[],
    current: MetricSample[],
    metricName: string
  ): Promise<KPIDriftReport | null> {
    let drift = 0;
    try {
      drift = this.strategy.computeDrift(baseline, current);
    } catch (err) {
      // Guardrail: propagate without tearing down the pipeline
      throw new KPIDriftError('Drift evaluation failed.', err);
    }

    if (drift < this.threshold) {
      return null;
    }

    const report: KPIDriftReport = {
      metricName,
      baseline: this.mean(baseline),
      current: this.mean(current),
      drift,
      severity: this.classify(drift),
      windowStart: baseline[0].timestamp,
      windowEnd: current[current.length - 1].timestamp
    };

    await this.notify(report);

    return report;
  }

  /* ------------------------------------------------------------------------
   * Helpers
   * ---------------------------------------------------------------------- */

  private async notify(report: KPIDriftReport): Promise<void> {
    // Emit synchronously for in-process subscribers.
    this.emit('drift', report);

    // Notify external observers (fire-and-forget) with fail-fast semantics.
    await Promise.allSettled(
      this.observers.map(async (observer) => observer.handle(report))
    );
  }

  private mean(samples: MetricSample[]): number {
    return samples.reduce((acc, s) => acc + s.value, 0) / samples.length;
  }

  private classify(drift: number): KPIDriftReport['severity'] {
    if (drift >= this.severityBuckets.critical) return 'critical';
    if (drift >= this.severityBuckets.high) return 'high';
    if (drift >= this.severityBuckets.medium) return 'medium';
    return 'low';
  }
}

/* ----------------------------------------------------------------------------
 * Example Observer Implementations (Adapters)
 * -------------------------------------------------------------------------- */

/**
 * Simple console logger observer. Replace with Winston/Pino in prod.
 */
export class ConsoleLogObserver implements DriftObserver {
  public async handle(report: KPIDriftReport): Promise<void> {
    const msg = `[${report.severity.toUpperCase()}] KPI Drift detected for ${
      report.metricName
    } – baseline: ${report.baseline.toFixed(4)}, current: ${report.current.toFixed(
      4
    )}, drift: ${(report.drift * 100).toFixed(2)}%`;
    // eslint-disable-next-line no-console
    console.log(msg);
  }
}

/**
 * Example stub for an incident-management adapter (e.g. PagerDuty).
 * In real code, inject HTTP client & credentials via DI.
 */
export class PagerDutyObserver implements DriftObserver {
  constructor(private readonly routingKey: string) {}

  public async handle(report: KPIDriftReport): Promise<void> {
    if (report.severity === 'low') return; // Ignore noise.

    // Pseudocode: Simulate network call.
    try {
      await new Promise((res) => setTimeout(res, 50));
      /* httpClient.post('https://events.pagerduty.com/v2/enqueue', { … }) */
      // eslint-disable-next-line no-console
      console.info(`PagerDuty event triggered for ${report.metricName}`);
    } catch (err) {
      // Fail silently to avoid cascading failures.
      /* c8 ignore next */
      console.error('PagerDuty dispatch failed', err);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Module Exports
 * -------------------------------------------------------------------------- */

export default {
  KPIDriftMonitor,
  DriftDetectionStrategyFactory,
  PercentageDifferenceStrategy,
  KSStatisticStrategy,
  ConsoleLogObserver,
  PagerDutyObserver,
  KPIDriftError
};
```