```typescript
/**
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * File:        src/module_27.ts
 * Description: Core domain service responsible for KPI drift detection
 *              and observer notification. Sits entirely inside the
 *              “hexagon”; all dependencies on IO or frameworks are
 *              inverted via ports (interfaces) so that adapters may
 *              live elsewhere in the project tree.
 *
 * Architectural concerns addressed in this module:
 *  - Observer Pattern           -> Notify distinct stakeholders (e.g., dashboards, alerting systems)
 *  - Strategy & Factory Pattern -> Pluggable drift-detection algorithms
 *  - Domain-Driven Design       -> Ubiquitous language around KPI, Drift, Strategy, Observer
 *
 * NOTE: The chosen statistics are simplified for brevity. Replace or
 *       extend with production-grade statistical tests as needed.
 */

import { mean, std } from 'mathjs';
import { v4 as uuid } from 'uuid';

/* ------------------------------------------------------------------ */
/*                             Domain Types                            */
/* ------------------------------------------------------------------ */

/** Represents an individual KPI observation */
export interface KPIRecord {
  readonly id: string;
  readonly metricName: string;
  readonly actual: number;
  readonly predicted?: number; // Optional for purely observed metrics
  readonly timestamp: Date;
}

/** The outcome of a drift-detection evaluation */
export interface DriftResult {
  readonly metricName: string;
  readonly driftScore: number;
  readonly isDrifted: boolean;
  readonly detectedAt: Date;
  readonly strategyUsed: string;
  readonly additionalDetails?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*                       Strategy Pattern (Port)                       */
/* ------------------------------------------------------------------ */

/**
 * Drift-detection algorithms must conform to this contract so the
 * domain service can remain agnostic of the underlying math.
 */
export interface DriftDetectionStrategy {
  readonly name: string;

  /**
   * @param baseline Set of historical records representing the
   *                 distribution we consider “normal”.
   * @param production Recent records to compare against the baseline.
   */
  detect(baseline: KPIRecord[], production: KPIRecord[]): DriftResult;
}

/* ------------------------------------------------------------------ */
/*                Concrete Strategy Implementations (Adapters)         */
/* ------------------------------------------------------------------ */

/**
 * Simple z-score based drift detection: compares the mean of the
 * production window to the baseline mean and flags drift when the
 * difference is more than `threshold` standard deviations.
 */
export class ZScoreDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'Z_SCORE';

  constructor(private readonly threshold: number = 3) {}

  detect(baseline: KPIRecord[], production: KPIRecord[]): DriftResult {
    if (baseline.length === 0 || production.length === 0) {
      throw new Error('[ZScoreDrift] Both baseline and production datasets must be non-empty');
    }

    const baselineValues = baseline.map((r) => r.actual);
    const productionValues = production.map((r) => r.actual);

    const baselineMean = mean(baselineValues);
    const baselineStd = std(baselineValues) || 1e-6; // Avoid division by zero

    const productionMean = mean(productionValues);
    const zScore = Math.abs((productionMean - baselineMean) / baselineStd);

    return {
      metricName: baseline[0].metricName,
      driftScore: zScore,
      isDrifted: zScore >= this.threshold,
      detectedAt: new Date(),
      strategyUsed: this.name,
      additionalDetails: {
        baselineMean,
        productionMean,
        baselineStd
      }
    };
  }
}

/**
 * Population Stability Index (PSI) strategy. Discretizes both
 * distributions into equal-width buckets and computes PSI.
 */
export class PSIDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'PSI';

  constructor(private readonly numBuckets: number = 10, private readonly threshold: number = 0.2) {}

  detect(baseline: KPIRecord[], production: KPIRecord[]): DriftResult {
    if (baseline.length === 0 || production.length === 0) {
      throw new Error('[PSIDrift] Both baseline and production datasets must be non-empty');
    }

    const baselineValues = baseline.map((r) => r.actual);
    const productionValues = production.map((r) => r.actual);

    const minVal = Math.min(...baselineValues, ...productionValues);
    const maxVal = Math.max(...baselineValues, ...productionValues);

    const bucketSize = (maxVal - minVal) / this.numBuckets;
    const getBucket = (value: number) =>
      Math.min(Math.floor((value - minVal) / bucketSize), this.numBuckets - 1);

    const baselineBuckets = new Array(this.numBuckets).fill(0);
    const productionBuckets = new Array(this.numBuckets).fill(0);

    baselineValues.forEach((v) => baselineBuckets[getBucket(v)]++);
    productionValues.forEach((v) => productionBuckets[getBucket(v)]++);

    const psi = baselineBuckets.reduce((acc, baseCount, idx) => {
      const prodCount = productionBuckets[idx];

      const basePct = baseCount / baselineValues.length || 1e-6;
      const prodPct = prodCount / productionValues.length || 1e-6;

      return acc + (prodPct - basePct) * Math.log(prodPct / basePct);
    }, 0);

    return {
      metricName: baseline[0].metricName,
      driftScore: psi,
      isDrifted: psi >= this.threshold,
      detectedAt: new Date(),
      strategyUsed: this.name,
      additionalDetails: {
        numBuckets: this.numBuckets,
        bucketSize,
        psiPerBucket: baselineBuckets.map((baseCount, idx) => {
          const prodCount = productionBuckets[idx];
          const basePct = baseCount / baselineValues.length || 1e-6;
          const prodPct = prodCount / productionValues.length || 1e-6;
          return (prodPct - basePct) * Math.log(prodPct / basePct);
        })
      }
    };
  }
}

/* ------------------------------------------------------------------ */
/*                        Strategy Factory (Factory)                   */
/* ------------------------------------------------------------------ */

export enum DriftStrategyType {
  Z_SCORE = 'Z_SCORE',
  PSI = 'PSI'
}

export class DriftStrategyFactory {
  static create(type: DriftStrategyType, options?: Record<string, unknown>): DriftDetectionStrategy {
    switch (type) {
      case DriftStrategyType.Z_SCORE:
        return new ZScoreDriftStrategy(
          (options?.threshold as number | undefined) ?? 3
        );
      case DriftStrategyType.PSI:
        return new PSIDriftStrategy(
          (options?.numBuckets as number | undefined) ?? 10,
          (options?.threshold as number | undefined) ?? 0.2
        );
      default:
        throw new Error(`[DriftStrategyFactory] Unsupported strategy type: ${type}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                       Observer Pattern (Port)                       */
