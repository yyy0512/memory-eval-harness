```typescript
/**
 * src/module_31.ts
 *
 * ModelPerformanceMonitor — Domain-service responsible for detecting KPI drift in
 * real-time inference traffic and notifying interested observers.  This file shows
 * how InsightHexaAI applies the Strategy, Factory, and Observer patterns within a
 * strict Hexagonal architecture.
 */

import { v4 as uuid } from 'uuid'; // Runtime-safe UUID generator
import dayjs from 'dayjs';         // Lightweight date lib

/****************************************************************************************
 * Errors
 ****************************************************************************************/

/**
 * Base class for domain errors inside the core hexagon.
 */
export abstract class DomainError extends Error {
  public readonly name = this.constructor.name;

  protected constructor(message: string, public readonly cause?: unknown) {
    super(message);
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused By: ${cause.stack}`;
    }
    Object.setPrototypeOf(this, new.target.prototype); // Required for instanceof
  }
}

/**
 * Thrown if a DriftDetector implementation receives invalid input data.
 */
export class InvalidDriftInputError extends DomainError {
  constructor(message = 'Invalid input supplied to DriftDetector') {
    super(message);
  }
}

/**
 * Thrown when the drift monitoring loop encounters an unrecoverable failure.
 */
export class DriftMonitoringError extends DomainError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/****************************************************************************************
 * Domain types & value objects
 ****************************************************************************************/

/**
 * Enterprise-wide KPI taxonomy.  Extend as the business grows.
 */
export enum KpiType {
  CONVERSION_RATE = 'CONVERSION_RATE',
  CUSTOMER_LIFETIME_VALUE = 'CUSTOMER_LIFETIME_VALUE',
  CHURN_PROBABILITY = 'CHURN_PROBABILITY',
  // ...
}

/**
 * Immutable value object representing basic statistics of historical KPI values.
 */
export interface BaselineStats {
  readonly mean: number;
  readonly stdDev: number;
  readonly quantile95: number;
  readonly sampleSize: number;
}

/**
 * Domain event published when drift is detected.
 */
export interface DriftEvent {
  readonly eventId: string;
  readonly detectedAt: Date;
  readonly kpi: KpiType;
  readonly currentValue: number;
  readonly baseline: BaselineStats;
  /**
   * Statistical score returned by the detector.  Could be a p-value, Z-score, etc.
   * Unit depends on concrete DriftDetector implementation.
   */
  readonly driftScore: number;
  readonly metadata?: Record<string, unknown>;
}

/****************************************************************************************
 * Strategy Pattern – Drift detection algorithms
 ****************************************************************************************/

/**
 * Input contract for all drift detectors.  NOTE:  detectors are pure functions—
 * they must not perform side-effects (I/O, logging, etc.).
 */
export interface DriftDetector {
  /**
   * Check whether `currentValue` deviates significantly from `baseline`.
   * Returns `true` when drift is detected and fills `scoreOut` with a
   * domain-specific test statistic.
   *
   * @throws InvalidDriftInputError if baseline stats are malformed.
   */
  hasDrift(
    currentValue: number,
    baseline: BaselineStats,
    scoreOut: { value: number }
  ): boolean;
}

/**
 * Simple Z-score based threshold detector.
 *
 * Drift if |current - mean| > zThreshold * stdDev
 */
export class ZScoreDriftDetector implements DriftDetector {
  constructor(private readonly zThreshold: number = 3.0) {
    if (zThreshold <= 0) {
      throw new InvalidDriftInputError(
        'Z-score threshold must be strictly positive'
      );
    }
  }

  public hasDrift(
    currentValue: number,
    baseline: BaselineStats,
    scoreOut: { value: number }
  ): boolean {
    if (baseline.stdDev <= 0 || baseline.sampleSize <= 0) {
      throw new InvalidDriftInputError(
        'Baseline stdDev and sampleSize must be positive'
      );
    }
    const zScore = Math.abs((currentValue - baseline.mean) / baseline.stdDev);
    scoreOut.value = zScore;
    return zScore >= this.zThreshold;
  }
}

/**
 * Factory Pattern – build detector chosen by runtime configuration.
 */
export enum DriftDetectorType {
  Z_SCORE = 'Z_SCORE',
  // FUTURE: KS_TEST, PSI, WILCOXON, …
}

export class DriftDetectorFactory {
  public static create(
    type: DriftDetectorType,
    params?: Record<string, unknown>
  ): DriftDetector {
    switch (type) {
      case DriftDetectorType.Z_SCORE: {
        const thr = Number(params?.zThreshold ?? 3.0);
        return new ZScoreDriftDetector(thr);
      }
      // Add new detector types above this comment.
      default:
        throw new InvalidDriftInputError(`Unsupported detector type: ${type}`);
    }
  }
}

/****************************************************************************************
 * Observer Pattern – notification port
 ****************************************************************************************/

