```typescript
/**
 * InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 * ================================================================
 * Module: src/module_40.ts
 *
 * Purpose:
 *  - Implements a hexagon-friendly, Observer-aware KPI drift monitor that can be
 *    swapped at runtime through Strategy & Factory patterns.
 *  - Emits strongly-typed KPI drift events that can be consumed by dashboards,
 *    alerting adapters, or even auto-retraining pipelines.
 *
 * Architectural notes:
 *  - No direct IO.  External concerns (Slack, e-mail, Grafana …) subscribe via
 *    adapters implementing `KpiObserver`.
 *  - All domain logic (thresholds, baselines, drift scoring) lives here, fully
 *    unit-testable without mocks of 3rd-party libs.
 */

///////////////////////////////////////
// Imports & Runtime Dependencies
///////////////////////////////////////

import { EventEmitter } from 'events';

///////////////////////////////////////
// Domain Types
///////////////////////////////////////

/**
 * A single, numeric KPI snapshot.
 */
export interface KpiSample {
  readonly name: string;
  readonly currentValue: number;
  readonly baselineValue: number;
  readonly capturedAt: Date;
}

/**
 * How severe is the detected KPI deviation?
 */
export enum KpiSeverity {
  INFO = 'info',
  WARNING = 'warning',
  CRITICAL = 'critical',
}

/**
 * Event emitted when a KPI is considered “drifting”.
 */
export interface KpiDriftEvent {
  readonly sample: KpiSample;
  readonly severity: KpiSeverity;
  readonly score: number; // The raw drift score computed by the strategy.
  readonly detectedAt: Date;
}

///////////////////////////////////////
// Observer Pattern Interfaces
///////////////////////////////////////

/**
 * Non-blocking consumer of KPI drift events.
 */
export interface KpiObserver {
  /**
   * Handle an incoming KPI drift event.
   *
   * Observers must do their own error handling to avoid bubbling failures back
   * to the core domain.
   */
  update(event: KpiDriftEvent): Promise<void> | void;
}

///////////////////////////////////////
// Strategy Pattern for Drift Detection
///////////////////////////////////////

/**
 * A pluggable algorithm that determines whether a KPI has drifted.
 */
export interface DriftDetectionStrategy {
  /**
   * Calculate the drift score & severity.  If `null` is returned,
   * the KPI is deemed stable (no event should be published).
   */
  evaluate(sample: KpiSample): DriftDetectionResult | null;
}

export interface DriftDetectionResult {
  readonly severity: KpiSeverity;
  readonly score: number;
}

/**
 * Simple percentage-based drift detector.  If the absolute percentage delta
 * exceeds the configured thresholds, a drift is declared.
 */
export class PercentageThresholdStrategy implements DriftDetectionStrategy {
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;

  constructor(config: { warningPct: number; criticalPct: number }) {
    this.warningThreshold = Math.abs(config.warningPct);
    this.criticalThreshold = Math.abs(config.criticalPct);

    if (this.criticalThreshold <= this.warningThreshold) {
      throw new Error(
        '[PercentageThresholdStrategy] criticalPct must be greater than warningPct',
      );
    }
  }

  evaluate(sample: KpiSample): DriftDetectionResult | null {
    const { currentValue, baselineValue } = sample;

    if (baselineValue === 0) {
      // Avoid divide-by-zero, consider as no data.
      return null;
    }

    const pctDelta = Math.abs((currentValue - baselineValue) / baselineValue) * 100;

    if (pctDelta >= this.criticalThreshold) {
      return { severity: KpiSeverity.CRITICAL, score: pctDelta };
    }

    if (pctDelta >= this.warningThreshold) {
      return { severity: KpiSeverity.WARNING, score: pctDelta };
    }

    // Stable ✨
    return null;
  }
}

/**
 * Z-Score-based drift detector.  More robust for noisy KPIs.
 *
 * For simplicity, baselineValue is interpreted as the mean, while
 * `stdDev` is injected via constructor.
 */
export class ZScoreStrategy implements DriftDetectionStrategy {
  private readonly warnZ: number;
  private readonly critZ: number;
  private readonly stdDev: number;

  constructor(config: { warnZ: number; critZ: number; stdDev: number }) {
    const { warnZ, critZ, stdDev } = config;

    if (critZ <= warnZ) {
      throw new Error('[ZScoreStrategy] critZ must be > warnZ');
    }
    if (stdDev <= 0) {
      throw new Error('[ZScoreStrategy] stdDev must be positive');
    }

    this.warnZ = warnZ;
    this.critZ = critZ;
    this.stdDev = stdDev;
  }

  evaluate(sample: KpiSample): DriftDetectionResult | null {
    const { currentValue, baselineValue } = sample;
    const zScore = Math.abs((currentValue - baselineValue) / this.stdDev);

    if (zScore >= this.critZ) {
      return { severity: KpiSeverity.CRITICAL, score: zScore };
    }
    if (zScore >= this.warnZ) {
      return { severity: KpiSeverity.WARNING, score: zScore };
    }
    return null;
  }
}

///////////////////////////////////////
// Factory Pattern for Strategy Creation
///////////////////////////////////////

export type DriftStrategyKind = 'percentage' | 'zscore';

export interface StrategyFactoryConfigMap {
  percentage: ConstructorParameters<typeof PercentageThresholdStrategy>[0];
  zscore: ConstructorParameters<typeof ZScoreStrategy>[0];
}

export class DriftDetectionStrategyFactory {
  static build<T extends DriftStrategyKind>(
    kind: T,
    cfg: StrategyFactoryConfigMap[T],
  ): DriftDetectionStrategy {
    switch (kind) {
      case 'percentage':
        return new PercentageThresholdStrategy(cfg as StrategyFactoryConfigMap['percentage']);
      case 'zscore':
        return new ZScoreStrategy(cfg as StrategyFactoryConfigMap['zscore']);
      default:
        // Exhaustive check for future devs
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _exhaustive: never = kind;
        throw new Error(`[DriftDetectionStrategyFactory] Unsupported kind: ${kind}`);
    }
  }
}

///////////////////////////////////////
// Core Subject: AdaptiveKpiMonitor
///////////////////////////////////////

/**
 * The AdaptiveKpiMonitor holds KPI baselines, applies a drift detection
 * strategy, and notifies observers if a metric diverges.
 *
 * It is purposely ignorant of IO details — all side-effects are pushed to the
 * edge via observers.
 */
export class AdaptiveKpiMonitor {
  /**
   * internal ‑ strongly typed event bus
   */
  private readonly emitter = new EventEmitter();

  /**
   * Track any registered observers to allow clean off-boarding.
   */
  private readonly observers = new Set<KpiObserver>();

  /**
   * Decoupled drift detection logic.
   */
  private strategy: DriftDetectionStrategy;

  constructor(initialStrategy: DriftDetectionStrategy) {
    this.strategy = initialStrategy;
  }

  /**
   * Swap the drift detection strategy at runtime (e.g., A/B experiments).
   * Existing observers stay subscribed.
   */
  public setStrategy(next: DriftDetectionStrategy): void {
    this.strategy = next;
  }

  /**
   * Subscribe an observer and immediately replay the last event if desired.
   */
  public attach(observer: KpiObserver, replayLast = false): void {
    this.observers.add(observer);
    this.emitter.on('kpi:drift', observer.update.bind(observer));

    if (replayLast) {
      // Fire the most recent event, if any.
      const lastEvent = this.lastEvent;
      if (lastEvent) {
        void observer.update(lastEvent);
      }
    }
  }

  public detach(observer: KpiObserver): void {
    this.observers.delete(observer);
    this.emitter.removeListener('kpi:drift', observer.update.bind(observer));
  }

  /**
   * Push a new KPI sample.  The appropriate strategy decides if drift occurred.
   * If so, observers are notified *asynchronously*.
   */
  public evaluate(sample: KpiSample): void {
    let result: DriftDetectionResult | null;
    try {
      result = this.strategy.evaluate(sample);
    } catch (err) {
      // Strategy implementations MUST NOT break the monitor.
      console.error('[AdaptiveKpiMonitor] Strategy threw an error:', err);
      return;
    }

    if (result) {
      const event: KpiDriftEvent = {
        sample,
        severity: result.severity,
        score: result.score,
        detectedAt: new Date(),
      };
      this.lastEvent = event;

      // Notify all observers — never await in order to stay responsive.
      this.emitter.emit('kpi:drift', event);
    }
  }

  ///////////////////////////////
  // INTERNALS
  ///////////////////////////////

  private lastEvent: KpiDriftEvent | null = null;
}

///////////////////////////////////////
// Example Observer Implementations
// (Adapters would live in infra layers; placed here as reference only.)
///////////////////////////////////////

/**
 * Console logger — for local development only.
 */
export class ConsoleObserver implements KpiObserver {
  async update(event: KpiDriftEvent): Promise<void> {
    const { sample, severity, score } = event;
    // eslint-disable-next-line no-console
    console.log(
      `[ConsoleObserver] [${severity.toUpperCase()}] KPI "${sample.name}" drifted by ${score.toFixed(
        2,
      )}. Current: ${sample.currentValue}, Baseline: ${sample.baselineValue}`,
    );
  }
}

/**
 * Stub for a PagerDuty adapter.  In production, this would call the PagerDuty
 * REST API.
 */
export class PagerDutyObserver implements KpiObserver {
  constructor(private readonly routingKey: string) {}

  async update(event: KpiDriftEvent): Promise<void> {
    try {
      // Placeholder network call
      await fakePagerDutyApi(this.routingKey, event);
    } catch (err) {
      // We do not propagate errors up — observers must be failure-resistant.
      console.error('[PagerDutyObserver] Failed to dispatch alert', err);
    }
  }
}

// Mocked network call for illustration purposes only.
async function fakePagerDutyApi(routingKey: string, event: KpiDriftEvent): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  // eslint-disable-next-line no-console
  console.log(`[PagerDutyObserver] (FAKE) Alert sent with key=${routingKey}`, event);
}

///////////////////////////////////////
// Guarded ESM exports (tree-shakable)
///////////////////////////////////////

export default {
  AdaptiveKpiMonitor,
  ConsoleObserver,
  PagerDutyObserver,
  PercentageThresholdStrategy,
  ZScoreStrategy,
  DriftDetectionStrategyFactory,
};
```
