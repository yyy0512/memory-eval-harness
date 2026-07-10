/**
 * Module 63: Model performance monitoring and drift detection
 * ----------------------------------------------------------
 * This module sits inside InsightHexaAI’s hexagon and is responsible for
 * continuously measuring statistical drift between a model’s current output
 * distribution and a baseline reference distribution.  When drift exceeds a
 * configurable threshold, domain events are emitted so that outer-layer
 * adapters (e.g. Slack, PagerDuty, Grafana, Airflow) can react.
 *
 * Patterns showcased
 *  – Strategy Pattern         → interchangeable drift-metric algorithms
 *  – Factory Pattern          → runtime selection of strategy
 *  – Observer Pattern         → EventEmitter-based drift notifications
 *
 * NOTE: All code lives in the “core” side of the hexagon—there are no direct
 * references to HTTP, Kafka, DBs, etc.  Those concerns belong to adapters.
 */

import { EventEmitter } from 'events';
import { cloneDeep } from 'lodash';

/* -------------------------------------------------------------------------- */
/*                                Domain types                                */
/* -------------------------------------------------------------------------- */

/** Strategy interface for statistical-drift metrics. */
export interface DriftMetricStrategy {
  readonly name: string;

  /**
   * Computes a drift score given baseline and current distributions.
   * Larger numbers → larger drift.
   */
  computeDrift(baseline: number[], current: number[]): number;
}

/** Configuration object declared by Product/Ops at runtime. */
export interface DriftDetectionConfig {
  /** Which metric to use internally. */
  metric: 'psi' | 'kl';
  /** If score ≥ threshold, a drift event is emitted. */
  threshold: number;
  /** Minimum sample size required to run the test. (Default = 50) */
  minSamples?: number;
  /** Debounce window for events in ms. (Default = 5 minutes)  */
  debounceMs?: number;
}

/** Immutable domain event consumed by outer-layer adapters. */
export interface PerformanceDriftDetectedEvent {
  modelName: string;
  metricName: string;
  driftScore: number;
  sampleSize: number;
  timestamp: Date;
}

/* -------------------------------------------------------------------------- */
/*                        Concrete drift-metric strategies                    */
/* -------------------------------------------------------------------------- */

/**
 * Population Stability Index (PSI)
 * Guideline: 0.1 – slight drift, 0.2 + – serious drift
 */
export class PopulationStabilityIndexStrategy implements DriftMetricStrategy {
  public readonly name = 'PopulationStabilityIndex';

  computeDrift(baseline: number[], current: number[]): number {
    if (!baseline.length || !current.length) {
      throw new Error('PSI: baseline and current must be non-empty.');
    }

    const bins = 10;
    const epsilon = 1e-9;

    /* ----------------------------- Bin selection ---------------------------- */
    // Use baseline deciles as cut points.
    const sortedBase = [...baseline].sort((a, b) => a - b);
    const quantiles: number[] = [];
    for (let i = 1; i < bins; i++) {
      const pos = (sortedBase.length - 1) * (i / bins);
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const q =
        sortedBase[idx] +
        frac * (sortedBase[idx + 1 < sortedBase.length ? idx + 1 : idx] - sortedBase[idx]);
      quantiles.push(q);
    }

    const toBinCounts = (data: number[]) => {
      const counts = Array(bins).fill(0);
      for (const v of data) {
        let b = quantiles.findIndex(q => v <= q);
        if (b === -1) b = bins - 1;
        counts[b] += 1;
      }
      return counts;
    };

    /* ------------------------------- PSI calc ------------------------------ */
    const baseCnt = toBinCounts(baseline);
    const currCnt = toBinCounts(current);

    const basePct = baseCnt.map(c => c / baseline.length + epsilon);
    const currPct = currCnt.map(c => c / current.length + epsilon);

    let psi = 0;
    for (let i = 0; i < bins; i++) {
      psi += (currPct[i] - basePct[i]) * Math.log(currPct[i] / basePct[i]);
    }
    return psi;
  }
}

/**
 * Kullback–Leibler Divergence (continuous histogram approximation).
 */
export class KLDivergenceStrategy implements DriftMetricStrategy {
  public readonly name = 'KLDivergence';

