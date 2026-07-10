```typescript
/**************************************************************************************************
 * InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_16.ts
 * Author:      InsightHexaAI Core Team
 * Description: Core Model-Monitoring service sitting inside the “hexagon”.  Implements an
 *              Observer-Pattern–driven event dispatcher that tracks online / offline model
 *              performance metrics, detects data-drift or performance degradation via
 *              pluggable strategies, and notifies downstream adapters (dashboards, alerting
 *              systems, ticketing queues, etc.).
 *
 * Architectural Role
 * ------------------
 * • Domain Layer (Hexagon) – no infrastructure concerns leak in here.  
 * • Strategy Pattern       – drift-detection logic is runtime-swappable.  
 * • Observer Pattern       – subscribers are decoupled from notification source.
 **************************************************************************************************/

/* eslint-disable max-classes-per-file */

import { EventEmitter } from 'events';

/* =================================================================================================
 * Domain Types
 * ================================================================================================= */

export type MetricName =
  | 'accuracy'
  | 'precision'
  | 'recall'
  | 'f1'
  | 'latency_ms'
  | 'throughput_rps'
  | 'input_drift_psi'
  | 'label_drift_psi';

export interface MetricSnapshot {
  readonly name: MetricName;
  readonly value: number;
  readonly capturedAt: Date;
}

export interface ModelPerformanceEvent {
  readonly modelId: string;
  readonly metric: MetricSnapshot;
  readonly severity: 'INFO' | 'WARN' | 'CRITICAL';
  readonly message: string;
  readonly triggeredAt: Date;
}

/* =================================================================================================
 * Strategy Pattern – Drift / Degradation Detectors
 * ================================================================================================= */

/**
 * Strategy interface for deciding whether a metric deviation is significant enough
 * to fire an alert.
 */
export interface PerformanceDetectorStrategy {
  /**
   * @returns undefined if no alert should be raised, or the ModelPerformanceEvent to publish.
   */
  evaluate(
    modelId: string,
    metric: MetricSnapshot,
    baseline: MetricSnapshot | null
  ): ModelPerformanceEvent | undefined;
}

/* ---------- Concrete Strategies --------------------------------------------------------------- */

/**
 * Simple threshold-based degradation detector (for demonstration / default).
 * Triggers:
 *   • WARN  when metric.value crosses warnThreshold
 *   • CRITICAL when metric.value crosses critThreshold
 */
export class ThresholdPerformanceDetector implements PerformanceDetectorStrategy {
  private readonly warnThreshold: number;
  private readonly critThreshold: number;
  private readonly direction: 'ABOVE' | 'BELOW'; // e.g. ABOVE threshold for latency, BELOW for accuracy

  constructor(params: { warnThreshold: number; critThreshold: number; direction: 'ABOVE' | 'BELOW' }) {
    if (params.warnThreshold === params.critThreshold) {
      throw new Error('warnThreshold and critThreshold cannot be equal');
    }
    this.warnThreshold = params.warnThreshold;
    this.critThreshold = params.critThreshold;
    this.direction = params.direction;
  }

  public evaluate(
    modelId: string,
    metric: MetricSnapshot,
    baseline: MetricSnapshot | null
  ): ModelPerformanceEvent | undefined {
    const { value } = metric;
    const compare = this.direction === 'ABOVE' ? (a: number, b: number) => a > b : (a, b) => a < b;

    if (compare(value, this.critThreshold)) {
      return this.buildEvent(modelId, metric, 'CRITICAL');
    }

    if (compare(value, this.warnThreshold)) {
      return this.buildEvent(modelId, metric, 'WARN');
    }

    // No significant deviation
    return undefined;
  }

  private buildEvent(
    modelId: string,
    metric: MetricSnapshot,
    severity: ModelPerformanceEvent['severity']
  ): ModelPerformanceEvent {
    return {
      modelId,
      metric,
      severity,
      message: `Metric ${metric.name} is ${severity}: value=${metric.value}`,
      triggeredAt: new Date(),
    };
  }
}

/**
 * Population Stability Index (PSI) drift detector.
 * Fires when PSI exceeds threshold compared to a baseline distribution.
 */
export class PsiDataDriftDetector implements PerformanceDetectorStrategy {
  private readonly psiThreshold: number;

  constructor(psiThreshold = 0.2) {
    this.psiThreshold = psiThreshold;
  }

  public evaluate(
    modelId: string,
    metric: MetricSnapshot,
    baseline: MetricSnapshot | null
  ): ModelPerformanceEvent | undefined {
    if (metric.name !== 'input_drift_psi' && metric.name !== 'label_drift_psi') {
      return undefined; // Not a PSI metric; ignore
    }

    if (metric.value >= this.psiThreshold) {
      const severity: ModelPerformanceEvent['severity'] =
        metric.value >= this.psiThreshold * 2 ? 'CRITICAL' : 'WARN';

      return {
        modelId,
        metric,
        severity,
        message: `PSI drift detected for ${metric.name}: value=${metric.value.toFixed(3)}`,
        triggeredAt: new Date(),
      };
    }

    return undefined;
  }
}

/* =================================================================================================
 * Factory Pattern – Detector Factory
 * ================================================================================================= */

export class DetectorFactory {
  /**
   * Build detector strategies based on enterprise config
   */
  public static build(config: DetectorFactoryConfig): PerformanceDetectorStrategy[] {
    const detectors: PerformanceDetectorStrategy[] = [];

    if (config.thresholdRules) {
      config.thresholdRules.forEach((rule) => {
        detectors.push(
          new ThresholdPerformanceDetector({
            warnThreshold: rule.warn,
            critThreshold: rule.crit,
            direction: rule.direction,
          })
        );
      });
    }

    if (config.enablePsiDrift) {
      detectors.push(new PsiDataDriftDetector(config.psiThreshold));
    }

    if (detectors.length === 0) {
      throw new Error('No detectors configured; monitoring would be a no-op');
    }
    return detectors;
  }
}

export interface DetectorFactoryConfig {
  thresholdRules?: Array<{
    warn: number;
    crit: number;
    direction: 'ABOVE' | 'BELOW';
  }>;
  enablePsiDrift?: boolean;
  psiThreshold?: number;
}

/* =================================================================================================
 * Observer Pattern – Notification Bus
 * ================================================================================================= */

export interface PerformanceSubscriber {
  /**
   * Handle performance events emitted by monitor.
   * IMPORTANT: Must be non-blocking and exception-safe – the monitor wraps & logs errors,
   *            but subscribers should still handle failures gracefully.
   */
  update(event: ModelPerformanceEvent): Promise<void> | void;
}

/**
 * Simple EventEmitter-backed bus.  In real production we might swap this for a message-bus
 * adapter (Kafka, SNS, etc.) via an outer adapter.
 */
class PerformanceEventBus extends EventEmitter {
  public publish(event: ModelPerformanceEvent): void {
    this.emit('performance_event', event);
  }

  public subscribe(handler: PerformanceSubscriber): void {
    this.on('performance_event', (event: ModelPerformanceEvent) => {
      try {
        // Ensure async errors are not swallowed by EventEmitter
        Promise.resolve(handler.update(event)).catch((err) =>
          console.error('[PerformanceEventBus] Subscriber raised error', err)
        );
      } catch (err) {
        console.error('[PerformanceEventBus] Subscriber threw error', err);
      }
    });
  }
}

/* =================================================================================================
 * Core Service – ModelMonitorService
 * ================================================================================================= */

export interface MonitorOptions {
  modelId: string;
  detectorConfig: DetectorFactoryConfig;
}

export class ModelMonitorService {
  private readonly modelId: string;
  private readonly detectors: PerformanceDetectorStrategy[];
  private readonly bus: PerformanceEventBus;
  private baselineStore: Map<MetricName, MetricSnapshot>; // Could be replaced by FeatureStore adapter

  constructor(options: MonitorOptions, bus: PerformanceEventBus = new PerformanceEventBus()) {
    this.modelId = options.modelId;
    this.detectors = DetectorFactory.build(options.detectorConfig);
    this.bus = bus;
    this.baselineStore = new Map();

    console.info(
      `[ModelMonitorService] Initialized for model=${options.modelId} with ${this.detectors.length} detector(s)`
    );
  }

  /**
   * Allows external callers (e.g., training pipeline) to set a golden baseline snapshot,
   * usually derived from validation set metrics at deploy time.
   */
  public setBaseline(metric: MetricSnapshot): void {
    this.baselineStore.set(metric.name, metric);
  }

  /**
   * Main entry point – called by real-time model serving adapter to track metrics.
   */
  public ingest(metric: MetricSnapshot): void {
    try {
      for (const detector of this.detectors) {
        const baseline = this.baselineStore.get(metric.name) || null;
        const maybeEvent = detector.evaluate(this.modelId, metric, baseline);
        if (maybeEvent) {
          this.bus.publish(maybeEvent);
        }
      }
    } catch (err) {
      // Defensive catch to prevent ingestion pipeline from crashing
      console.error('[ModelMonitorService] Failed to process metric', metric, err);
    }
  }

  /* ------------------------------------------------------------------------------
   * Observer helpers
   * ------------------------------------------------------------------------------ */

  public registerSubscriber(subscriber: PerformanceSubscriber): void {
    this.bus.subscribe(subscriber);
  }
}

/* =================================================================================================
 * Example Subscribers (live inside hexagon; adapters implemented elsewhere)
 * ================================================================================================= */

export class ConsoleLoggingSubscriber implements PerformanceSubscriber {
  public update(event: ModelPerformanceEvent): void {
    const { modelId, metric, severity, message } = event;
    // In production, delegate to structured logger
    // eslint-disable-next-line no-console
    console.log(
      `[ConsoleLoggingSubscriber] model=${modelId} metric=${metric.name} severity=${severity}: ${message}`
    );
  }
}

export class FailingSubscriber implements PerformanceSubscriber {
  // Demonstrates that one bad subscriber must not kill the bus.
  public update(): void {
    throw new Error('Intentional failure for testing');
  }
}

/* =================================================================================================
 * Unit-test-friendly factory (not a real DI container)
 * ================================================================================================= */

export function createDefaultMonitor(modelId: string): ModelMonitorService {
  const monitor = new ModelMonitorService({
    modelId,
    detectorConfig: {
      enablePsiDrift: true,
      psiThreshold: 0.2,
      thresholdRules: [
        { warn: 0.9, crit: 0.8, direction: 'BELOW' }, // e.g. accuracy drop
        { warn: 1000, crit: 3000, direction: 'ABOVE' }, // latency in ms
      ],
    },
  });

  monitor.registerSubscriber(new ConsoleLoggingSubscriber());
  // Register intentionally failing subscriber to prove error isolation
  monitor.registerSubscriber(new FailingSubscriber());

  return monitor;
}

/* =================================================================================================
 * Example Usage – (This would normally live in tests or an outer adapter, but provided for clarity)
 * ================================================================================================= */

if (process.env['NODE_ENV'] !== 'production') {
  const monitor = createDefaultMonitor('model-123');

  // Simulate real-time metrics incoming
  monitor.ingest({
    name: 'accuracy',
    value: 0.85,
    capturedAt: new Date(),
  });

  monitor.ingest({
    name: 'latency_ms',
    value: 3500,
    capturedAt: new Date(),
  });

  monitor.ingest({
    name: 'input_drift_psi',
    value: 0.45,
    capturedAt: new Date(),
  });
}
```