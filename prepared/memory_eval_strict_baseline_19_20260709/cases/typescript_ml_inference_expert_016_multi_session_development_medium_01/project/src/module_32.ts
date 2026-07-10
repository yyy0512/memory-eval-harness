```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * FILE:        src/module_32.ts
 * AUTHOR:      InsightHexaAI Core Team
 *
 * DESCRIPTION:
 *   Reactive KPI-drift monitoring module built around Observer-, Strategy- and Factory-Patterns.
 *   – Detects statistical drift between reference (training) and current (serving) distributions.
 *   – Emits strongly-typed, severity-scored DriftResult events to downstream observers (e.g. PagerDuty
 *     alerts, BI dashboards, adaptive-retraining pipelines).
 *   – Fully hexagonal: business logic lives here; data sources / sinks are injected as ports.
 *
 * PUBLIC EXPORTS:
 *   • DriftDetectionStrategy            – Strategy Pattern interface
 *   • DriftDetectionStrategyFactory     – Factory to instantiate a concrete strategy
 *   • DriftObserver                     – Observer Pattern interface
 *   • DriftResult, DriftSeverity        – Domain entities
 *   • ModelDriftMonitor                 – Aggregate root coordinating detection + notifications
 *
 * USAGE EXAMPLE (outside hexagon):
 *   const monitor = new ModelDriftMonitor({
 *       strategy: DriftDetectionStrategyFactory.create('PSI', { bucketCount: 10 })
 *   });
 *   monitor.attach(new PagerDutyObserver(...));
 *   await monitor.evaluate(await featureStore.fetch('churn_risk_score'));
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { chunk, mean, sum } from 'lodash';

/* ──────────────────────────────────────────────────────────────────────────────
 * DOMAIN TYPES
 * ──────────────────────────────────────────────────────────────────────────── */

export type DriftSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * Result returned by a drift‐detection strategy.
 */
export interface DriftResult {
  readonly severity: DriftSeverity;
  readonly score: number;
  readonly details?: string;
  readonly timestamp: Date;
}

/**
 * Observer Pattern – every consumer interested in drift results implements this.
 */
export interface DriftObserver {
  /**
   * Receives a new drift result pushed by the monitor.
   * @throws if downstream processing fails (handled by monitor)
   */
  update(result: DriftResult): Promise<void> | void;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * STRATEGY PATTERN
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Contract every statistical drift‐detection strategy must satisfy.
 */
export interface DriftDetectionStrategy {
  /**
   * Detect distribution shift between two numeric samples.
   * @param referenceData Array of numeric values representing the reference distribution.
   * @param currentData   Array of numeric values representing the production distribution.
   * @returns DriftResult Business-level result with severity & explanatory metadata.
   */
  detect(referenceData: number[], currentData: number[]): DriftResult;
}

/**
 * Simple KL-Divergence implementation (discretised).
 */
class KLDivergenceStrategy implements DriftDetectionStrategy {
  private readonly epsilon = 1e-10; // Smoothing term to avoid log(0)

  // Bucket count can be configured at construction time
  public constructor(private readonly bucketCount: number = 20) {}

  public detect(referenceData: number[], currentData: number[]): DriftResult {
    this.assertSamples(referenceData, currentData);

    const { referenceBuckets, currentBuckets } = this.buildHistograms(
      referenceData,
      currentData,
    );

    let klSum = 0;
    for (let i = 0; i < this.bucketCount; i++) {
      const p = referenceBuckets[i] + this.epsilon;
      const q = currentBuckets[i] + this.epsilon;
      klSum += p * Math.log(p / q);
    }

    const severity = this.mapScoreToSeverity(klSum);
    return {
      severity,
      score: klSum,
      details: `KL-Divergence (${this.bucketCount} buckets)`,
      timestamp: new Date(),
    };
  }

  /* ─────────────── helpers ─────────────── */

  private assertSamples(ref: number[], cur: number[]): void {
    const MIN_SIZE = 10;
    if (ref.length < MIN_SIZE || cur.length < MIN_SIZE) {
      throw new Error(
        `Insufficient sample size. Need ≥${MIN_SIZE} observations for reliable KL test.`,
      );
    }
  }

  private buildHistograms(reference: number[], current: number[]) {
    const minVal = Math.min(...reference, ...current);
    const maxVal = Math.max(...reference, ...current);
    const width = (maxVal - minVal) / this.bucketCount;

    const zeroArray = Array(this.bucketCount).fill(0);

    const referenceBuckets = [...zeroArray];
    for (const v of reference) {
      const idx = Math.min(
        this.bucketCount - 1,
        Math.floor((v - minVal) / width),
      );
      referenceBuckets[idx] += 1;
    }

    const currentBuckets = [...zeroArray];
    for (const v of current) {
      const idx = Math.min(
        this.bucketCount - 1,
        Math.floor((v - minVal) / width),
      );
      currentBuckets[idx] += 1;
    }

    // Normalise to probability mass functions.
    const refTotal = sum(referenceBuckets);
    const curTotal = sum(currentBuckets);
    return {
      referenceBuckets: referenceBuckets.map((c) => c / refTotal),
      currentBuckets: currentBuckets.map((c) => c / curTotal),
    };
  }

  private mapScoreToSeverity(score: number): DriftSeverity {
    if (score < 0.02) return 'NONE';
    if (score < 0.1) return 'LOW';
    if (score < 0.5) return 'MEDIUM';
    if (score < 1) return 'HIGH';
    return 'CRITICAL';
  }
}

/**
 * Population Stability Index (PSI) strategy.
 * Ref: https://en.wikipedia.org/wiki/Population_stability_index
 */
class PSIStrategy implements DriftDetectionStrategy {
  public constructor(private readonly bucketCount: number = 10) {}

  public detect(referenceData: number[], currentData: number[]): DriftResult {
    this.assertSamples(referenceData, currentData);

    const { referenceBuckets, currentBuckets } = this.buildHistograms(
      referenceData,
      currentData,
    );

    let psi = 0;
    for (let i = 0; i < this.bucketCount; i++) {
      const p = referenceBuckets[i];
      const q = currentBuckets[i];
      psi += (q - p) * Math.log(q / p);
    }

    const severity = this.mapScoreToSeverity(psi);
    return {
      severity,
      score: psi,
      details: `Population Stability Index (${this.bucketCount} buckets)`,
      timestamp: new Date(),
    };
  }

  /* ─────────────── helpers ─────────────── */

  private assertSamples(ref: number[], cur: number[]): void {
    const MIN_SIZE = 10;
    if (ref.length < MIN_SIZE || cur.length < MIN_SIZE) {
      throw new Error(
        `Insufficient sample size. Need ≥${MIN_SIZE} observations for reliable PSI.`,
      );
    }
  }

  private buildHistograms(reference: number[], current: number[]) {
    const minVal = Math.min(...reference, ...current);
    const maxVal = Math.max(...reference, ...current);
    const width = (maxVal - minVal) / this.bucketCount;

    const zeroArray = Array(this.bucketCount).fill(0);

    const referenceBuckets = [...zeroArray];
    for (const v of reference) {
      const idx = Math.min(
        this.bucketCount - 1,
        Math.floor((v - minVal) / width),
      );
      referenceBuckets[idx] += 1;
    }

    const currentBuckets = [...zeroArray];
    for (const v of current) {
      const idx = Math.min(
        this.bucketCount - 1,
        Math.floor((v - minVal) / width),
      );
      currentBuckets[idx] += 1;
    }

    const refTotal = sum(referenceBuckets);
    const curTotal = sum(currentBuckets);
    return {
      referenceBuckets: referenceBuckets.map((c) => c / refTotal),
      currentBuckets: currentBuckets.map((c) => c / curTotal),
    };
  }

  private mapScoreToSeverity(score: number): DriftSeverity {
    if (score < 0.1) return 'NONE';
    if (score < 0.25) return 'LOW';
    if (score < 0.5) return 'MEDIUM';
    if (score < 0.7) return 'HIGH';
    return 'CRITICAL';
  }
}

/**
 * Strategy Factory – centralised creation logic.
 */
export class DriftDetectionStrategyFactory {
  /**
   * Build a strategy by name.
   */
  public static create(
    name: 'KL' | 'PSI',
    options: Record<string, unknown> = {},
  ): DriftDetectionStrategy {
    switch (name) {
      case 'KL':
        return new KLDivergenceStrategy(
          (options.bucketCount as number) ?? 20,
        );
      case 'PSI':
        return new PSIStrategy((options.bucketCount as number) ?? 10);
      default:
        throw new Error(`Unknown drift detection strategy: "${name}"`);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * MODEL DRIFT MONITOR (Aggregate Root)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ModelDriftMonitorOptions {
  readonly strategy: DriftDetectionStrategy;
  readonly maxObserverFailures?: number; // fail-safe breaker
}

/**
 * Coordinates data gathering, strategy execution and observer notification.
 */
export class ModelDriftMonitor {
  private readonly observers: Set<DriftObserver> = new Set();
  private readonly emitter = new EventEmitter();
  private failureCounts: Map<DriftObserver, number> = new Map();

  private readonly maxObserverFailures: number;

  public constructor(private readonly opts: ModelDriftMonitorOptions) {
    this.maxObserverFailures = opts.maxObserverFailures ?? 3;

    // Forward emitter events to observers (decoupled & Promise aware)
    this.emitter.on('drift', (res: DriftResult) =>
      this.broadcast(res).catch((err) =>
        // eslint-disable-next-line no-console
        console.error('[ModelDriftMonitor] Broadcast error:', err),
      ),
    );
  }

  /* ─────────────── Observer management ─────────────── */

  public attach(observer: DriftObserver): void {
    this.observers.add(observer);
  }

  public detach(observer: DriftObserver): void {
    this.observers.delete(observer);
    this.failureCounts.delete(observer);
  }

  /* ─────────────── Public API ─────────────── */

  /**
   * Evaluate drift synchronously and notify all observers.
   * Exposed as `async` to accommodate future async strategies.
   */
  public async evaluate(
    referenceData: number[],
    currentData: number[],
  ): Promise<DriftResult> {
    const result = this.opts.strategy.detect(referenceData, currentData);
    this.emitter.emit('drift', result);
    return result;
  }

  /* ─────────────── internal helpers ─────────────── */

  private async broadcast(result: DriftResult): Promise<void> {
    const tasks = Array.from(this.observers).map(async (observer) => {
      try {
        await observer.update(result);
        this.failureCounts.set(observer, 0); // reset on success
      } catch (err) {
        const failures = (this.failureCounts.get(observer) ?? 0) + 1;
        this.failureCounts.set(observer, failures);
        // eslint-disable-next-line no-console
        console.error(
          `[ModelDriftMonitor] Observer ${observer.constructor.name} failed (${failures}/${this.maxObserverFailures})`,
          err,
        );
        if (failures >= this.maxObserverFailures) {
          // circuit-break misbehaving observer
          this.detach(observer);
          // eslint-disable-next-line no-console
          console.warn(
            `[ModelDriftMonitor] Detached faulty observer ${observer.constructor.name}`,
          );
        }
      }
    });

    await Promise.allSettled(tasks);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * REFERENCE IMPLEMENTATION: Observer that logs & triggers retraining.
 * (Adapters would live elsewhere; included for completeness)
 * ──────────────────────────────────────────────────────────────────────────── */

export class ConsoleLoggingObserver implements DriftObserver {
  public update(result: DriftResult): void {
    // Here we could integrate with Winston / structured logs.
    // eslint-disable-next-line no-console
    console.info(
      `[Drift] severity=${result.severity} score=${result.score.toFixed(
        4,
      )} details=${result.details}`,
    );
  }
}

/**
 * Example observer triggering an auto-retraining pipeline when severity ≥ HIGH.
 */
export class AutoRetrainObserver implements DriftObserver {
  public constructor(
    private readonly retrainPipeline: (triggeredBy: DriftResult) => Promise<void>,
  ) {}

  public async update(result: DriftResult): Promise<void> {
    if (['HIGH', 'CRITICAL'].includes(result.severity)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[AutoRetrainObserver] Drift ${result.severity} detected. Starting retraining...`,
      );
      await this.retrainPipeline(result);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * INTERNAL UTILS (may be promoted to shared lib)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Compute basic statistics for debugging / dashboard display.
 */
export function quickStats(arr: number[]): { mean: number; size: number } {
  return {
    mean: mean(arr),
    size: arr.length,
  };
}
```