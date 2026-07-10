```typescript
/**************************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:          src/module_79.ts
 * Responsibility: Domain-level KPI Drift Monitor (Observer + Strategy + Factory patterns)
 *
 * This module lives inside the hexagon and therefore exposes only pure business interfaces.
 * Adapters such as Slack, PowerBI, or OpsGenie can subscribe to KPIDriftMonitor without leaking
 * infrastructure details back into the core.
 *************************************************************************************************/

import { v4 as uuidv4 } from 'uuid';

/**
 * GENERAL TYPES & CONSTANTS
 * ----------------------------------------------------------------------------------------------
 */

/** A canonical KPI name (e.g., "gross_revenue", "churn_rate"). */
export type KPIName = string;

/** A single data point in a KPI time series. */
export interface KPIDataPoint {
  readonly timestamp: Date;
  readonly value: number;
}

/** Severity buckets for drift. */
export type DriftSeverity = 'low' | 'medium' | 'high';

/** Fired whenever drift is detected. */
export interface KPIDriftEvent {
  readonly id: string;
  readonly kpi: KPIName;
  readonly severity: DriftSeverity;
  readonly currentValue: number;
  readonly expectedValue: number;
  readonly deviation: number; // e.g., +0.15 => 15 % higher than expected
  readonly createdAt: Date;
}

/**
 * ERROR TYPES
 * ----------------------------------------------------------------------------------------------
 */

export class DriftMonitorError extends Error {
  constructor(message: string) {
    super(`[KPIDriftMonitor] ${message}`);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * OBSERVER PORT
 * ----------------------------------------------------------------------------------------------
 */

/**
 * Pure domain interface. Secondary adapters implement this to receive events.
 */
export interface KPIDriftObserver {
  /** Called synchronously whenever drift is detected. */
  onDrift(event: KPIDriftEvent): void;
}

/**
 * DRIFT DETECTION STRATEGY (STRATEGY PATTERN)
 * ----------------------------------------------------------------------------------------------
 */

/**
 * Return shape from all drift strategies.
 */
interface DriftDetectionResult {
  isDrift: boolean;
  expectedValue: number;
  deviation: number;
  severity: DriftSeverity;
}

/**
 * Strategy contract.
 */
export interface DriftDetectionStrategy {
  /**
   * @param window Array of historic KPI values (does NOT include the newValue)
   * @param newValue Newly ingested KPI value
   */
  detect(window: number[], newValue: number): DriftDetectionResult;
}

/**
 * Percent-change based drift detection.
 * Useful for ratios and monotonic KPIs.
 */
export class PercentChangeStrategy implements DriftDetectionStrategy {
  private readonly upperThreshold: number;
  private readonly lowerThreshold: number;

  constructor({
    upperThresholdPercent = 0.05, // +5 %
    lowerThresholdPercent = -0.05 // −5 %
  }: {
    upperThresholdPercent?: number;
    lowerThresholdPercent?: number;
  } = {}) {
    this.upperThreshold = upperThresholdPercent;
    this.lowerThreshold = lowerThresholdPercent;
  }

  detect(window: number[], newValue: number): DriftDetectionResult {
    if (window.length === 0) {
      return { isDrift: false, expectedValue: newValue, deviation: 0, severity: 'low' };
    }

    const mean = window.reduce((acc, v) => acc + v, 0) / window.length;
    const deviation = (newValue - mean) / mean;

    const isDrift = deviation > this.upperThreshold || deviation < this.lowerThreshold;
    const severity: DriftSeverity =
      Math.abs(deviation) > 0.20
        ? 'high'
        : Math.abs(deviation) > 0.10
        ? 'medium'
        : 'low';

    return { isDrift, expectedValue: mean, deviation, severity };
  }
}

/**
 * Z-score based drift detection.
 * More statistically rigorous for normally-distributed KPIs.
 */
export class ZScoreStrategy implements DriftDetectionStrategy {
  private readonly zThreshold: number;

  constructor({ zThreshold = 3 }: { zThreshold?: number } = {}) {
    this.zThreshold = zThreshold;
  }

  detect(window: number[], newValue: number): DriftDetectionResult {
    if (window.length < 2) {
      // Need at least 2 points for std-dev
      return { isDrift: false, expectedValue: newValue, deviation: 0, severity: 'low' };
    }

    const mean =
      window.reduce((acc, v) => acc + v, 0) / window.length;
    const variance =
      window.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (window.length - 1);
    const std = Math.sqrt(variance);

    if (std === 0) {
      // Avoid division by zero; no variance means no drift
      return { isDrift: false, expectedValue: mean, deviation: 0, severity: 'low' };
    }

    const zScore = (newValue - mean) / std;
    const isDrift = Math.abs(zScore) >= this.zThreshold;

    const severity: DriftSeverity =
      Math.abs(zScore) >= this.zThreshold * 2
        ? 'high'
        : Math.abs(zScore) >= this.zThreshold * 1.2
        ? 'medium'
        : 'low';

    return { isDrift, expectedValue: mean, deviation: zScore, severity };
  }
}

/**
 * FACTORY (FACTORY PATTERN)
 * ----------------------------------------------------------------------------------------------
 */

export type DriftStrategyType = 'percent_change' | 'z_score';

export interface DriftDetectionStrategyConfig {
  type: DriftStrategyType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
}

export class DriftDetectionStrategyFactory {
  static create(config: DriftDetectionStrategyConfig): DriftDetectionStrategy {
    switch (config.type) {
      case 'percent_change':
        return new PercentChangeStrategy(config.params);
      case 'z_score':
        return new ZScoreStrategy(config.params);
      default:
        throw new DriftMonitorError(`Unsupported strategy type "${config.type}"`);
    }
  }
}

/**
 * KPI DRIFT MONITOR (OBSERVER PATTERN)
 * ----------------------------------------------------------------------------------------------
 */

export class KPIDriftMonitor {
  private readonly observers: Set<KPIDriftObserver> = new Set();
  private readonly slidingWindow: number[];
  private readonly windowSize: number;
  private readonly strategy: DriftDetectionStrategy;

  private lastEvent?: KPIDriftEvent;

  constructor(
    private readonly kpiName: KPIName,
    {
      windowSize = 30,
      strategyConfig = { type: 'percent_change' } as DriftDetectionStrategyConfig
    }: {
      windowSize?: number;
      strategyConfig?: DriftDetectionStrategyConfig;
    } = {}
  ) {
    if (windowSize <= 0) {
      throw new DriftMonitorError('windowSize must be > 0');
    }

    this.windowSize = windowSize;
    this.slidingWindow = [];
    this.strategy = DriftDetectionStrategyFactory.create(strategyConfig);
  }

  /** Public API ‑ ingest a new KPI value (synchronous for simplicity). */
  public ingest(value: number, timestamp: Date = new Date()): void {
    if (!Number.isFinite(value)) {
      throw new DriftMonitorError(`Invalid KPI value "${value}"`);
    }

    // Detect drift BEFORE pushing the new value into the window.
    const detection = this.strategy.detect(this.slidingWindow, value);

    if (detection.isDrift) {
      const event: KPIDriftEvent = {
        id: uuidv4(),
        kpi: this.kpiName,
        createdAt: timestamp,
        currentValue: value,
        expectedValue: detection.expectedValue,
        deviation: detection.deviation,
        severity: detection.severity
      };

      // Emit only if this is a NEW event (naive duplicate suppression)
      if (!this.isDuplicate(event)) {
        this.lastEvent = event;
        this.notifyObservers(event);
      }
    }

    // Maintain sliding window.
    this.slidingWindow.push(value);
    if (this.slidingWindow.length > this.windowSize) {
      this.slidingWindow.shift();
    }
  }

  /** Adds an observer (adapter). */
  public attach(observer: KPIDriftObserver): void {
    this.observers.add(observer);
  }

  /** Removes an observer. */
  public detach(observer: KPIDriftObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Gives read-only access to the historic window (useful for dashboards without
   * breaking encapsulation).
   */
  public getWindowSnapshot(): ReadonlyArray<number> {
    return [...this.slidingWindow];
  }

  // --------------------------------------------------------------------------- //
  // INTERNALS
  // --------------------------------------------------------------------------- //

  private notifyObservers(event: KPIDriftEvent): void {
    for (const observer of this.observers) {
      try {
        observer.onDrift(event);
      } catch (err) {
        /* Fail-fast at the boundary: core SHOULD NOT know about adapter errors.
           Adapter implementations must handle their own error isolation. */
        // eslint-disable-next-line no-console
        console.error(
          `[KPIDriftMonitor] Observer "${observer.constructor.name}" failed:`,
          err
        );
      }
    }
  }

  /**
   * Naive suppression of repeated identical events.
   * A more robust solution could use exponential backoff or time-based deduping.
   */
  private isDuplicate(event: KPIDriftEvent): boolean {
    if (!this.lastEvent) return false;
    return (
      this.lastEvent.kpi === event.kpi &&
      this.lastEvent.severity === event.severity &&
      Math.abs(this.lastEvent.deviation - event.deviation) < 1e-6
    );
  }
}

/**
 * EXAMPLE USAGE (would reside in a different file in real projects)
 * ----------------------------------------------------------------------------------------------
 *
 * const monitor = new KPIDriftMonitor('gross_revenue', {
 *   windowSize: 50,
 *   strategyConfig: { type: 'z_score', params: { zThreshold: 2.5 } }
 * });
 *
 * // Adapter implementation (e.g., Slack).
 * class SlackNotifier implements KPIDriftObserver { ... }
 *
 * monitor.attach(new SlackNotifier(...));
 *
 * // Stream in KPI values
 * revenueStream.on('data', ({ value, ts }) => monitor.ingest(value, ts));
 *
 *************************************************************************************************/
```