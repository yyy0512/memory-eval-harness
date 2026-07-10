```typescript
/***************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:        src/module_29.ts
 *  Responsibility: Drift-Monitoring domain services + Observer pattern wiring inside the hexagon.
 *
 *  Why this file?
 *  --------------
 *  • Model predictions lose business value if their statistical assumptions diverge from reality.
 *  • Enterprises therefore demand continuous, explainable drift-detection with SLA-aware alerts.
 *  • This module provides a pluggable, strategy-driven implementation that lives in the domain
 *    core (no IO!), enabling adapters to hook in alerting, dashboards, or auto-retraining.
 *
 *  Architectural notes
 *  -------------------
 *  • StrategyPattern: interchangeable drift-metric algorithms (PSI, KS, Jensen–Shannon, …).
 *  • FactoryPattern: run-time selection based on config stored in the model registry.
 *  • ObserverPattern: pushes DriftEvent to subscribers without knowing concrete adapters.
 *
 *  External deps kept minimal (eventemitter3 for lightweight Node/EventTarget-agnostic bus).
 ***************************************************************************************************/

import EventEmitter from 'eventemitter3';
import { z } from 'zod';
import { mean, chunk } from 'lodash';

/**
 * Domain-level error to avoid leaking low-level exceptions outside the hexagon.
 */
export class DriftMonitorError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DriftMonitorError';
    this.cause = cause;
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * 1️⃣  Drift-Metric Strategy Contracts
 * ---------------------------------------------------------------------------------------------
 */

/** Raw distribution sample drawn from predictions or features. */
export type DistributionSample = number[];

/** Algorithm-agnostic interface every drift metric must implement. */
export interface DriftMetricStrategy {
  readonly name: string;
  /**
   * Computes a numeric drift metric. The larger the value, the greater the drift.
   *
   * @param baseline  – reference distribution (e.g., training set)
   * @param production – live distribution (e.g., last 1 000 predictions)
   * @returns numeric score in [0, ∞)
   */
  compute(baseline: DistributionSample, production: DistributionSample): number;
}

/**
 * -----------------------------------------------------------------------------------------------
 * 2️⃣  Strategy Implementations
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Calculates PSI (Population Stability Index).
 * Formula:
 * Σ((P_i − E_i) * ln(P_i / E_i))
 * Where P_i is percent of obs in bin i for production,
 *       E_i is percent of obs in bin i for expected/baseline.
 */
export class PopulationStabilityIndexStrategy implements DriftMetricStrategy {
  public readonly name = 'PSI';
  private readonly numBins: number;

  constructor(numBins = 10) {
    if (numBins <= 1) throw new DriftMonitorError('numBins must be > 1');
    this.numBins = numBins;
  }

  compute(baseline: DistributionSample, production: DistributionSample): number {
    if (baseline.length === 0 || production.length === 0) {
      throw new DriftMonitorError('Baseline and production samples must be non-empty');
    }

    const baselineSorted = [...baseline].sort((a, b) => a - b);
    const productionSorted = [...production].sort((a, b) => a - b);

    const baselineBins = chunk(baselineSorted, Math.ceil(baseline.length / this.numBins));
    const productionBins = chunk(productionSorted, Math.ceil(production.length / this.numBins));

    /**
     * Align bin counts: if one sample smaller may produce more bins than other
     */
    const maxBins = Math.max(baselineBins.length, productionBins.length);
    const expandBins = (bins: number[][]) => {
      while (bins.length < maxBins) bins.push([]);
      return bins;
    };
    expandBins(baselineBins);
    expandBins(productionBins);

    /** Percentages per bin */
    const percent = (bin: number[]) => bin.length / (bin === baselineBins[0] ? baseline.length : production.length);

    let psi = 0;
    for (let i = 0; i < maxBins; i++) {
      const expectedPct = percent(baselineBins[i]) || 1e-6; // avoid div/0
      const actualPct = percent(productionBins[i]) || 1e-6;

      psi += (actualPct - expectedPct) * Math.log(actualPct / expectedPct);
    }
    return psi;
  }
}

/**
 * Kolmogorov-Smirnov statistic (supremum distance between empirical CDFs).
 */
export class KolmogorovSmirnovStrategy implements DriftMetricStrategy {
  public readonly name = 'KS';

  compute(baseline: DistributionSample, production: DistributionSample): number {
    if (baseline.length === 0 || production.length === 0) {
      throw new DriftMonitorError('Baseline and production samples must be non-empty');
    }

    const combined = [...baseline, ...production].sort((a, b) => a - b);

    const cdf = (sample: number[], x: number): number => {
      let count = 0;
      for (const v of sample) if (v <= x) count++;
      return count / sample.length;
    };

    let maxDiff = 0;
    for (const val of combined) {
      const diff = Math.abs(cdf(baseline, val) - cdf(production, val));
      if (diff > maxDiff) maxDiff = diff;
    }
    return maxDiff;
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * 3️⃣  Strategy Factory
 * ---------------------------------------------------------------------------------------------
 */

export type DriftAlgorithm = 'PSI' | 'KS';

export class DriftMetricStrategyFactory {
  static create(algo: DriftAlgorithm, options?: Record<string, unknown>): DriftMetricStrategy {
    switch (algo) {
      case 'PSI':
        return new PopulationStabilityIndexStrategy(options?.numBins as number | undefined);
      case 'KS':
        return new KolmogorovSmirnovStrategy();
      default:
        throw new DriftMonitorError(`Unsupported drift algorithm: ${algo}`);
    }
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * 4️⃣  Observer Pattern Contracts
 * ---------------------------------------------------------------------------------------------
 */

export interface DriftEvent {
  readonly timestamp: Date;
  readonly metricName: string;
  readonly score: number;
  readonly baselineSampleSize: number;
  readonly productionSampleSize: number;
  /** free-form context for adapters (modelName, featureName, etc.) */
  readonly metadata?: Record<string, unknown>;
}

export interface DriftObserver {
  /**
   * Called whenever a new DriftEvent gets published.
   */
  onDrift(event: DriftEvent): void | Promise<void>;
}

/**
 * -----------------------------------------------------------------------------------------------
 * 5️⃣  ModelPerformanceMonitor  (Domain Service + Observable)
 * ---------------------------------------------------------------------------------------------
 */

export interface ModelPerformanceMonitorConfig {
  algorithm: DriftAlgorithm;
  /**
   * Score above which drift is considered significant.
   * PSI:   0.25 (commonly)
   * KS:    0.1  (commonly)
   */
  alertThreshold: number;
  /** Additional strategy options (e.g., bin size for PSI) */
  strategyOptions?: Record<string, unknown>;
  /** Maximum number of production data points to hold in memory (sliding window). */
  windowSize: number;
}

/**
 * Validates configuration using zod to fail-fast.
 */
const ConfigSchema = z.object({
  algorithm: z.enum(['PSI', 'KS']),
  alertThreshold: z.number().positive(),
  strategyOptions: z.record(z.any()).optional(),
  windowSize: z.number().positive().int().max(100_000),
});

export class ModelPerformanceMonitor {
  private readonly strategy: DriftMetricStrategy;
  private readonly baseline: DistributionSample;
  private readonly productionWindow: DistributionSample = [];
  private readonly emitter: EventEmitter = new EventEmitter();
  private readonly cfg: ModelPerformanceMonitorConfig;

  constructor(
    baseline: DistributionSample,
    cfg: ModelPerformanceMonitorConfig,
  ) {
    try {
      ConfigSchema.parse(cfg);
    } catch (err) {
      throw new DriftMonitorError('Invalid monitor configuration', err);
    }

    if (baseline.length === 0) {
      throw new DriftMonitorError('Baseline distribution must contain at least one element');
    }

    this.cfg = cfg;
    this.baseline = baseline;
    this.strategy = DriftMetricStrategyFactory.create(cfg.algorithm, cfg.strategyOptions);
  }

  /** Subscribes a drift observer. */
  public addObserver(observer: DriftObserver): void {
    this.emitter.on('drift', observer.onDrift.bind(observer));
  }

  /** Removes a previously subscribed drift observer. */
  public removeObserver(observer: DriftObserver): void {
    this.emitter.off('drift', observer.onDrift.bind(observer));
  }

  /**
   * Feeds the monitor with a new production data point.
   * When windowSize reached, compute drift & dispatch event if threshold exceeded.
   */
  public ingest(dataPoint: number, metadata?: Record<string, unknown>): void {
    if (!Number.isFinite(dataPoint)) return; // ignore NaN/∞

    this.productionWindow.push(dataPoint);

    // keep sliding window at configured size
    if (this.productionWindow.length > this.cfg.windowSize) {
      this.productionWindow.shift();
    }

    // Evaluate drift once the window is "full"
    if (this.productionWindow.length === this.cfg.windowSize) {
      const score = this.strategy.compute(this.baseline, this.productionWindow);

      const event: DriftEvent = {
        timestamp: new Date(),
        metricName: this.strategy.name,
        score,
        baselineSampleSize: this.baseline.length,
        productionSampleSize: this.productionWindow.length,
        metadata,
      };

      if (score >= this.cfg.alertThreshold) {
        this.emitter.emit('drift', event);
      }
    }
  }

  /** Instantaneous drift score; useful for dashboards polling the value. */
  public currentScore(): number | null {
    if (this.productionWindow.length < this.cfg.windowSize) return null;
    return this.strategy.compute(this.baseline, this.productionWindow);
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * 6️⃣  Example Observer Implementations  (would be in adapters in a full project)
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Simple console logger observer. In a real scenario, adapters would push to
 * Kafka, email, Slack, PagerDuty, etc.
 */
export class ConsoleDriftLogger implements DriftObserver {
  onDrift(event: DriftEvent): void {
    const { timestamp, metricName, score } = event;
    // eslint-disable-next-line no-console
    console.warn(
      `[${timestamp.toISOString()}] ⚠️  Drift detected! (${metricName} = ${score.toFixed(4)})`,
      event.metadata ?? {},
    );
  }
}

/**
 * Auto-Retraining Trigger observer skeleton.
 */
export class AutoRetrainTrigger implements DriftObserver {
  onDrift(event: DriftEvent): void | Promise<void> {
    // In the real adapter we would publish to the internal command bus:
    // this.commandBus.dispatch(new TriggerRetrainCommand(modelId, ...))
    // Here we just simulate.
    // eslint-disable-next-line no-console
    console.info(
      `ℹ️  [AutoRetrainTrigger] Dispatching retrain command due to drift (score=${event.score.toFixed(4)})`,
    );
  }
}

/**
 * -----------------------------------------------------------------------------------------------
 * 7️⃣  Convenience Builder (hexagonal port) for Module Consumers
 * ---------------------------------------------------------------------------------------------
 */

export class ModelPerformanceMonitorBuilder {
  /**
   * Declarative, safe builder for constructing monitors. Accepts partial config and
   * fills sensible defaults.
   */
  static build(
    baseline: DistributionSample,
    partialCfg: Partial<ModelPerformanceMonitorConfig> = {},
    observers: DriftObserver[] = [],
  ): ModelPerformanceMonitor {
    const cfg: ModelPerformanceMonitorConfig = {
      algorithm: partialCfg.algorithm ?? 'PSI',
      alertThreshold: partialCfg.alertThreshold ?? 0.25,
      windowSize: partialCfg.windowSize ?? 200,
      strategyOptions: partialCfg.strategyOptions,
    };

    const monitor = new ModelPerformanceMonitor(baseline, cfg);
    observers.forEach((obs) => monitor.addObserver(obs));
    return monitor;
  }
}

/***************************************************************************************************
 * End of file
 ***************************************************************************************************/
```