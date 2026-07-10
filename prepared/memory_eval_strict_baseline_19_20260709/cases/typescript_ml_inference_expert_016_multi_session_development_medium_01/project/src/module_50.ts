```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_50.ts
 * Author:      InsightHexaAI Core Team
 * Description: KPI Drift Monitoring engine (Observer + Strategy + Factory pattern implementation).
 *
 *              - Receives real-time KPI measurements from the model-serving layer.
 *              - Detects statistically-significant drift using pluggable strategies.
 *              - Notifies subscribed observers (dashboards, alerting services, etc.) whenever
 *                actionable drift is detected, in strict adherence to the hexagonal architecture.
 *
 *              This module lives in the domain (“inside the hexagon”) and is therefore agnostic
 *              to any transport or infrastructure details. Adapters are expected to translate
 *              external messages (Kafka, WebSockets, REST, …) into KPIData and consume the
 *              emitted events according to their own technology constraints.
 ***************************************************************************************************/

import { EventEmitter } from 'events';

/* ------------------------------------------------------------------ *
 * Domain Types
 * ------------------------------------------------------------------ */

/**
 * Unique name of a business KPI (e.g., 'customer_lifetime_value').
 */
export type KPIName = string;

/**
 * Raw KPI measurement pushed by upstream inference services.
 */
export interface KPIData {
  readonly name: KPIName;
  readonly value: number;
  readonly timestamp: Date;
}

/**
 * Event emitted when drift is detected for a specific KPI.
 */
export interface KPIDriftEvent {
  readonly kpiName: KPIName;
  readonly previousValue: number;
  readonly currentValue: number;
  readonly percentChange: number;
  readonly timestamp: Date;
}

/* ------------------------------------------------------------------ *
 * Strategy Pattern — Drift Detection
 * ------------------------------------------------------------------ */

/**
 * Contract for all drift-detection strategies.
 * New statistical tests or revenue-based heuristics can be introduced
 * without changing the rest of the monitoring engine.
 */
export interface DriftDetectionStrategy {
  /**
   * Returns `true` if the difference between `prev` and `current` constitutes drift.
   */
  hasDrift(prev: number, current: number): boolean;
}

/**
 * Simple percentage-change based drift detector.
 * Example: tolerancePercent = 0.05 → 5 % deviation allowed.
 */
export class PercentageChangeDriftStrategy implements DriftDetectionStrategy {
  constructor(private readonly tolerancePercent: number) {
    if (tolerancePercent <= 0) {
      throw new Error('Tolerance percent must be greater than 0.');
    }
  }

  public hasDrift(prev: number, current: number): boolean {
    if (prev === 0) {
      // Avoid division by zero; treat any non-zero change as drift
      return current !== 0;
    }
    const percentChange = Math.abs((current - prev) / prev);
    return percentChange >= this.tolerancePercent;
  }
}

/**
 * Factory Pattern for strategy instantiation based on configuration.
 * Keeps constructors private to the calling context and eases IoC wiring.
 */
export class DriftStrategyFactory {
  public static createPercentageStrategy(tolerancePercent = 0.05): DriftDetectionStrategy {
    return new PercentageChangeDriftStrategy(tolerancePercent);
  }

  // Future extension: ‘createStatisticalTestStrategy’, ‘createCUSUMStrategy’, …
}

/* ------------------------------------------------------------------ *
 * Observer Pattern — Drift Notification
 * ------------------------------------------------------------------ */

/**
 * Any component interested in drift events implements this interface.
 * Examples: SlackNotifier, PagerDutyIntegration, BI_DashboardAdapter, …
 */
export interface KPIObserver {
  onDrift(event: KPIDriftEvent): Promise<void> | void;
}

/**
 * Domain-level KPI monitor. Emits ‘drift’ events whenever the configured
 * detection strategy flags a measurement.
 */
export class KPITrendMonitor extends EventEmitter {
  /**
   * Fully-qualified event names exposed by this monitor.
   */
  public static readonly EVENTS = {
    DRIFT: 'drift',
  } as const;

  private readonly lastValues: Map<KPIName, number> = new Map();

  constructor(private readonly strategy: DriftDetectionStrategy) {
    super();
  }

  /**
   * Ingests a new KPI data point and analyses it for drift.
   */
  public ingest(data: KPIData): void {
    try {
      const previousValue = this.lastValues.get(data.name);
      this.lastValues.set(data.name, data.value);

      // First data point → nothing to compare against
      if (previousValue === undefined) return;

      if (this.strategy.hasDrift(previousValue, data.value)) {
        const driftEvent: KPIDriftEvent = {
          kpiName: data.name,
          previousValue,
          currentValue: data.value,
          percentChange: this.calculatePercentChange(previousValue, data.value),
          timestamp: data.timestamp,
        };

        this.emit(KPITrendMonitor.EVENTS.DRIFT, driftEvent);
      }
    } catch (err) {
      // Log, rethrow, or forward to central error bus depending on project conventions
      /* eslint-disable no-console */
      console.error(`[KPITrendMonitor] Error while ingesting KPI '${data.name}':`, err);
      /* eslint-enable no-console */
    }
  }

  /**
   * Attaches an observer to the monitor.
   */
  public registerObserver(observer: KPIObserver): void {
    this.on(KPITrendMonitor.EVENTS.DRIFT, (event: KPIDriftEvent) => observer.onDrift(event));
  }

  /**
   * Detaches an observer from the monitor.
   */
  public unregisterObserver(observer: KPIObserver): void {
    this.removeListener(
      KPITrendMonitor.EVENTS.DRIFT,
      (event: KPIDriftEvent) => observer.onDrift(event) // NB: Must reference the same function instance
    );
  }

  /* ------------------------------------------------------------------ *
   * Internal Helpers
   * ------------------------------------------------------------------ */

  private calculatePercentChange(prev: number, current: number): number {
    if (prev === 0) return current === 0 ? 0 : 1;
    return (current - prev) / Math.abs(prev);
  }
}

/* ------------------------------------------------------------------ *
 * Example Usage (to be removed in production but helpful for e2e tests)
 * ------------------------------------------------------------------ */

if (process.env.NODE_ENV === 'test' || process.env.DEBUG_KPI_MONITOR === 'true') {
  // Create monitor with 10 % drift tolerance
  const monitor = new KPITrendMonitor(DriftStrategyFactory.createPercentageStrategy(0.1));

  // Register a quick console observer
  monitor.registerObserver({
    onDrift: (event) => {
      /* eslint-disable no-console */
      console.log(`[DRIFT DETECTED] ${event.kpiName}: ${event.previousValue} → ${event.currentValue} (${(event.percentChange * 100).toFixed(2)} %)`);
      /* eslint-enable no-console */
    },
  });

  // Simulate data feed
  monitor.ingest({ name: 'average_order_value', value: 100, timestamp: new Date() });
  monitor.ingest({ name: 'average_order_value', value: 112, timestamp: new Date() }); // 12 % ↑ → drift
}
```
