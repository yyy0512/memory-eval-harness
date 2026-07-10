```typescript
/***************************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * module_6.ts
 *
 * This module lives inside the hexagon and is responsible for detecting KPI drift at inference-time
 * and notifying registered adapters (e.g. Slack, PagerDuty, BI dashboards) whenever drift breaches
 * a configurable tolerance.  The module makes heavy use of ports-and-adapters so that the core
 * business rules remain technology-agnostic.
 *
 * Architectural patterns showcased:
 *   • Strategy Pattern       – interchangeable statistical drift–detection algorithms
 *   • Factory  Pattern       – build observers with a chosen strategy / alerting port at runtime
 *   • Observer  Pattern      – broadcast KPI events to interested observers without tight coupling
 *
 * NOTE: This file purposefully contains only pure-core logic, so it is safe to use in unit tests
 * without standing up Kafka, S3, etc.  Adapters live in sibling folders such as `src/adapters/`.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/* -----------------------------------------------------------
 * Domain Types
 * ---------------------------------------------------------*/

/**
 * A single KPI observation produced by an ML model during inference.
 */
export interface KPIObservation {
  readonly kpiName: string;        // e.g., 'customer_lifetime_value'
  readonly numericValue: number;   // actual KPI value (continuous)
  readonly timestamp: Date;
}

/**
 * Event wrapper around raw KPI values so we can enrich later with metadata such as
 * model version, feature hash, or inference endpoint.
 */
export interface KPIObservationEvent {
  readonly id: string;
  readonly observations: readonly KPIObservation[];
}


/* -----------------------------------------------------------
 * Observer Pattern Interfaces
 * ---------------------------------------------------------*/

/**
 * Subject (aka. Publisher) that produces KPIObservationEvent events.
 */
export interface KPIEventSource {
  subscribe(observer: KPIEventObserver): void;
  unsubscribe(observer: KPIEventObserver): void;
}

export interface KPIEventObserver {
  onNext(event: KPIObservationEvent): void;
  onError?(err: Error): void;
  onComplete?(): void;
}


/* -----------------------------------------------------------
 * Strategy Pattern: Drift Detection Algorithms
 * ---------------------------------------------------------*/

/**
 * A pure function (wrapped as a type) that receives historical and current distributions and
 * decides whether or not they have drifted beyond an acceptable epsilon.
 */
export interface DriftDetectionStrategy {
  /**
   * @param referenceDistribution historical (baseline) numbers
   * @param currentDistribution   most-recent window of numbers
   * @returns boolean             true  => drift detected
   *                              false => no drift detected
   */
  detectDrift(
    referenceDistribution: readonly number[],
    currentDistribution: readonly number[],
  ): boolean;
}

/**
 * Basic Population Stability Index (PSI) implementation.
 * PSI > 0.25 is commonly considered significant drift.
 * For brevity, PSI is bucketed into 10 equal-width bins.
 */
export class PopulationStabilityIndexStrategy implements DriftDetectionStrategy {
  private readonly bucketCount = 10;
  private readonly driftThreshold = 0.25;

  detectDrift(
    reference: readonly number[],
    current: readonly number[],
  ): boolean {
    if (reference.length === 0 || current.length === 0) {
      throw new Error('[PSI] Both reference and current distributions must be non-empty');
    }

    const [refBuckets, curBuckets] = this.bucketize(reference, current);
    const psi = refBuckets.reduce((sum, refPerc, idx) => {
      const curPerc = curBuckets[idx] || 1e-8; // avoid division by zero
      if (refPerc === 0) return sum;           // skip empty bucket per PSI spec
      return sum + (refPerc - curPerc) * Math.log(refPerc / curPerc);
    }, 0);

    return psi > this.driftThreshold;
  }

  private bucketize(
    reference: readonly number[],
    current: readonly number[],
  ): [number[], number[]] {
    const min = Math.min(...reference);
    const max = Math.max(...reference);
    const width = (max - min) / this.bucketCount;

    const initBuckets = new Array(this.bucketCount).fill(0);
    const refBuckets = reference.reduce((buckets, value) => {
      const idx = Math.min(Math.floor((value - min) / width), this.bucketCount - 1);
      buckets[idx]++;
      return buckets;
    }, [...initBuckets]);

    const curBuckets = current.reduce((buckets, value) => {
      const idx = Math.min(Math.floor((value - min) / width), this.bucketCount - 1);
      buckets[idx]++;
      return buckets;
    }, [...initBuckets]);

    // normalize to percentages
    return [
      refBuckets.map((c) => c / reference.length),
      curBuckets.map((c) => c / current.length),
    ];
  }
}

/**
 * A lightweight Jensen-Shannon Divergence implementation.
 * JSD > 0.1 triggers drift.
 */
export class JensenShannonDivergenceStrategy implements DriftDetectionStrategy {
  private readonly driftThreshold = 0.1;

  detectDrift(
    reference: readonly number[],
    current: readonly number[],
  ): boolean {
    if (!reference.length || !current.length) {
      throw new Error('[JSD] Both reference and current distributions must be non-empty');
    }

    // Use 100 histogram bins for JSD approximation
    const bins = 100;
    const min = Math.min(...reference);
    const max = Math.max(...reference.concat(current));
    const width = (max - min) / bins;

    const referenceHistogram = this.toHistogram(reference, bins, min, width);
    const currentHistogram = this.toHistogram(current, bins, min, width);

    const m = referenceHistogram.map((p, i) => 0.5 * (p + currentHistogram[i]));
    const kl = (p: number, q: number) => (p === 0 ? 0 : p * Math.log(p / q));
    const jsd =
      0.5 *
      referenceHistogram.reduce((sum, p, i) => sum + kl(p, m[i]), 0) +
      0.5 * currentHistogram.reduce((sum, p, i) => sum + kl(p, m[i]), 0);

    return jsd > this.driftThreshold;
  }

  private toHistogram(
    values: readonly number[],
    bins: number,
    min: number,
    width: number,
  ): number[] {
    const bucketed = new Array(bins).fill(0);
    values.forEach((v) => {
      const idx = Math.min(Math.floor((v - min) / width), bins - 1);
      bucketed[idx]++;
    });
    const total = values.length;
    return bucketed.map((c) => c / total);
  }
}


/* -----------------------------------------------------------
 * Ports (hexagon)
 * ---------------------------------------------------------*/

/**
 * Primary port for sending alerts outside the hexagon.
 * Concrete adapters – e.g. SlackAlertAdapter, EmailAlertAdapter, PagerDutyAlertAdapter – must
 * implement this interface.
 */
export interface AlertingPort {
  /**
   * Dispatch a drift alert to the external system.
   *
   * @param message        Human-friendly description
   * @param severity       'info' | 'warning' | 'critical'
   * @param metadata       Additional key–value pairs (e.g., modelVersion, endpointId)
   */
  sendAlert(
    message: string,
    severity: 'info' | 'warning' | 'critical',
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}


/* -----------------------------------------------------------
 * KPIDriftObserver (core domain service)
 * ---------------------------------------------------------*/

export interface DriftObserverConfig {
  /**
   * Number of events to maintain in reference window (sliding).
   * Set to `0` to disable reference accumulation (use current only).
   */
  readonly referenceWindowSize: number;

  /**
   * Number of events to accumulate before evaluating drift (current window size).
   */
  readonly currentWindowSize: number;

  /**
   * Minimum time (ms) between two consecutive alerts to avoid alert fatigue.
   */
  readonly alertThrottleMs: number;
}

/**
 * Concrete observer implementing the DriftObserver business rule:
 *  • maintain a sliding reference window  (baseline)
 *  • accumulate a current window         (most recent)
 *  • run chosen DriftDetectionStrategy   (e.g., PSI, JSD, KS-test)
 *  • notify AlertingPort if drift        (critical/severe)
 */
export class KPIDriftObserver implements KPIEventObserver {
  private readonly referenceValues: number[] = [];
  private readonly currentValues: number[] = [];
  private lastAlertTimestamp = 0;

  constructor(
    private readonly strategy: DriftDetectionStrategy,
    private readonly alertingPort: AlertingPort,
    private readonly monitoredKPI: string,
    private readonly config: DriftObserverConfig,
    private readonly logger: (msg: string, meta?: unknown) => void = () => {},
  ) {}

  /* ------------------------------------------------------- */
  /* Observer Pattern ‑–> handle events                      */
  /* ------------------------------------------------------- */
  onNext(event: KPIObservationEvent): void {
    try {
      const values = event.observations
        .filter((o) => o.kpiName === this.monitoredKPI)
        .map((o) => o.numericValue);

      if (!values.length) return; // skip unrelated events

      // slide reference window
      if (this.config.referenceWindowSize > 0) {
        this.referenceValues.push(...values);
        if (this.referenceValues.length > this.config.referenceWindowSize) {
          this.referenceValues.splice(
            0,
            this.referenceValues.length - this.config.referenceWindowSize,
          );
        }
      }

      // accumulate current window
      this.currentValues.push(...values);
      if (this.currentValues.length >= this.config.currentWindowSize) {
        this.evaluateDrift();
        this.currentValues.length = 0; // reset current window
      }
    } catch (err) {
      this.onError?.(err as Error);
    }
  }

  onError(err: Error): void {
    this.logger('[KPIDriftObserver] Error', { error: err });
  }

  onComplete(): void {
    this.logger('[KPIDriftObserver] Event stream completed');
  }

  /* ------------------------------------------------------- */
  /* Internal helpers                                        */
  /* ------------------------------------------------------- */
  private async evaluateDrift(): Promise<void> {
    // Early-exit if we have no baseline
    if (
      this.config.referenceWindowSize > 0 &&
      this.referenceValues.length < this.config.referenceWindowSize
    ) {
      this.logger(
        `[KPIDriftObserver] Waiting for full reference window of size ${this.config.referenceWindowSize}`,
      );
      return;
    }

    const reference = this.config.referenceWindowSize > 0
      ? [...this.referenceValues]
      : [...this.currentValues]; // fallback: use current as reference if disabled

    const current = [...this.currentValues];

    const drifting = this.strategy.detectDrift(reference, current);
    if (!drifting) {
      this.logger('[KPIDriftObserver] No drift detected');
      return;
    }

    // Throttle alerts
    const now = Date.now();
    if (now - this.lastAlertTimestamp < this.config.alertThrottleMs) {
      this.logger(
        `[KPIDriftObserver] Drift detected but throttled (last alert ${now - this.lastAlertTimestamp
        } ms ago)`,
      );
      return;
    }
    this.lastAlertTimestamp = now;

    // Compose and send alert
    const message = `KPI "${this.monitoredKPI}" has drifted (strategy=${this.strategy.constructor.name}).`;
    try {
      await this.alertingPort.sendAlert(message, 'critical', {
        kpi: this.monitoredKPI,
        observerId: uuidv4(),
        referenceWindowSize: this.config.referenceWindowSize,
        currentWindowSize: this.config.currentWindowSize,
        strategy: this.strategy.constructor.name,
        timestamp: new Date().toISOString(),
      });
      this.logger('[KPIDriftObserver] Drift alert dispatched', { message });
    } catch (err) {
      this.logger('[KPIDriftObserver] Failed to send alert', { error: err });
    }
  }
}


/* -----------------------------------------------------------
 * Factory Pattern – runtime wiring
 * ---------------------------------------------------------*/

/**
 * Default implementation of `KPIEventSource` using Node.js `EventEmitter`;
 * exists mainly for lightweight demos and unit tests.
 */
export class EventEmitterKPIEventSource extends EventEmitter implements KPIEventSource {
  subscribe(observer: KPIEventObserver): void {
    this.on('kpiEvent', observer.onNext.bind(observer));
    if (observer.onError) {
      this.on('error', observer.onError.bind(observer));
    }
    if (observer.onComplete) {
      this.on('end', observer.onComplete.bind(observer));
    }
  }

  unsubscribe(observer: KPIEventObserver): void {
    this.off('kpiEvent', observer.onNext.bind(observer));
    if (observer.onError) {
      this.off('error', observer.onError.bind(observer));
    }
    if (observer.onComplete) {
      this.off('end', observer.onComplete.bind(observer));
    }
  }

  publish(event: KPIObservationEvent): void {
    this.emit('kpiEvent', event);
  }

  complete(): void {
    this.emit('end');
  }
}

export interface DriftObserverFactoryOptions {
  readonly kpiName: string;
  readonly strategyType: 'psi' | 'jsd';
  readonly alertingPort: AlertingPort;
  readonly config?: Partial<DriftObserverConfig>;
  readonly logger?: (msg: string, meta?: unknown) => void;
}

/**
 * Factory that wires together strategy + observer + config, according to runtime options.
 */
export class DriftObserverFactory {
  static create(options: DriftObserverFactoryOptions): KPIDriftObserver {
    const {
      kpiName,
      strategyType,
      alertingPort,
      config = {},
      logger = () => {},
    } = options;

    const strategy: DriftDetectionStrategy =
      strategyType === 'psi'
        ? new PopulationStabilityIndexStrategy()
        : new JensenShannonDivergenceStrategy();

    const effectiveConfig: DriftObserverConfig = {
      referenceWindowSize: 5000,
      currentWindowSize: 500,
      alertThrottleMs: 5 * 60 * 1000, // 5 minutes
      ...config,
    };

    return new KPIDriftObserver(strategy, alertingPort, kpiName, effectiveConfig, logger);
  }
}


/* -----------------------------------------------------------
 * Example Usage (inside tests or a CLI demo, not executed in prod)
 * ---------------------------------------------------------*/

/* istanbul ignore next */
async function exampleDemo(): Promise<void> {
  /**
   * Dummy alert adapter (console only).
   * In real life, you'd resolve an adapter via DI container, e.g. SlackAlertAdapter.
   */
  const ConsoleAlertAdapter: AlertingPort = {
    sendAlert: async (message, severity, metadata) => {
      console.log(`[ALERT][${severity.toUpperCase()}] ${message}`, metadata);
    },
  };

  const source = new EventEmitterKPIEventSource();
  const observer = DriftObserverFactory.create({
    kpiName: 'customer_lifetime_value',
    strategyType: 'psi',
    alertingPort: ConsoleAlertAdapter,
    logger: (msg, meta) => console.debug(msg, meta),
  });

  source.subscribe(observer);

  // Seed reference window with stable data
  for (let i = 0; i < 5000; i++) {
    source.publish({
      id: uuidv4(),
      observations: [
        { kpiName: 'customer_lifetime_value', numericValue: 100 + Math.random() * 10, timestamp: new Date() },
      ],
    });
  }

  // Push drifting data
  for (let i = 0; i < 600; i++) {
    source.publish({
      id: uuidv4(),
      observations: [
        { kpiName: 'customer_lifetime_value', numericValue: 200 + Math.random() * 20, timestamp: new Date() },
      ],
    });
  }

  source.complete();
}

/* istanbul ignore next */
if (require.main === module) {
  // Run demo when executed directly: `ts-node src/module_6.ts`
  exampleDemo().catch((err) => {
    console.error('Demo failed', err);
    process.exit(1);
  });
}
```