/**
 * Port (interface) allowing the core hexagon to notify external systems—email,
 * Slack, PagerDuty, dashboards—without knowing their implementation details.
 */
export interface DriftNotificationPort {
  /**
   * Adapter should ACK once the message is safely handed over to the external
   * system (e.g., Kafka partition, HTTP 2xx).  Never throw synchronously; return
   * a rejected promise if the adapter fails.
   */
  publish(event: DriftEvent): Promise<void>;
}

/**
 * In-memory implementation useful for testing or local development.  Adapters
 * (Kafka, SNS, WebSocket push) will live in separate files (outgoing adapters).
 */
export class InMemoryNotificationAdapter implements DriftNotificationPort {
  private readonly buffer: DriftEvent[] = [];

  public async publish(event: DriftEvent): Promise<void> {
    // Simulate I/O latency
    await new Promise((r) => setTimeout(r, 5));
    this.buffer.push(event);
  }

  public get events(): readonly DriftEvent[] {
    return this.buffer;
  }
}

/****************************************************************************************
 * Aggregate root / Domain-service — ModelPerformanceMonitor
 ****************************************************************************************/

interface MonitorConfig {
  /**
   * How many successive windows must present drift before an alert is emitted.
   * Helps to filter out transient spikes.
   */
  consecutiveDriftRequired: number;
  /**
   * Detector strategy
   */
  detector: DriftDetector;
}

export class ModelPerformanceMonitor {
  private consecutiveDriftCount = 0;

  constructor(
    private readonly kpi: KpiType,
    private readonly notificationPort: DriftNotificationPort,
    private readonly config: MonitorConfig
  ) {
    if (config.consecutiveDriftRequired <= 0) {
      throw new DriftMonitoringError(
        'consecutiveDriftRequired must be strictly positive'
      );
    }
  }

  /**
   * Main entrypoint called by upstream pipeline every time a new KPI snapshot is
   * computed (e.g., every minute).  If enough consecutive drift windows were
   * observed, the method dispatches a DriftEvent via the notification port.
   *
   * @throws DriftMonitoringError on unrecoverable failures
   */
  public async ingestSample(
    currentValue: number,
    baseline: BaselineStats,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const scoreOut = { value: NaN };
    let driftDetected: boolean;
    try {
      driftDetected = this.config.detector.hasDrift(
        currentValue,
        baseline,
        scoreOut
      );
    } catch (err) {
      // Wrap lower-layer error with domain-specific context
      throw new DriftMonitoringError('Drift detection failed', err);
    }

    if (driftDetected) {
      this.consecutiveDriftCount += 1;
    } else {
      this.consecutiveDriftCount = 0;
    }

    // Business rule: only alert when drift persists N times in a row
    if (
      driftDetected &&
      this.consecutiveDriftCount >= this.config.consecutiveDriftRequired
    ) {
      const event: DriftEvent = {
        eventId: uuid(),
        detectedAt: dayjs().toDate(),
        kpi: this.kpi,
        currentValue,
        baseline,
        driftScore: scoreOut.value,
        metadata,
      };

      try {
        await this.notificationPort.publish(event);
      } catch (err) {
        // Surface as domain error so caller can decide to retry
        throw new DriftMonitoringError('Failed to publish DriftEvent', err);
      } finally {
        // Reset counter to avoid duplicate alerts for the same sustained drift
        this.consecutiveDriftCount = 0;
      }
    }
  }
}

/****************************************************************************************
 * Example usage (to be removed / replaced by framework wiring in production)
 ****************************************************************************************/

// The following block is guarded by `if (require.main === module)` so that it
// only runs from `ts-node src/module_31.ts` and never when imported by tests.
if (require.main === module) {
  (async () => {
    const notificationAdapter = new InMemoryNotificationAdapter();

    const monitor = new ModelPerformanceMonitor(
      KpiType.CONVERSION_RATE,
      notificationAdapter,
      {
        consecutiveDriftRequired: 2,
        detector: DriftDetectorFactory.create(DriftDetectorType.Z_SCORE, {
          zThreshold: 2.5,
        }),
      }
    );

    const baseline: BaselineStats = {
      mean: 0.12,
      stdDev: 0.01,
      quantile95: 0.14,
      sampleSize: 10000,
    };

    // Fake stream of KPI values
    const samples = [0.119, 0.13, 0.15, 0.151, 0.152, 0.12];

    for (const value of samples) {
      await monitor.ingestSample(value, baseline, { source: 'demo-run' });
    }

    /* eslint-disable no-console */
    console.log('Published events:', notificationAdapter.events);
    /* eslint-enable no-console */
  })().catch((err) => {
    /* eslint-disable no-console */
    console.error('Fatal error in self-contained demo', err);
    /* eslint-enable no-console */
    process.exitCode = 1;
  });
}
```