```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * File:        src/module_60.ts
 * Responsibility: Real-time KPI drift monitoring (core hexagon).
 *
 * The service below demonstrates how the core domain can raise
 * KPI-drift events without leaking any technology concerns
 * (e.g. Slack, PagerDuty, Grafana).  Adapters that implement
 * `DriftListener` can live in an infra layer and subscribe to the
 * events, keeping the domain free of IO.
 *
 * Architectural patterns showcased:
 *  • Strategy Pattern – pluggable drift‐detection logic.
 *  • Factory Pattern  – runtime selection of a strategy.
 *  • Observer Pattern – listeners react to domain events.
 */

/////////////////////////////
// Domain-level Value Objects
/////////////////////////////

/**
 * Immutable value object that captures a single KPI snapshot.
 */
export interface KpiSnapshot {
  readonly modelId: string;          // Unique model identifier
  readonly kpiName: string;          // e.g. "CTR", "CLTV", "ChurnRate"
  readonly value: number;            // current observed value
  readonly baseline: number;         // historical or contract baseline
  readonly timestamp: Date;          // when the snapshot was taken
  readonly metadata?: Record<string, string | number>; // arbitrary extra context
}

/**
 * Severity levels keep the domain un-opinionated with respect to alerts.
 */
export enum Severity {
  INFO = 'info',
  WARN = 'warn',
  CRITICAL = 'critical',
}

/**
 * Domain event raised when drift is detected.
 */
export interface KpiDriftEvent {
  readonly snapshot: KpiSnapshot;
  readonly strategy: string;         // name of the strategy that triggered
  readonly severity: Severity;
  readonly deviation: number;        // signed distance from baseline
  readonly percentage: number;       // % deviation from baseline
  readonly createdAt: Date;
}

//////////////////////////////////////
// Strategy Pattern – Drift Detection
//////////////////////////////////////

/**
 * Contextual information required by a strategy to decide drift.
 */
export interface DriftContext {
  readonly snapshot: KpiSnapshot;
  /**
   * Threshold represented as a ratio (e.g. 0.1 means ±10% allowed)
   * or an absolute number depending on strategy implementation.
   */
  readonly threshold: number;
}

/**
 * Strategy interface.
 */
export interface DriftDetectionStrategy {
  readonly name: string;
  /**
   * Returns KpiDriftEvent when drift is detected, otherwise `undefined`.
   */
  evaluate(ctx: DriftContext): KpiDriftEvent | undefined;
}

/**
 * Detects drift when absolute deviation exceeds an absolute threshold.
 */
class AbsoluteDeviationStrategy implements DriftDetectionStrategy {
  public readonly name = 'absoluteDeviation';

  evaluate(ctx: DriftContext): KpiDriftEvent | undefined {
    const deviation = ctx.snapshot.value - ctx.snapshot.baseline;
    if (Math.abs(deviation) > ctx.threshold) {
      return {
        snapshot: ctx.snapshot,
        strategy: this.name,
        severity: Math.abs(deviation) > ctx.threshold * 2 ? Severity.CRITICAL : Severity.WARN,
        deviation,
        percentage: deviation / ctx.snapshot.baseline,
        createdAt: new Date(),
      };
    }
    return undefined;
  }
}

/**
 * Detects drift when % deviation exceeds threshold ratio.
 */
class PercentageDeviationStrategy implements DriftDetectionStrategy {
  public readonly name = 'percentageDeviation';

  evaluate(ctx: DriftContext): KpiDriftEvent | undefined {
    const deviation = ctx.snapshot.value - ctx.snapshot.baseline;
    const pct = ctx.snapshot.baseline === 0
      ? Number.POSITIVE_INFINITY
      : deviation / ctx.snapshot.baseline;

    if (Math.abs(pct) > ctx.threshold) {
      return {
        snapshot: ctx.snapshot,
        strategy: this.name,
        severity: Math.abs(pct) > ctx.threshold * 2 ? Severity.CRITICAL : Severity.WARN,
        deviation,
        percentage: pct,
        createdAt: new Date(),
      };
    }
    return undefined;
  }
}

/**
 * Factory that selects a strategy at runtime.  New strategies can be
 * registered without modifying callers (Open/Closed Principle).
 */
export class DriftStrategyFactory {
  private static readonly registry: Record<string, DriftDetectionStrategy> = {
    absolute: new AbsoluteDeviationStrategy(),
    percentage: new PercentageDeviationStrategy(),
  };

  public static register(name: string, strategy: DriftDetectionStrategy): void {
    if (this.registry[name]) {
      throw new Error(`Drift strategy "${name}" is already registered`);
    }
    this.registry[name] = strategy;
  }

  public static get(name: string): DriftDetectionStrategy {
    const strategy = this.registry[name];
    if (!strategy) {
      throw new Error(`Unknown drift strategy "${name}"`);
    }
    return strategy;
  }
}

////////////////////////////////////
// Observer Pattern – Event Listener
////////////////////////////////////

export interface DriftListener {
  onDrift(event: KpiDriftEvent): Promise<void> | void;
}

///////////////////////////////////////////////////////
// Core Service – KPI Drift Monitor (Hexagon Boundary)
///////////////////////////////////////////////////////

export interface DriftMonitorOptions {
  /**
   * Strategy selection, defaults to 'percentage'
   */
  strategyName?: string;
  /**
   * Strategy threshold (interpreted by the strategy itself).
   * • For 'percentage' – use ratio (0.1 = ±10%)
   * • For 'absolute'   – use numeric units
   */
  threshold?: number;
  /**
   * Max # of events to keep in memory (basic circuit breaker).
   */
  maxEventBuffer?: number;
}

/**
 * Domain service that uses the selected strategy to evaluate snapshots
 * and notifies listeners when drift occurs.
 */
export class DriftMonitorService {
  private readonly listeners: Set<DriftListener> = new Set();
  private readonly strategy: DriftDetectionStrategy;
  private readonly threshold: number;
  private readonly eventBuffer: KpiDriftEvent[] = [];
  private readonly maxEventBuffer: number;

  constructor(opts?: DriftMonitorOptions) {
    const {
      strategyName = 'percentage',
      threshold = 0.1,
      maxEventBuffer = 500,
    } = opts || {};

    this.strategy = DriftStrategyFactory.get(strategyName);
    this.threshold = threshold;
    this.maxEventBuffer = maxEventBuffer;
  }

  ///////////////////////////
  // Listener registration
  ///////////////////////////
  public addListener(listener: DriftListener): void {
    this.listeners.add(listener);
  }

  public removeListener(listener: DriftListener): void {
    this.listeners.delete(listener);
  }

  public clearListeners(): void {
    this.listeners.clear();
  }

  ///////////////////////////
  // Business operation
  ///////////////////////////
  /**
   * Public API method to feed new KPI snapshot.  This method lives
   * in the core hexagon; outside data sources (Kafka, REST, etc.)
   * invoke it via a port adapter.
   */
  public ingestSnapshot(snapshot: KpiSnapshot): void {
    try {
      const event = this.strategy.evaluate({
        snapshot,
        threshold: this.threshold,
      });

      if (event) {
        this.pushEvent(event);
        this.notifyListeners(event);
      }
    } catch (err) {
      // NOTE: Domain services do NOT log; they bubble up errors for adapters.
      throw new DriftDetectionError(
        `Failed to evaluate drift for KPI "${snapshot.kpiName}"`, { cause: err }
      );
    }
  }

  /**
   * Expose recent events for read-side projections (dashboards, audits).
   */
  public getRecentEvents(): readonly KpiDriftEvent[] {
    return [...this.eventBuffer];
  }

  ///////////////////////////
  // Private helpers
  ///////////////////////////
  private pushEvent(event: KpiDriftEvent): void {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxEventBuffer) {
      this.eventBuffer.shift(); // drop oldest
    }
  }

  private notifyListeners(event: KpiDriftEvent): void {
    this.listeners.forEach((listener) => {
      try {
        // Fire-and-forget; leave responsibility for async handling to adapter.
        void listener.onDrift(event);
      } catch (err) {
        // Listeners must not take down the service—swallow & continue.
        /* eslint-disable no-console */
        console.error(`DriftListener failed: ${(err as Error).message}`, err);
        /* eslint-enable  no-console */
      }
    });
  }
}

///////////////////////////////////////
// Custom Domain-Specific Error Objects
///////////////////////////////////////

export class DriftDetectionError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'DriftDetectionError';
    this.cause = opts?.cause;
  }
}

////////////////////////////////////////////////////////
// Example Adapter (for illustration, lives outside core)
////////////////////////////////////////////////////////

/**
 * ConsoleLoggerListener demonstrates how an IO adapter could
 * subscribe to drift events without violating hexagonal boundaries.
 * In production, replace with Slack, PagerDuty, etc. adapters.
 */
export class ConsoleLoggerListener implements DriftListener {
  async onDrift(event: KpiDriftEvent): Promise<void> {
    /* eslint-disable no-console */
    console.log(
      `[KPI DRIFT] [${event.severity.toUpperCase()}] ` +
      `${event.snapshot.modelId}.${event.snapshot.kpiName} deviated by ` +
      `${(event.percentage * 100).toFixed(2)}% ` +
      `(strategy=${event.strategy}) at ${event.createdAt.toISOString()}`
    );
    /* eslint-enable  no-console */
  }
}
```