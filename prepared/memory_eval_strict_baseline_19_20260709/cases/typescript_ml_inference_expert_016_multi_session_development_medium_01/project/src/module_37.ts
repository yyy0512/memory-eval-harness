```typescript
/* eslint-disable max-classes-per-file */

/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * Module: KPI Drift Monitoring (Hexagon – Domain Service)
 *
 * This service is responsible for detecting statistical drift in
 * revenue-impacting KPIs produced by deployed ML models.  It relies on
 * the Observer-Pattern to emit `DriftEvent`s, the Strategy-Pattern to
 * swap detection algorithms at runtime, and a Factory-Pattern for safe
 * instantiation.
 *
 * NOTE: Keep this file UI / IO free.  Adapters (Kafka producers, e-mail
 * notifiers, etc.) should implement the `MetricObserver` interface in
 * their respective adapter layer.
 */

import { mean, ksTest } from 'simple-statistics';
import { cloneDeep, isNumber } from 'lodash';

/* ------------------------------------------------------------------ */
/*                          Domain Models                             */
/* ------------------------------------------------------------------ */

/**
 * A set of numeric observations belonging to a single KPI.
 */
export type NumericSeries = number[];

/**
 * Names of KPIs that can be monitored.  Extend as necessary.
 */
export enum KPIName {
  CUSTOMER_LTV = 'customer_lifetime_value',
  CHURN_SCORE = 'churn_risk_score',
  NPS_PREDICTION = 'net_promoter_score',
}

/**
 * Outcome of a drift detection run.
 */
export interface DriftResult {
  readonly kpi: KPIName;
  readonly driftDetected: boolean;
  readonly pValue: number;
  readonly statistic: number;
  readonly referenceWindow: NumericSeries;
  readonly productionWindow: NumericSeries;
}

/**
 * Event propagated to observers when drift is detected (or resolved).
 */
export interface DriftEvent {
  readonly at: Date;
  readonly result: DriftResult;
}

/* ------------------------------------------------------------------ */
/*                   Strategy: Drift Detection Algo                    */
/* ------------------------------------------------------------------ */

/**
 * Strategy interface all algorithms must implement.
 */
export interface DriftDetectionStrategy {
  /**
   * Detects whether drift occurred between two numeric samples.
   */
  detect(reference: NumericSeries, production: NumericSeries, kpi: KPIName): DriftResult;
}

/**
 * PSI (Population Stability Index) implementation.
 *
 * Widely used for risk and churn models.  We keep the implementation
 * intentionally simple; production code would likely use more robust
 * binning & regularization.
 */
export class PsiDriftStrategy implements DriftDetectionStrategy {
  private readonly binCount: number;

  constructor(binCount = 10) {
    this.binCount = binCount;
  }

  // eslint-disable-next-line class-methods-use-this
  private psi(expected: NumericSeries, actual: NumericSeries): number {
    if (expected.length === 0 || actual.length === 0) return 0;
    const min = Math.min(...expected, ...actual);
    const max = Math.max(...expected, ...actual);

    // Guard against degenerate cases
    if (min === max) return 0;

    const binSize = (max - min) / this.binCount;
    let psi = 0;

    for (let i = 0; i < this.binCount; i += 1) {
      const lower = min + i * binSize;
      const upper = lower + binSize;
      const expectedCount = expected.filter((v) => v >= lower && v < upper).length;
      const actualCount = actual.filter((v) => v >= lower && v < upper).length;

      const expectedPct = expectedCount / expected.length || 0.0001; // avoid log(0)
      const actualPct = actualCount / actual.length || 0.0001;

      psi += (actualPct - expectedPct) * Math.log(actualPct / expectedPct);
    }

    return psi;
  }

  detect(reference: NumericSeries, production: NumericSeries, kpi: KPIName): DriftResult {
    const statistic = this.psi(reference, production);
    // Rule-of-thumb thresholds:
    // <0.1 no drift, 0.1–0.25 moderate, >0.25 significant
    const driftDetected = statistic > 0.25;

    return {
      kpi,
      driftDetected,
      pValue: Number.NaN, // PSI has no p-value
      statistic,
      referenceWindow: cloneDeep(reference),
      productionWindow: cloneDeep(production),
    };
  }
}

/**
 * Kolmogorov–Smirnov strategy (non-parametric test).
 */
export class KsDriftStrategy implements DriftDetectionStrategy {
  detect(reference: NumericSeries, production: NumericSeries, kpi: KPIName): DriftResult {
    const { d: statistic, pValue } = ksTest(reference, production);
    const driftDetected = pValue < 0.05; // configurable α

    return {
      kpi,
      driftDetected,
      pValue,
      statistic,
      referenceWindow: cloneDeep(reference),
      productionWindow: cloneDeep(production),
    };
  }
}

/* ------------------------------------------------------------------ */
/*                  Factory: Safe Strategy Creation                    */
/* ------------------------------------------------------------------ */

export enum DriftAlgorithm {
  PSI = 'psi',
  KS = 'ks',
}

export class DriftDetectionStrategyFactory {
  /**
   * Returns an instance of the requested algorithm.
   * Throws if the algorithm is unsupported.
   */
  // eslint-disable-next-line class-methods-use-this
  create(algo: DriftAlgorithm): DriftDetectionStrategy {
    switch (algo) {
      case DriftAlgorithm.PSI:
        return new PsiDriftStrategy();
      case DriftAlgorithm.KS:
        return new KsDriftStrategy();
      default:
        throw new Error(`Unsupported drift algorithm "${algo}"`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                 Observer Pattern: Subject & Observer                */
/* ------------------------------------------------------------------ */

export interface MetricObserver {
  /**
   * Handle a published event.
   *
   * Exceptions must not propagate back to the domain, so observers
   * should catch internally.  We defensively wrap calls here as well.
   */
  update(event: DriftEvent): void;
}

export abstract class DriftSubject {
  private readonly observers = new Set<MetricObserver>();

  addObserver(observer: MetricObserver): void {
    this.observers.add(observer);
  }

  removeObserver(observer: MetricObserver): void {
    this.observers.delete(observer);
  }

  protected notify(event: DriftEvent): void {
    this.observers.forEach((observer) => {
      try {
        observer.update(event);
      } catch (err) {
        // The domain layer should never fail because of an adapter error.
        // We log and move on. In production, use a structured logger.
        // eslint-disable-next-line no-console
        console.error('Observer failed to handle DriftEvent:', err);
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/*                  Domain Service: KPI Drift Monitor                  */
/* ------------------------------------------------------------------ */

/**
 * Sliding-window drift monitoring service.
 *
 * Usage (inside hexagon):
 *   const monitor = new KPIDriftMonitorService({
 *     windowSize: 500,
 *     algorithm: DriftAlgorithm.KS,
 *   });
 *
 *   monitor.addObserver(new DashboardNotifierAdapter());
 *   monitor.ingest(KPIName.CHURN_SCORE, 0.27);
 */
export interface KPIDriftMonitorOptions {
  readonly windowSize: number; // e.g., last 1 000 predictions
  readonly algorithm: DriftAlgorithm;
}

type KPIWindow = Map<KPIName, NumericSeries>;

export class KPIDriftMonitorService extends DriftSubject {
  private readonly windowSize: number;

  private readonly strategy: DriftDetectionStrategy;

  private readonly referenceWindow: KPIWindow = new Map();

  private readonly productionWindow: KPIWindow = new Map();

  constructor(options: KPIDriftMonitorOptions, factory = new DriftDetectionStrategyFactory()) {
    super();
    this.windowSize = options.windowSize;
    this.strategy = factory.create(options.algorithm);
  }

  /**
   * Ingest a single numeric observation for the specified KPI.
   * When both reference & production windows are full, the strategy
   * gets executed and observers are notified.
   */
  ingest(kpi: KPIName, value: number, isReference = false): void {
    if (!isNumber(value) || Number.isNaN(value)) {
      // eslint-disable-next-line no-console
      console.warn(`[KPIDriftMonitorService] Ignoring NaN for KPI "${kpi}"`);
      return;
    }

    const targetWindow = isReference ? this.referenceWindow : this.productionWindow;
    const series = targetWindow.get(kpi) ?? [];
    series.push(value);

    if (series.length > this.windowSize) {
      series.shift(); // maintain sliding window
    }

    targetWindow.set(kpi, series);

    // Only evaluate if both windows have enough data
    const refSeries = this.referenceWindow.get(kpi);
    const prodSeries = this.productionWindow.get(kpi);

    if (refSeries?.length === this.windowSize && prodSeries?.length === this.windowSize) {
      const result = this.strategy.detect(refSeries, prodSeries, kpi);
      this.notify({ at: new Date(), result });
    }
  }

  /**
   * Resets internal state for a specific KPI.
   */
  reset(kpi: KPIName): void {
    this.referenceWindow.delete(kpi);
    this.productionWindow.delete(kpi);
  }

  /**
   * Returns the mean of the current production window,
   * useful for quick health checks.
   */
  getCurrentMean(kpi: KPIName): number | undefined {
    const series = this.productionWindow.get(kpi);
    return series && series.length > 0 ? mean(series) : undefined;
  }
}

/* ------------------------------------------------------------------ */
/*                             Re-Exports                             */
/* ------------------------------------------------------------------ */

export {
  DriftAlgorithm as SupportedDriftAlgorithm,
  PsiDriftStrategy,
  KsDriftStrategy,
};
```