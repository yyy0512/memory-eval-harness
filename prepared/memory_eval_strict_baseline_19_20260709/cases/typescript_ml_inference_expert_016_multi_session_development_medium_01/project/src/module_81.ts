```typescript
/***************************************************************************************************
 *  InsightHexaAI  ▸  Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:          src/module_81.ts
 *  Responsibility:Domain-level KPI-drift monitoring service (hexagon core)
 *
 *  Highlights:
 *    • Strategy Pattern          – multiple statistical drift-detection algorithms.
 *    • Factory Pattern           – select algorithm at runtime from config.
 *    • Observer Pattern          – push drift events to subscribed adapters (e.g., Slack, Grafana).
 *    • Comprehensive error-handling & rich typings for production hardening.
 *
 *  NOTE:  This file purposefully contains **no IO-code** (DBs, message queues, REST, etc.), thereby
 *         abiding to the hexagonal (ports-and-adapters) architecture that isolates business logic.
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------------------------------
 *  Type Declarations
 * ------------------------------------------------------------------------------------------------*/
export type NumericArray = readonly number[];

export interface DriftResult {
  readonly algorithm: string;
  readonly drifted: boolean;
  readonly score: number;          // e.g., D-statistic (KS) or PSI value.
  readonly threshold: number;      // threshold used for evaluation.
  readonly details?: unknown;      // algorithm-specific payload for richer UIs.
  readonly timestamp: Date;
}

export interface DriftDetectionStrategy {
  readonly name: string;
  /**
   * Determine whether a statistical drift has occurred between `baseline` and `current` samples.
   */
  detect(baseline: NumericArray, current: NumericArray): DriftResult;
}

/* -------------------------------------------------------------------------------------------------
 *  Built-in Drift-Detection Strategies
 * ------------------------------------------------------------------------------------------------*/

/**
 * Kolmogorov–Smirnov test implementation (two-sample, two-sided, empirical).
 * For practical production usage with large n (n>10k) a streaming approximation
 * would be preferable, but this implementation suffices for demonstration.
 */
export class KSTestStrategy implements DriftDetectionStrategy {
  public readonly name = 'kolmogorov-smirnov';

  public constructor(private readonly alpha: number = 0.05) {}

  public detect(baseline: NumericArray, current: NumericArray): DriftResult {
    this.guardSamples(baseline, current);

    const sortedBase = [...baseline].sort((a, b) => a - b);
    const sortedCurr = [...current].sort((a, b) => a - b);

    let dStatistic = 0;
    let i = 0,
      j = 0,
      cdfBase = 0,
      cdfCurr = 0;

    const nBase = sortedBase.length;
    const nCurr = sortedCurr.length;

    while (i < nBase && j < nCurr) {
      if (sortedBase[i] <= sortedCurr[j]) {
        i++;
        cdfBase = i / nBase;
      } else {
        j++;
        cdfCurr = j / nCurr;
      }
      const diff = Math.abs(cdfBase - cdfCurr);
      if (diff > dStatistic) dStatistic = diff;
    }

    // Kolmogorov distribution critical value approximation (two-sided)
    const threshold =
      Math.sqrt((-0.5 * Math.log(this.alpha / 2)) * ((nBase + nCurr) / (nBase * nCurr)));

    return {
      algorithm: this.name,
      drifted: dStatistic > threshold,
      score: dStatistic,
      threshold,
      timestamp: new Date(),
    };
  }

  private guardSamples(baseline: NumericArray, current: NumericArray): void {
    if (baseline.length === 0 || current.length === 0) {
      throw new Error('[KSTestStrategy] Both baseline and current samples must be non-empty.');
    }
  }
}

/**
 * Population Stability Index (PSI) implementation.
 */
export interface PSIStrategyOptions {
  readonly nBins?: number;
  readonly threshold?: number;
}

export class PSIStrategy implements DriftDetectionStrategy {
  public readonly name = 'population-stability-index';
  private readonly nBins: number;
  private readonly threshold: number;

  public constructor({
    nBins = 10,
    threshold = 0.1, // commonly accepted PSI threshold for moderate drift
  }: PSIStrategyOptions = {}) {
    this.nBins = nBins;
    this.threshold = threshold;
  }

  public detect(baseline: NumericArray, current: NumericArray): DriftResult {
    this.guardSamples(baseline, current);

    const [baseHist, currHist, binEdges] = this.buildHistograms(baseline, current, this.nBins);
    let psi = 0;

    for (let i = 0; i < this.nBins; i++) {
      const expected = baseHist[i];
      const actual = currHist[i];

      // avoid log(0); apply small value smoothing
      const eps = 1e-6;
      const contribution = (actual - expected) * Math.log((actual + eps) / (expected + eps));
      psi += contribution;
    }

    return {
      algorithm: this.name,
      drifted: psi > this.threshold,
      score: psi,
      threshold: this.threshold,
      details: { binEdges },
      timestamp: new Date(),
    };
  }

  /* --------------------------------------------------------------------------------------------- */
  /*  Helpers                                                                                      */
  /* --------------------------------------------------------------------------------------------- */
  private buildHistograms(
    baseline: NumericArray,
    current: NumericArray,
    nBins: number,
  ): [number[], number[], number[]] {
    const min = Math.min(...baseline, ...current);
    const max = Math.max(...baseline, ...current);
    const binSize = (max - min) / nBins || 1; // guard divide-by-zero

    const binEdges: number[] = [];
    for (let i = 0; i < nBins; i++) binEdges.push(min + binSize * (i + 1));

    const hist = (arr: NumericArray): number[] => {
      const counts = new Array(nBins).fill(0);
      for (const val of arr) {
        let idx = Math.floor((val - min) / binSize);
        if (idx >= nBins) idx = nBins - 1; // edge case: max value
        if (idx < 0) idx = 0; // in case of float underflow
        counts[idx] += 1;
      }
      const total = arr.length;
      return counts.map((c) => c / total);
    };

    return [hist(baseline), hist(current), binEdges];
  }

  private guardSamples(baseline: NumericArray, current: NumericArray): void {
    if (baseline.length < this.nBins || current.length < this.nBins) {
      throw new Error(
        `[PSIStrategy] Both baseline and current samples must contain at least ${this.nBins} observations.`,
      );
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 *  Strategy Factory
 * ------------------------------------------------------------------------------------------------*/
export enum DriftAlgorithm {
  KS_TEST = 'ks',
  PSI = 'psi',
}

export interface StrategyFactoryConfig {
  readonly algorithm: DriftAlgorithm;
  readonly options?: Record<string, unknown>;
}

export class DriftStrategyFactory {
  public static create(config: StrategyFactoryConfig): DriftDetectionStrategy {
    switch (config.algorithm) {
      case DriftAlgorithm.KS_TEST:
        return new KSTestStrategy(config.options?.['alpha'] as number | undefined);
      case DriftAlgorithm.PSI:
        return new PSIStrategy(config.options as PSIStrategyOptions | undefined);
      default:
        throw new Error(`[DriftStrategyFactory] Unknown algorithm: ${config.algorithm as string}`);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 *  Observer Port
 * ------------------------------------------------------------------------------------------------*/
export interface KPIDriftObserver {
  /**
   * Receive the outcome of a drift detection call, along with auxiliary context
   * such as the feature name under consideration or the model identifier.
   */
  onDriftEvaluated(result: DriftResult, context: DriftEvaluationContext): void | Promise<void>;
}

export interface DriftEvaluationContext {
  readonly feature: string;
  readonly modelVersion: string;
  readonly environment: 'production' | 'staging' | 'experiment';
}

/* -------------------------------------------------------------------------------------------------
 *  Domain Service: KPIDriftMonitor
 * ------------------------------------------------------------------------------------------------*/
export interface KPIDriftMonitorParams extends StrategyFactoryConfig {
  readonly observers?: KPIDriftObserver[];
}

export class KPIDriftMonitor {
  private readonly strategy: DriftDetectionStrategy;
  private readonly bus = new EventEmitter();

  public constructor(private readonly params: KPIDriftMonitorParams) {
    this.strategy = DriftStrategyFactory.create({
      algorithm: params.algorithm,
      options: params.options,
    });

    for (const obs of params.observers ?? []) this.subscribe(obs);
  }

  /**
   * Perform drift evaluation and notify observers.
   */
  public evaluate(
    baseline: NumericArray,
    current: NumericArray,
    ctx: DriftEvaluationContext,
  ): DriftResult {
    try {
      const result = this.strategy.detect(baseline, current);
      this.bus.emit('driftEvaluated', result, ctx);
      return result;
    } catch (err) {
      // Domain-level error wrapping
      throw new DriftEvaluationError('Drift evaluation failed', err as Error, ctx);
    }
  }

  /* --------------------------------------------------------------------------------------------- */
  /*  Observer Management                                                                          */
  /* --------------------------------------------------------------------------------------------- */

  public subscribe(observer: KPIDriftObserver): () => void {
    const listener = (result: DriftResult, ctx: DriftEvaluationContext): void => {
      // OPTION: Allow async observers
      Promise.resolve(observer.onDriftEvaluated(result, ctx)).catch((err) => {
        // Log & swallow errors to prevent single adapter failure from breaking the flow.
        console.error(
          `[KPIDriftMonitor] Observer "${observer.constructor.name}" failed: `,
          err as Error,
        );
      });
    };

    this.bus.on('driftEvaluated', listener);
    return () => this.bus.off('driftEvaluated', listener);
  }
}

/* -------------------------------------------------------------------------------------------------
 *  Domain Error Types
 * ------------------------------------------------------------------------------------------------*/
export class DriftEvaluationError extends Error {
  public readonly cause: Error;
  public readonly context: DriftEvaluationContext;

  public constructor(message: string, cause: Error, context: DriftEvaluationContext) {
    super(message);
    this.name = 'DriftEvaluationError';
    this.cause = cause;
    this.context = context;
  }
}

/* -------------------------------------------------------------------------------------------------
 *  Example (purely for illustration; do NOT import into production code paths)
 * ------------------------------------------------------------------------------------------------*/
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _exampleUsage = async () => {
  /* baseline & current would come from Feature Store adapters in real environments */
  const baseline = Array.from({ length: 500 }, () => Math.random());
  const current = Array.from({ length: 500 }, () => Math.random() + 0.1); // slight drift injected

  class ConsoleObserver implements KPIDriftObserver {
    onDriftEvaluated(result: DriftResult, ctx: DriftEvaluationContext): void {
      console.info(
        `[ConsoleObserver] Feature: ${ctx.feature}, Drifted: ${result.drifted}, Score: ${result.score.toFixed(
          4,
        )}`,
      );
    }
  }

  const monitor = new KPIDriftMonitor({
    algorithm: DriftAlgorithm.KS_TEST,
    options: { alpha: 0.05 },
    observers: [new ConsoleObserver()],
  });

  const ctx: DriftEvaluationContext = {
    feature: 'user_engagement',
    modelVersion: 'v2.3.1',
    environment: 'production',
  };

  monitor.evaluate(baseline, current, ctx);
};
```