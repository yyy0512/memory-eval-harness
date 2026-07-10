```typescript
/***************************************************************************************************
 * File: src/module_72.ts
 * Project: InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * Description
 * ===========
 * This module implements a domain-level KPI Drift Observation framework that sits inside the
 * hexagon. It exposes:
 *
 *  • Domain events describing KPI measurements.
 *  • An Event Bus (observable) that dispatches those events.
 *  • An Observer interface that downstream adapters (PowerBI, Slack, PagerDuty) can implement.
 *  • Pluggable drift-detection strategies (Strategy Pattern).
 *  • A factory that builds the appropriate drift detector at runtime (Factory Pattern).
 *
 * External technologies (dashboards, alerting, etc.) will consume the Observer API via adapters,
 * leaving the core domain agnostic of IO concerns.
 ***************************************************************************************************/

import { EventEmitter } from 'node:events';
import { mean, std } from 'lodash'; // lodash is a lightweight, battle-tested util lib
import { performance } from 'node:perf_hooks';

/* -------------------------------------------------------------------------------------------------
 * Domain Types
 * -----------------------------------------------------------------------------------------------*/

/**
 * Enum of KPI categories frequently tracked by InsightHexaAI. Extend as needed.
 */
export enum KpiType {
  REVENUE = 'revenue',
  CUSTOMER_LIFETIME_VALUE = 'customer_lifetime_value',
  CHURN_RISK = 'churn_risk',
  SLA_VIOLATIONS = 'sla_violations',
  CUSTOM = 'custom',
}

/**
 * Shape of an inbound KPI event.
 */
export interface KpiEvent {
  readonly type: KpiType;
  readonly value: number;
  readonly timestamp: number; // Epoch millis for deterministic ordering.
  readonly metadata?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------------------------------
 * Observer Pattern: API Interfaces
 * -----------------------------------------------------------------------------------------------*/

/**
 * Observer that reacts to KPI events (domain layer).
 * Adapters on the outside implement this interface to react (e.g., send Slack, write BI feed).
 */
export interface KpiObserver {
  /**
   * Invoked every time a new KPI event has been emitted through the event bus.
   */
  onKpiEvent(event: KpiEvent): Promise<void>;
}

/**
 * Observable Event Bus inside the hexagon.
 */
export interface KpiEventBus {
  subscribe(observer: KpiObserver): void;
  unsubscribe(observer: KpiObserver): void;
  publish(event: KpiEvent): void;
}

/* -------------------------------------------------------------------------------------------------
 * Strategy Pattern: Drift Detection
 * -----------------------------------------------------------------------------------------------*/

/**
 * Abstraction for a drift detection algorithm.
 */
export interface DriftDetectionStrategy {
  /**
   * Pushes a new KPI measurement through the algorithm.
   *
   * @returns true if drift is detected, false otherwise.
   */
  ingest(event: KpiEvent): boolean;
}

/**
 * Simple Z-score based drift detector that triggers when the KPI value deviates from
 * the moving average by N standard deviations.
 */
export class ZScoreDriftDetector implements DriftDetectionStrategy {
  private readonly window: number[];
  private readonly windowSize: number;
  private readonly thresholdZ: number;

  public constructor(windowSize = 100, thresholdZ = 3) {
    this.windowSize = windowSize;
    this.thresholdZ = thresholdZ;
    this.window = [];
  }

  public ingest(event: KpiEvent): boolean {
    if (Number.isNaN(event.value)) {
      // Ignore invalid numbers but do not throw; we don't want to kill the stream
      return false;
    }

    // Update sliding window
    if (this.window.length >= this.windowSize) {
      this.window.shift();
    }
    this.window.push(event.value);

    if (this.window.length < this.windowSize) {
      // Need more data before we can detect drift
      return false;
    }

    const μ = mean(this.window);
    const σ = std(this.window) || 1e-9; // Avoid div by zero
    const zScore = Math.abs((event.value - μ) / σ);
    return zScore >= this.thresholdZ;
  }
}

/**
 * KL Divergence (approximation via histogram) based drift detector.
 * Suitable for categorical or skewed continuous distributions.
 */
export class KLDivergenceDriftDetector implements DriftDetectionStrategy {
  private readonly history: number[];
  private readonly windowSize: number;
  private readonly bins: number;
  private readonly thresholdKL: number;

  public constructor(windowSize = 500, bins = 10, thresholdKL = 0.5) {
    this.windowSize = windowSize;
    this.bins = bins;
    this.thresholdKL = thresholdKL;
    this.history = [];
  }

  public ingest(event: KpiEvent): boolean {
    if (!Number.isFinite(event.value)) {
      return false;
    }

    // Maintain historical window
    if (this.history.length >= this.windowSize) {
      this.history.shift();
    }
    this.history.push(event.value);

    if (this.history.length < this.windowSize) {
      return false;
    }

    // Sliding windows: first 50% vs last 50%
    const half = Math.floor(this.history.length / 2);
    const baseline = this.history.slice(0, half);
    const recent = this.history.slice(half);

    const kl = this.computeKLDivergence(baseline, recent);
    return kl >= this.thresholdKL;
  }

  /**
   * Approximates KL divergence between two numeric samples via equal-width histograms.
   */
  // eslint-disable-next-line class-methods-use-this
  private computeKLDivergence(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    const minVal = Math.min(...a, ...b);
    const maxVal = Math.max(...a, ...b);
    const width = (maxVal - minVal + 1e-12) / this.bins;

    const toProb = (samples: number[]) => {
      const counts = Array<number>(this.bins).fill(0);
      samples.forEach((v) => {
        const idx = Math.min(
          this.bins - 1,
          Math.floor((v - minVal) / width),
        );
        counts[idx] += 1;
      });
      // Convert counts to probabilities with Laplace smoothing
      return counts.map((c) => (c + 1) / (samples.length + this.bins));
    };

    const p = toProb(a);
    const q = toProb(b);

    let kl = 0;
    for (let i = 0; i < this.bins; i += 1) {
      kl += p[i] * Math.log(p[i] / q[i]);
    }
    return kl;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Factory Pattern: DriftDetectorFactory
 * -----------------------------------------------------------------------------------------------*/

export enum DriftDetectorType {
  Z_SCORE = 'z_score',
  KL_DIVERGENCE = 'kl_divergence',
}

export interface DriftDetectorConfig {
  type: DriftDetectorType;
  [key: string]: unknown; // Additional factory params (windowSize, threshold, etc.)
}

export class DriftDetectorFactory {
  public static create(config: DriftDetectorConfig): DriftDetectionStrategy {
    switch (config.type) {
      case DriftDetectorType.Z_SCORE:
        return new ZScoreDriftDetector(
          (config.windowSize as number) ?? 100,
          (config.thresholdZ as number) ?? 3,
        );
      case DriftDetectorType.KL_DIVERGENCE:
        return new KLDivergenceDriftDetector(
          (config.windowSize as number) ?? 500,
          (config.bins as number) ?? 10,
          (config.thresholdKL as number) ?? 0.5,
        );
      default:
        throw new Error(`Unsupported drift detector type: ${config.type as string}`);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Implementation: DefaultKpiEventBus
 * -----------------------------------------------------------------------------------------------*/

/**
 * In-memory event bus backed by Node’s EventEmitter.
 * Note: For a production deployment you might plug in a Kafka adapter,
 * but that is outside the hexagon.
 */
export class DefaultKpiEventBus implements KpiEventBus {
  private readonly emitter = new EventEmitter({ captureRejections: true });
  private readonly channel = 'kpi_event';

  public constructor() {
    // Bubble unhandled errors rather than silently ignore them
    this.emitter.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('Unhandled error in KPI Event Bus:', err);
    });
  }

  public subscribe(observer: KpiObserver): void {
    this.emitter.on(this.channel, async (event: KpiEvent) => {
      try {
        await observer.onKpiEvent(event);
      } catch (err) {
        // Log & continue: one observer failure must not break the bus
        // eslint-disable-next-line no-console
        console.error('Observer processing failed:', err);
      }
    });
  }

  public unsubscribe(observer: KpiObserver): void {
    this.emitter.removeListener(this.channel, observer.onKpiEvent.bind(observer));
  }

  public publish(event: KpiEvent): void {
    this.emitter.emit(this.channel, event);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Service: KpiDriftMonitor
 * -----------------------------------------------------------------------------------------------*/

/**
 * Domain service that subscribes to KPI events, runs drift-detection, and publishes secondary
 * events when drift is discovered. This service lives inside the core and is itself an observer.
 */
export class KpiDriftMonitor implements KpiObserver {
  private readonly strategy: DriftDetectionStrategy;
  private readonly bus: KpiEventBus;

  private lastDriftTimestamp = 0;
  private readonly minDriftIntervalMs: number;

  public constructor(
    config: DriftDetectorConfig,
    bus: KpiEventBus,
    minDriftIntervalMs = 60_000,
  ) {
    this.strategy = DriftDetectorFactory.create(config);
    this.bus = bus;
    this.minDriftIntervalMs = minDriftIntervalMs;
    bus.subscribe(this);
  }

  /**
   * Receives KPI events, runs drift detection, and emits “drift_detected” events.
   */
  public async onKpiEvent(event: KpiEvent): Promise<void> {
    const driftDetected = this.strategy.ingest(event);

    if (!driftDetected) return;

    const now = performance.timeOrigin + performance.now();
    if (now - this.lastDriftTimestamp < this.minDriftIntervalMs) {
      // Debounce drift alerts
      return;
    }

    this.lastDriftTimestamp = now;

    const driftEvent: KpiEvent = {
      type: KpiType.CUSTOM,
      value: event.value,
      timestamp: now,
      metadata: {
        originalType: event.type,
        reason: 'statistical_drift_detected',
      },
    };

    this.bus.publish(driftEvent);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Example Usage
 * -----------------------------------------------------------------------------------------------
 * The following code will only run when this module is executed directly (not imported).
 * It demonstrates how all parts fit together in isolation from IO concerns.
 * -----------------------------------------------------------------------------------------------*/

if (require.main === module) {
  (async () => {
    const bus = new DefaultKpiEventBus();

    // -------------------------
    // Mock observer as adapter
    // -------------------------
    const consoleObserver: KpiObserver = {
      async onKpiEvent(evt) {
        // eslint-disable-next-line no-console
        console.log('ConsoleObserver received:', evt);
      },
    };

    bus.subscribe(consoleObserver);

    // -------------------------
    // Drift monitor
    // -------------------------
    const driftMonitor = new KpiDriftMonitor(
      { type: DriftDetectorType.Z_SCORE, windowSize: 20, thresholdZ: 2.5 },
      bus,
      5_000,
    );

    // Prevent unused var lint
    void driftMonitor;

    // -------------------------
    // Simulate stream
    // -------------------------
    const simulator = () => {
      const base = 100;
      const noise = Math.random() * 5;
      return base + noise;
    };

    const simulateDrift = () => 200 + Math.random() * 20;

    let counter = 0;
    setInterval(() => {
      const value = counter < 120 ? simulator() : simulateDrift();
      const evt: KpiEvent = {
        type: KpiType.REVENUE,
        value,
        timestamp: Date.now(),
      };
      bus.publish(evt);
      counter += 1;
    }, 250);
  })();
}
```