/* ------------------------------------------------------------------ */

/**
 * Observers are notified whenever a drift event is detected.
 * Examples: Slack notifier, PagerDuty incident creator, PowerBI dashboard.
 */
export interface DriftObserver {
  onDrift(result: DriftResult): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*                      Domain Service: Drift Monitor                  */
/* ------------------------------------------------------------------ */

interface DriftMonitorConfig {
  /** How many records constitute the baseline distribution */
  baselineWindowSize: number;
  /** How many records constitute the production window */
  productionWindowSize: number;
  /** Strategy metadata */
  strategyType: DriftStrategyType;
  strategyOptions?: Record<string, unknown>;
}

/**
 * Drift monitor keeps sliding windows of KPI data and periodically
 * checks for drift, notifying observers when detected.
 */
export class KPIDriftMonitor {
  private readonly baselineWindow: KPIRecord[] = [];
  private readonly productionWindow: KPIRecord[] = [];
  private readonly observers: Set<DriftObserver> = new Set();
  private readonly strategy: DriftDetectionStrategy;

  constructor(private readonly config: DriftMonitorConfig) {
    this.strategy = DriftStrategyFactory.create(config.strategyType, config.strategyOptions);
  }

  /**
   * Register observer to receive drift notifications
   */
  addObserver(observer: DriftObserver): void {
    this.observers.add(observer);
  }

  /**
   * Remove previously registered observer
   */
  removeObserver(observer: DriftObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Push a new record into the monitor. Internally manages sliding windows.
   */
  ingest(record: Omit<KPIRecord, 'id' | 'timestamp'>): void {
    const enriched: KPIRecord = { ...record, id: uuid(), timestamp: new Date() };

    // Determine which window to add to: first we fill baseline, then production
    if (this.baselineWindow.length < this.config.baselineWindowSize) {
      this.baselineWindow.push(enriched);
    } else {
      if (this.productionWindow.length >= this.config.productionWindowSize) {
        // Sliding window: remove oldest
        this.productionWindow.shift();
      }
      this.productionWindow.push(enriched);
    }

    // Once both windows are ready, evaluate drift
    if (
      this.baselineWindow.length === this.config.baselineWindowSize &&
      this.productionWindow.length === this.config.productionWindowSize
    ) {
      this.evaluateDrift().catch((err) =>
        // For domain integrity we prefer not to throw; log and continue
        console.error('[KPIDriftMonitor] Drift evaluation error:', err)
      );
    }
  }

  /** Evaluate drift using configured strategy and notify observers */
  private async evaluateDrift(): Promise<void> {
    const result = this.strategy.detect([...this.baselineWindow], [...this.productionWindow]);

    if (result.isDrifted) {
      await Promise.all(
        [...this.observers].map(async (observer) => {
          try {
            await observer.onDrift(result);
          } catch (err) {
            // Log individual observer errors but continue notifying the rest
            console.error(
              `[KPIDriftMonitor] Observer failure (${observer.constructor.name}):`,
              err
            );
          }
        })
      );
    }

    // Slide baseline forward by swapping windows
    this.baselineWindow.splice(
      0,
      this.config.productionWindowSize,
      ...this.productionWindow.splice(0)
    );
  }
}

/* ------------------------------------------------------------------ */
/*           Example Observer Implementation (Adapter placeholder)     */
/* ------------------------------------------------------------------ */

/**
 * Example observer that logs drift details. Real adapters will live
 * outside the hexagon (e.g., src/adapters/obs_slack_notifier.ts).
 */
export class ConsoleDriftObserver implements DriftObserver {
  async onDrift(result: DriftResult): Promise<void> {
    // In production, replace console.log with a proper logger
    console.log(`⚠️  KPI drift detected for [${result.metricName}] ` +
                `(strategy=${result.strategyUsed}, score=${result.driftScore.toFixed(4)})`);
  }
}

/* ------------------------------------------------------------------ */
/*                            Usage Example                            */
/* ------------------------------------------------------------------ */

// The following section should be removed in unit tests but is
// retained here for self-contained demonstration purposes.

if (require.main === module) {
  const monitor = new KPIDriftMonitor({
    baselineWindowSize: 50,
    productionWindowSize: 50,
    strategyType: DriftStrategyType.Z_SCORE,
    strategyOptions: { threshold: 2.5 }
  });

  monitor.addObserver(new ConsoleDriftObserver());

  // Seed baseline with stable distribution
  for (let i = 0; i < 120; i++) {
    const value =
      i < 60 ? 100 + Math.random() * 10 : 150 + Math.random() * 5; // Shift mean midway
    monitor.ingest({ metricName: 'profit_margin', actual: value });
  }
}
```