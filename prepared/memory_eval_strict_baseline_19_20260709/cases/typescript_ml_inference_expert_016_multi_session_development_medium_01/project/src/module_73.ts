```typescript
/***************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:        src/module_73.ts
 *  Module:      KPI Drift Monitoring (Core Domain — inside the Hexagon)
 *
 *  Responsibility
 *  --------------
 *  • Detect statistical drift on business-critical KPIs that are produced by ML inference
 *    services (e.g., conversion-rate predictions, customer-lifetime-value, churn-risk scores).
 *  • Apply Strategy Pattern to support multiple drift–detection algorithms that can be swapped
 *    without touching IO/adapters.
 *  • Leverage Observer Pattern so that dashboards, alerting adapters, or automated retraining
 *    pipelines can subscribe to drift events.
 *
 *  NOTE: This file purposefully *does not* reach outside the hexagon—no DB calls, no HTTP, no
 *        Kafka. Adapters will import the defined ports/interfaces instead.
 ***************************************************************************************************/

/////////////////////////
// Domain Type Aliases //
/////////////////////////

/** Numerical sequence representing either baseline or production KPI samples */
export type NumericSample = readonly number[];

/** A business KPI that can be monitored for drift (e.g., “clv_prediction_error”). */
export type KPIName = string;

/** UTC ISO-8601 string (kept as string to avoid forcing Date objects on adapters) */
export type ISODateTime = string;

/** Result returned by any drift-detection strategy */
export interface DriftResult {
  readonly drifted: boolean;     // Whether drift has been detected
  readonly score: number;        // Numeric score (e.g., p-value, distance)
  readonly details?: string;     // Human-readable explanation
}

/** Domain event published when drift is detected */
export interface KpiDriftEvent {
  readonly kpi: KPIName;
  readonly timestamp: ISODateTime;
  readonly strategy: string;
  readonly result: DriftResult;
}

///////////////////////////////
// Strategy Pattern: Port    //
///////////////////////////////

/**
 * Port for drift-detection algorithms.
 *
 * Implementations must be pure/stateless; they will be instantiated per evaluation
 * so that they remain side-effect-free and deterministic—key to auditability.
 */
export interface DriftDetectionStrategy {
  /**
   * Detect whether drift is present between baseline and current samples.
   * Implementations should **not** throw; instead they must return a
   * `DriftResult` with `drifted:false` and an explanatory `details`.
   */
  detect(baseline: NumericSample, current: NumericSample): DriftResult;
}

/////////////////////////////////////////////
// Concrete Strategy #1 : Simple Threshold //
/////////////////////////////////////////////

export interface ThresholdDriftConfig {
  /** Absolute delta accepted between baseline mean and current mean */
  readonly absMeanDelta?: number;
  /** Relative delta (%) allowed between baseline mean and current mean */
  readonly relMeanDeltaPct?: number;
}

export class ThresholdDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'threshold';

  constructor(private readonly cfg: Required<ThresholdDriftConfig>) {}

  detect(baseline: NumericSample, current: NumericSample): DriftResult {
    if (baseline.length === 0 || current.length === 0) {
      return {
        drifted : false,
        score   : Number.NaN,
        details : 'Either baseline or current sample is empty; drift evaluation skipped.',
      };
    }

    const mean = (xs: readonly number[]) =>
      xs.reduce((acc, v) => acc + v, 0) / xs.length;

    const baseMean = mean(baseline);
    const currMean = mean(current);

    const absDelta = Math.abs(currMean - baseMean);
    const relDeltaPct = Math.abs(absDelta / (baseMean || 1)) * 100;

    const drifted =
      absDelta > this.cfg.absMeanDelta ||
      relDeltaPct > this.cfg.relMeanDeltaPct;

    return {
      drifted,
      score  : relDeltaPct,
      details: `Mean baseline=${baseMean.toFixed(4)}, current=${currMean.toFixed(
        4,
      )}, absΔ=${absDelta.toFixed(4)}, relΔ=${relDeltaPct.toFixed(2)}%.`,
    };
  }
}

////////////////////////////////////////
// Concrete Strategy #2: KS Distance  //
////////////////////////////////////////

/**
 * Quick-and-dirty Kolmogorov-Smirnov two-sample test.
 * NOTE: For domain usage we only need distance + threshold; no p-value calc.
 */
export interface KSTestConfig {
  /** Critical distance above which drift is declared  */
  readonly criticalDistance: number;
}

export class KSTestDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'kolmogorov–smirnov';

  constructor(private readonly cfg: KSTestConfig) {}

  detect(baseline: NumericSample, current: NumericSample): DriftResult {
    if (baseline.length === 0 || current.length === 0) {
      return {
        drifted : false,
        score   : Number.NaN,
        details : 'Either baseline or current sample is empty; drift evaluation skipped.',
      };
    }

    // Clone + sort (do not mutate original arrays!)
    const b = [...baseline].sort((a, b) => a - b);
    const c = [...current].sort((a, b) => a - b);

    let i = 0;
    let j = 0;
    let cdfB = 0;
    let cdfC = 0;
    let d = 0;

    while (i < b.length && j < c.length) {
      const valueB = b[i];
      const valueC = c[j];

      if (valueB <= valueC) {
        i++;
        cdfB = i / b.length;
      } else {
        j++;
        cdfC = j / c.length;
      }
      d = Math.max(d, Math.abs(cdfB - cdfC));
    }

    // Remaining items set CDF to 1
    d = Math.max(d, Math.abs(1 - j / c.length - i / b.length));

    const drifted = d > this.cfg.criticalDistance;

    return {
      drifted,
      score  : d,
      details: `KS distance=${d.toFixed(4)}, critical=${this.cfg.criticalDistance}.`,
    };
  }
}

/////////////////////////////////////////
// Factory Pattern for Drift Strategy  //
/////////////////////////////////////////

export type DriftStrategyConfig =
  | { type: 'threshold'; params: ThresholdDriftConfig }
  | { type: 'ks'; params: KSTestConfig };

export class DriftDetectionStrategyFactory {
  /**
   * Create strategy from config, falling back to sensible defaults where missing.
   * Throws if configuration is invalid so that calling code can surface a clear,
   * non-business error (configuration/runtime error).
   */
  static create(config: DriftStrategyConfig): DriftDetectionStrategy {
    switch (config.type) {
      case 'threshold': {
        const defaults: Required<ThresholdDriftConfig> = {
          absMeanDelta   : 0.01,
          relMeanDeltaPct: 1.0,
        };

        return new ThresholdDriftStrategy({
          ...defaults,
          ...config.params,
        });
      }

      case 'ks':
        if (config.params.criticalDistance <= 0) {
          throw new Error(
            `KS criticalDistance must be > 0 (got ${config.params.criticalDistance})`,
          );
        }
        return new KSTestDriftStrategy(config.params);

      default:
        // Exhaustive type check
        const _exhaustive: never = config;
        throw new Error(`Unsupported drift strategy: ${(config as any).type}`);
    }
  }
}

////////////////////////////////////////
// Observer Pattern: Drift Listeners  //
////////////////////////////////////////

export interface KpiDriftObserver {
  onDriftDetected(event: KpiDriftEvent): void;
}

///////////////////////////////////////
// Subject: KPI Drift Monitor        //
///////////////////////////////////////

export interface KpiDriftMonitorConfig {
  readonly kpi: KPIName;
  readonly strategy: DriftStrategyConfig;
  /**
   * Minimum time (ms) that must pass between successive drift notifications.
   * Prevents alert storms at the adapter layer.
   */
  readonly debounceMs?: number;
}

export class KpiDriftMonitor {
  private readonly observers = new Set<KpiDriftObserver>();
  private lastNotificationEpoch = 0;
  private readonly strategy: DriftDetectionStrategy;
  private readonly debounceMs: number;

  constructor(private readonly cfg: KpiDriftMonitorConfig) {
    this.strategy = DriftDetectionStrategyFactory.create(cfg.strategy);
    this.debounceMs = cfg.debounceMs ?? 60_000; // default 1 minute
  }

  /* Observer management */
  addObserver(obs: KpiDriftObserver): void {
    this.observers.add(obs);
  }

  removeObserver(obs: KpiDriftObserver): void {
    this.observers.delete(obs);
  }

  clearObservers(): void {
    this.observers.clear();
  }

  /**
   * Evaluate two numerical samples for drift and notify subscribers
   * *iff* drift is detected and debounce interval has elapsed.
   */
  evaluate(baseline: NumericSample, current: NumericSample): DriftResult {
    const result = this.strategy.detect(baseline, current);

    if (result.drifted && this.shouldNotify()) {
      const event: KpiDriftEvent = {
        kpi       : this.cfg.kpi,
        timestamp : new Date().toISOString(),
        strategy  : (this.strategy as any).name ?? 'unknown',
        result,
      };

      this.notify(event);
    }

    return result;
  }

  /* INTERNALS */

  private shouldNotify(): boolean {
    const now = Date.now();
    if (now - this.lastNotificationEpoch >= this.debounceMs) {
      this.lastNotificationEpoch = now;
      return true;
    }
    return false;
  }

  private notify(event: KpiDriftEvent): void {
    for (const obs of this.observers) {
      try {
        obs.onDriftDetected(event);
      } catch (err) {
        // Core domain swallows observer errors; adapters must handle their own failures.
        // We log via console for now—hexagon avoids direct logger dependencies.
        console.error(
          `[KpiDriftMonitor] Observer threw on event for KPI "${event.kpi}":`,
          err,
        );
      }
    }
  }
}

///////////////////////////////////////
// Example Usage (to be removed in   //
// production builds, kept here for  //
// illustration/testing purposes).   //
///////////////////////////////////////

if (process.env.NODE_ENV === 'debug_drift_example') {
  // Baseline distribution (e.g., last month)
  const baseline = Array.from({ length: 500 }, () => 50 + Math.random() * 10);

  // Production distribution (e.g., this hour)
  const current = Array.from({ length: 500 }, () => 60 + Math.random() * 10);

  const monitor = new KpiDriftMonitor({
    kpi      : 'average_order_value',
    strategy : {
      type  : 'ks',
      params: { criticalDistance: 0.2 },
    },
    debounceMs: 5_000,
  });

  // Dummy observer prints to console. Real adapters would send Slack, PagerDuty, etc.
  monitor.addObserver({
    onDriftDetected(e) {
      console.info('[DRIFT-DETECTED]', JSON.stringify(e, null, 2));
    },
  });

  monitor.evaluate(baseline, current);
}
```