  computeDrift(baseline: number[], current: number[]): number {
    if (!baseline.length || !current.length) {
      throw new Error('KL: baseline and current must be non-empty.');
    }

    /* ----------------------- Build common histogram bins -------------------- */
    const all = [...baseline, ...current];
    const iqr = quantile(all, 0.75) - quantile(all, 0.25);
    const binW = 2 * iqr / Math.cbrt(all.length);
    if (binW <= 0) throw new Error('KL: non-positive bin width.');

    const min = Math.min(...all);
    const bins = Math.max(5, Math.ceil((Math.max(...all) - min) / binW));
    const toHist = (data: number[]) => {
      const counts = Array<number>(bins).fill(0);
      for (const v of data) {
        let idx = Math.floor((v - min) / binW);
        if (idx < 0) idx = 0;
        if (idx >= bins) idx = bins - 1;
        counts[idx] += 1;
      }
      return counts;
    };

    const epsilon = 1e-9;
    const p = toHist(baseline).map(c => c / baseline.length + epsilon);
    const q = toHist(current).map(c => c / current.length + epsilon);

    /* ----------------------------- KL formula ------------------------------ */
    let kl = 0;
    for (let i = 0; i < bins; i++) kl += p[i] * Math.log(p[i] / q[i]);
    return kl;
  }
}

/* -------------------------------------------------------------------------- */
/*                             Strategy factory                               */
/* -------------------------------------------------------------------------- */

export class DriftMetricStrategyFactory {
  static build(metric: DriftDetectionConfig['metric']): DriftMetricStrategy {
    switch (metric) {
      case 'psi':
        return new PopulationStabilityIndexStrategy();
      case 'kl':
        return new KLDivergenceStrategy();
      default:
        /* Exhaustive check for future compile-time safety. */
        // @ts-expect-error unreachable
        const _exhaustiveCheck: never = metric;
        throw new Error(`StrategyFactory: unsupported metric "${metric}".`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                               Event emitter                                */
/* -------------------------------------------------------------------------- */

export class DriftEventEmitter extends EventEmitter {
  public static readonly EVENT = 'performance_drift';

  emitDrift(event: PerformanceDriftDetectedEvent): boolean {
    return this.emit(DriftEventEmitter.EVENT, event);
  }

  onDrift(listener: (e: PerformanceDriftDetectedEvent) => void): this {
    return this.on(DriftEventEmitter.EVENT, listener);
  }
}

/* -------------------------------------------------------------------------- */
/*                     Core service: monitors one model                       */
/* -------------------------------------------------------------------------- */

export class ModelPerformanceMonitorService {
  private readonly config: Required<DriftDetectionConfig>;
  private readonly strategy: DriftMetricStrategy;
  private readonly emitter: DriftEventEmitter;

  /** Baseline distribution — may be reset after retraining. */
  private baseline: number[] | null = null;

  /** Debounce bookkeeping. */
  private lastEmit = 0;

  constructor(
    public readonly modelName: string,
    cfg: DriftDetectionConfig,
    emitter: DriftEventEmitter = new DriftEventEmitter()
  ) {
    this.config = {
      ...cfg,
      minSamples: cfg.minSamples ?? 50,
      debounceMs: cfg.debounceMs ?? 5 * 60_000,
    };
    this.strategy = DriftMetricStrategyFactory.build(cfg.metric);
    this.emitter = emitter;
  }

  /**
   * Streams a new sliding-window sample of model outputs/residuals.
   * If drift is detected → emits a domain event.
   */
  ingest(currentWindow: number[]): void {
    if (currentWindow.length < this.config.minSamples) return;

    /* --------------------------- Baseline bootstrap ------------------------- */
    if (!this.baseline) {
      this.baseline = cloneDeep(currentWindow);
      return;
    }

    /* ----------------------- Compute & evaluate drift ----------------------- */
    let score = 0;
    try {
      score = this.strategy.computeDrift(this.baseline, currentWindow);
    } catch (err) {
      // Core domain must never crash; delegate handling to adapters.
      console.error(`[Monitor:${this.modelName}] Drift calc failed`, err);
      return;
    }

    if (score < this.config.threshold) return;

    const now = Date.now();
    if (now - this.lastEmit < this.config.debounceMs) return; // debounce

    this.lastEmit = now;
    this.emitter.emitDrift({
      modelName: this.modelName,
      metricName: this.strategy.name,
      driftScore: score,
      sampleSize: currentWindow.length,
      timestamp: new Date(),
    });
  }

  /** Manually reset (or supply) a new baseline after model retraining. */
  resetBaseline(dist?: number[]): void {
    if (dist && dist.length < this.config.minSamples) {
      throw new Error('resetBaseline: supplied baseline is too small.');
    }
    this.baseline = dist ? cloneDeep(dist) : null;
  }

  /** Subscribe to drift events. */
  onDrift(cb: (e: PerformanceDriftDetectedEvent) => void): void {
    this.emitter.onDrift(cb);
  }
}

/* -------------------------------------------------------------------------- */
/*                          Private helper functions                          */
/* -------------------------------------------------------------------------- */

function quantile(arr: number[], q: number): number {
  if (!arr.length) throw new Error('quantile: empty array');
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

/* -------------------------------------------------------------------------- */
/*                               End of module                                */
/* -------------------------------------------------------------------------- */