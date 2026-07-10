```typescript
/**
 * File: src/module_15.ts
 * Project: InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * Purpose
 * -------
 * Implements a KPI-drift monitoring subsystem that lives inside the
 * “hexagon”.  The service evaluates whether a Key Performance Indicator
 * has drifted from its historical baseline and publishes a domain event
 * that outside adapters (PowerBI dashboards, Slack alerts, auto-
 * retraining pipelines, etc.) can observe.  The core uses the Strategy
 * pattern to support pluggable drift-detection techniques and the
 * Observer pattern to notify interested parties.
 *
 * This file is completely self-contained; infrastructure adapters wire
 * the service into message buses or HTTP endpoints elsewhere.
 */

import { mean, tTestTwoSample } from 'simple-statistics';
import { v4 as uuidv4 } from 'uuid';

/* ------------------------------------------------------------------- */
/* Domain Types                                                        */
/* ------------------------------------------------------------------- */

/** Enumerates supported KPI types.  Kept small for brevity. */
export enum KPIType {
  REVENUE = 'REVENUE',
  CHURN_RATE = 'CHURN_RATE',
  CUSTOMER_LIFETIME_VALUE = 'CUSTOMER_LIFETIME_VALUE',
}

/** Payload for drift-notification events. */
export interface KPIDriftEvent {
  readonly eventId: string;
  readonly kpiName: string;
  readonly kpiType: KPIType;
  readonly baselineWindow: string;
  readonly comparisonWindow: string;
  readonly baselineMean: number;
  readonly currentMean: number;
  readonly pValue?: number; // Optional—only some strategies populate it
  readonly driftDetected: boolean;
  readonly createdAt: string; // ISO timestamp
  readonly meta?: Record<string, unknown>;
}

/* ------------------------------------------------------------------- */
/* Error Types                                                         */
/* ------------------------------------------------------------------- */

/** Raised when statistical tests cannot be computed (e.g., degenerate data). */
export class DriftComputationError extends Error {
  public constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'DriftComputationError';
  }
}

/** Raised when a subscriber misbehaves. */
export class SubscriberError extends Error {
  public constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'SubscriberError';
  }
}

/* ------------------------------------------------------------------- */
/* Strategy Pattern: Drift Detection                                   */
/* ------------------------------------------------------------------- */

/**
 * Contract for drift-detection strategies.
 *
 * @remarks
 * Implementations must be side-effect free to ensure pure domain logic.
 */
export interface KPIDriftStrategy {
  /** Human-readable name, useful for logging/auditing. */
  readonly strategyName: string;

  /**
   * Checks whether the KPI has drifted.
   *
   * @param baseline - Historical values (e.g., previous 30 days).
   * @param current  - Recent values (e.g., last 24 hours).
   * @returns A tuple: [driftDetected, pValue?]
   * @throws DriftComputationError
   */
  hasDrift(
    baseline: number[],
    current: number[]
  ): readonly [boolean, number?];
}

/** -------------------------------------------------------------- */
/** Strategy #1: Two-Sample Student t-test                         */
/** -------------------------------------------------------------- */
export class TTestDriftStrategy implements KPIDriftStrategy {
  public readonly strategyName = 'two_sample_t_test';

  public constructor(private readonly alpha: number = 0.05) {}

  public hasDrift(
    baseline: number[],
    current: number[]
  ): readonly [boolean, number?] {
    if (baseline.length < 2 || current.length < 2) {
      throw new DriftComputationError(
        'Insufficient sample size for t-test: need ≥2 observations per window'
      );
    }

    try {
      const pValue = tTestTwoSample(baseline, current);
      return [pValue < this.alpha, pValue];
    } catch (err) {
      /* istanbul ignore next */
      throw new DriftComputationError('t-test failed', err as Error);
    }
  }
}

/** -------------------------------------------------------------- */
/** Strategy #2: Simple percentage change                          */
/** -------------------------------------------------------------- */
export class PercentageChangeStrategy implements KPIDriftStrategy {
  public readonly strategyName = 'percentage_change';

  public constructor(
    private readonly thresholdPct: number = 5 // e.g., ±5 %
  ) {}

  public hasDrift(
    baseline: number[],
    current: number[]
  ): readonly [boolean, number?] {
    if (baseline.length === 0 || current.length === 0) {
      throw new DriftComputationError(
        'Cannot compute mean on empty datasets'
      );
    }

    const baselineMean = mean(baseline);
    const currentMean = mean(current);

    // Avoid division by zero
    if (baselineMean === 0) {
      throw new DriftComputationError(
        'Baseline mean is zero; percentage change undefined'
      );
    }

    const pctChange = ((currentMean - baselineMean) / baselineMean) * 100;
    const driftDetected = Math.abs(pctChange) >= this.thresholdPct;

    // We overload "pValue" field with pctChange for UI convenience
    return [driftDetected, pctChange];
  }
}

/* ------------------------------------------------------------------- */
/* Observer Pattern                                                    */
/* ------------------------------------------------------------------- */

/** Contract every subscriber must implement. */
export interface KPIDriftSubscriber {
  /** Receives a published drift event. */
  update(event: KPIDriftEvent): void | Promise<void>;
}

/* ------------------------------------------------------------------- */
/* Service: KPI Drift Monitor                                          */
/* ------------------------------------------------------------------- */

export interface KPIDriftMonitorOptions {
  readonly initialStrategy?: KPIDriftStrategy;
  readonly clock?: () => Date; // Inject clock for testability
}

/**
 * Central domain service that orchestrates drift detection.
 *
 * Lifecycle:
 *   1. Ingest baseline & current arrays
 *   2. Use drift strategy to decide if drift occurred
 *   3. Publish KPIDriftEvent to all subscribers
 */
export class KPIDriftMonitor {
  private strategy: KPIDriftStrategy;
  private readonly subscribers = new Set<KPIDriftSubscriber>();
  private readonly clock: () => Date;

  public constructor(options: KPIDriftMonitorOptions = {}) {
    this.strategy =
      options.initialStrategy ?? new TTestDriftStrategy(0.05);
    this.clock = options.clock ?? (() => new Date());
  }

  /* -------------------- Strategy Handling ------------------------- */

  public setStrategy(strategy: KPIDriftStrategy): void {
    this.strategy = strategy;
  }

  public getStrategy(): KPIDriftStrategy {
    return this.strategy;
  }

  /* -------------------- Observer Handling ------------------------- */

  public registerSubscriber(sub: KPIDriftSubscriber): void {
    this.subscribers.add(sub);
  }

  public unregisterSubscriber(sub: KPIDriftSubscriber): void {
    this.subscribers.delete(sub);
  }

  /* -------------------- Evaluation Logic -------------------------- */

  /**
   * Evaluate drift for a given KPI and broadcast the result.
   *
   * @param kpiName          - Domain-friendly KPI name
   * @param kpiType          - Enum for KPI semantics
   * @param baselineValues   - Historical sample values
   * @param currentValues    - Recent sample values
   * @param baselineWindowId - Label describing the baseline window (ISO dates, etc.)
   * @param currentWindowId  - Label for the current window
   */
  public evaluateAndPublish(
    kpiName: string,
    kpiType: KPIType,
    baselineValues: number[],
    currentValues: number[],
    baselineWindowId: string,
    currentWindowId: string
  ): KPIDriftEvent {
    const [driftDetected, numericMetric] = this.strategy.hasDrift(
      baselineValues,
      currentValues
    );

    const event: KPIDriftEvent = {
      eventId: uuidv4(),
      kpiName,
      kpiType,
      baselineWindow: baselineWindowId,
      comparisonWindow: currentWindowId,
      baselineMean: mean(baselineValues),
      currentMean: mean(currentValues),
      pValue: numericMetric,
      driftDetected,
      createdAt: this.clock().toISOString(),
      meta: {
        strategy: this.strategy.strategyName,
      },
    };

    this.broadcast(event);

    return event;
  }

  /* -------------------- Private Helpers --------------------------- */

  private broadcast(event: KPIDriftEvent): void {
    for (const sub of this.subscribers) {
      try {
        /* eslint-disable @typescript-eslint/no-floating-promises --
           Subscribers may choose to handle promises internally */
        const maybePromise = sub.update(event);
        if (maybePromise instanceof Promise) {
          maybePromise.catch((err) => {
            throw new SubscriberError(
              `Async subscriber failed: ${err instanceof Error ? err.message : String(err)}`,
              err instanceof Error ? err : undefined
            );
          });
        }
        /* eslint-enable */
      } catch (err) {
        // Soft-fail: log and continue notifying other subscribers
        // Logging left to infrastructure adapter; here we rethrow for tests
        if (process.env.NODE_ENV === 'test') {
          throw err;
        }
      }
    }
  }
}

/* ------------------------------------------------------------------- */
/* Example Subscriber (for illustration/tests)                         */
/* ------------------------------------------------------------------- */

/**
 * Simple in-memory collector that test suites can assert against.
 *
 * NOTE: Real adapters (PowerBI, Kafka, etc.) live in infrastructure modules.
 */
export class InMemoryDriftCollector implements KPIDriftSubscriber {
  private readonly events: KPIDriftEvent[] = [];

  public update(event: KPIDriftEvent): void {
    this.events.push(event);
  }

  public getEvents(): readonly KPIDriftEvent[] {
    return this.events;
  }

  public clear(): void {
    this.events.length = 0;
  }
}
```