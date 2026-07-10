```typescript
/**************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  FILE:        src/module_75.ts
 *  DESCRIPTION: Domain-layer service that monitors KPI streams for statistically–significant
 *               drift and notifies downstream observers (dashboards, alerting systems, etc.). The
 *               implementation follows the Observer and Strategy patterns while staying agnostic
 *               to concrete I/O adapters (hexagonal architecture).
 *
 *  NOTE:        This is a core (inside-the-hexagon) module. External messaging systems, databases,
 *               or dashboards will interact through ports/adapters elsewhere in the project.
 **************************************************************************************************/

import { Observable, Subject, Subscription } from 'rxjs';
import { bufferTime, filter, map } from 'rxjs/operators';

// ================================================================================================
// Domain Models & Types
// ================================================================================================

/**
 * Generic representation of a KPI measurement emitted by models or services.
 */
export interface KPIEvent {
  /** Unique KPI identifier (e.g., 'customer_lifetime_value'). */
  readonly kpiName: string;

  /** ISO timestamp of the measurement. */
  readonly timestamp: string;

  /** Numeric KPI value. */
  readonly value: number;
}

/**
 * Raised by DriftDetectionStrategy once drift is detected. Downstream adapters can
 * decide whether to page on-call, send Slack notifications, or store audit logs.
 */
export interface KPIDriftEvent {
  readonly kpiName: string;
  readonly baselineMean: number;
  readonly currentMean: number;
  readonly pValue: number;
  /** When true, the drift has surpassed the acceptable threshold. */
  readonly isCritical: boolean;
  readonly occurredAt: string;
}

// ================================================================================================
// Observer Pattern (Subject ⇄ Observer)
// ================================================================================================

/**
 * Observer that consumes a drift event. External adapters implement this interface
 * to forward events to PowerBI, PagerDuty, etc.
 */
export interface DriftObserver {
  onDrift(event: KPIDriftEvent): Promise<void>;
}

/**
 * Internal domain event bus for drift notifications.
 * This Subject stays entirely in-memory; adapters can proxy it to Kafka, SNS, etc.
 */
class DriftEventBus {
  private readonly subject = new Subject<KPIDriftEvent>();

  public emit(event: KPIDriftEvent): void {
    this.subject.next(event);
  }

  public asObservable(): Observable<KPIDriftEvent> {
    return this.subject.asObservable();
  }
}

// ================================================================================================
// Strategy Pattern: Drift Detection
// ================================================================================================

/**
 * Context-independent strategy interface for statistical drift detection.
 * Concrete strategies might implement KS-test, Chi-square, or ML-based approaches.
 */
export interface DriftDetectionStrategy {
  /**
   * @param baseline Window of historical baseline values.
   * @param production Window of recent production values.
   * @returns null if no drift, otherwise full KPIDriftEvent.
   */
  detectDrift(
    kpiName: string,
    baseline: ReadonlyArray<number>,
    production: ReadonlyArray<number>
  ): KPIDriftEvent | null;
}

/**
 * Default strategy: two-sample t-test for mean shift (Welch’s t-test approximation).
 * Sufficient for normally-distributed KPIs; can be swapped without touching callers.
 */
export class WelchTTestDriftStrategy implements DriftDetectionStrategy {
  constructor(
    private readonly criticalPValue = 0.01,
    private readonly criticalRelativeShift = 0.10
  ) {}

  public detectDrift(
    kpiName: string,
    baseline: ReadonlyArray<number>,
    production: ReadonlyArray<number>
  ): KPIDriftEvent | null {
    if (baseline.length < 2 || production.length < 2) {
      // Not enough data to perform statistical test
      return null;
    }

    const mean = (arr: ReadonlyArray<number>) =>
      arr.reduce((sum, v) => sum + v, 0) / arr.length;
    const variance = (arr: ReadonlyArray<number>, meanVal: number) =>
      arr.reduce((sum, v) => sum + (v - meanVal) ** 2, 0) / (arr.length - 1);

    const meanBaseline = mean(baseline);
    const meanProd = mean(production);
    const varBaseline = variance(baseline, meanBaseline);
    const varProd = variance(production, meanProd);

    // Welch–Satterthwaite equation
    const numerator = meanBaseline - meanProd;
    const denom = Math.sqrt(varBaseline / baseline.length + varProd / production.length);

    if (denom === 0) {
      return null;
    }

    const tStat = numerator / denom;

    // Degrees of freedom (approx.)
    const dfNumerator =
      (varBaseline / baseline.length + varProd / production.length) ** 2;
    const dfDenominator =
      (varBaseline ** 2) / ((baseline.length ** 2) * (baseline.length - 1)) +
      (varProd ** 2) / ((production.length ** 2) * (production.length - 1));
    const df = dfNumerator / dfDenominator;

    // Two-tailed p-value using Student’s t CDF approximation
    const pValue = 2 * (1 - studentTCdf(Math.abs(tStat), df));

    const relativeShift = Math.abs(meanProd - meanBaseline) / meanBaseline;

    if (pValue <= this.criticalPValue && relativeShift >= this.criticalRelativeShift) {
      return {
        kpiName,
        baselineMean: meanBaseline,
        currentMean: meanProd,
        pValue,
        isCritical: true,
        occurredAt: new Date().toISOString(),
      };
    }

    return null;
  }
}

/**
 * Student’s t cumulative distribution function (CDF) approximation.
 * Source: Abramowitz and Stegun formula 26.7.5 (series expansion).
 * For production use, replace with a numerical library (e.g., jstat) for accuracy.
 */
function studentTCdf(t: number, df: number): number {
  const x = df / (df + t ** 2);
  const a = 0.5 * betaInc(x, df / 2, 0.5);
  return t > 0 ? 1 - a : a;
}

/**
 * Incomplete beta function B(x; a, b). Uses continued fraction approximation.
 * For brevity and independence from heavy math libs; good enough for α≈0.01.
 */
function betaInc(x: number, a: number, b: number, iterations = 100): number {
  let sum = 0;
  for (let n = 0; n < iterations; n++) {
    const coef = (factorial(a + b + n - 1) /
      (factorial(n) * factorial(a - 1) * factorial(b))) *
      x ** (a + n - 1) *
      (1 - x) ** b;
    sum += coef;
  }
  return sum;
}

function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

// ================================================================================================
// Service: KPI Drift Monitor
// ================================================================================================

export interface KpiDriftMonitorConfig {
  /** Size of the rolling baseline window in minutes. */
  baselineWindowMinutes: number;
  /** Size of the rolling production window in minutes. */
  prodWindowMinutes: number;
  /** Poll frequency in ms for running drift checks. */
  evaluationIntervalMs: number;
}

/**
 * Core domain service that consumes KPIEvent streams, computes drift, and notifies observers.
 * Adapters hook into public methods but cannot alter business logic.
 */
export class KpiDriftMonitorService {
  private readonly driftBus = new DriftEventBus();
  private readonly kpiEventBuffer$: Subject<KPIEvent> = new Subject();
  private readonly subscriptions: Subscription[] = [];
  private readonly measurementCache: Map<
    string,
    Array<{ ts: number; value: number }>
  > = new Map();

  constructor(
    private readonly strategy: DriftDetectionStrategy = new WelchTTestDriftStrategy(),
    private readonly cfg: KpiDriftMonitorConfig = {
      baselineWindowMinutes: 60 * 24, // 24h
      prodWindowMinutes: 60, // 1h
      evaluationIntervalMs: 60_000, // 1 min
    }
  ) {
    this.setupPipelines();
  }

  /**
   * Receives incoming KPI events from outside the hexagon (e.g., Kafka adapter).
   * @throws Error if event is malformed.
   */
  public ingest(event: KPIEvent): void {
    try {
      validateKpiEvent(event);
      this.kpiEventBuffer$.next(event);
    } catch (error) {
      // Domain-level validation error; bubble up for logging/metrics.
      throw error;
    }
  }

  /**
   * Allow concrete observers to subscribe for drift alerts.
   */
  public registerObserver(observer: DriftObserver): Subscription {
    return this.driftBus.asObservable().subscribe({
      next: (evt) => observer.onDrift(evt).catch(console.error),
      error: console.error,
    });
  }

  /**
   * Dispose all subscriptions gracefully (e.g., on SIGTERM).
   */
  public dispose(): void {
    this.subscriptions.forEach((s) => s.unsubscribe());
    this.kpiEventBuffer$.complete();
  }

  // ---------------------------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------------------------

  private setupPipelines(): void {
    // Ingest pipeline: buffer raw KPI events by minute for later aggregation.
    const ingestSub = this.kpiEventBuffer$
      .pipe(
        map((evt) => {
          const timestampMs = Date.parse(evt.timestamp);
          return { ...evt, tsMs: timestampMs };
        })
      )
      .subscribe((evt) => {
        const series = this.measurementCache.get(evt.kpiName) ?? [];
        series.push({ ts: evt.tsMs, value: evt.value });

        // Remove stale data outside baseline window
        const cutoff =
          Date.now() - this.cfg.baselineWindowMinutes * 60 * 1_000;
        while (series.length && series[0].ts < cutoff) {
          series.shift();
        }

        this.measurementCache.set(evt.kpiName, series);
      });

    // Evaluation pipeline: periodic drift detection per KPI
    const evaluationTimer = setInterval(() => {
      for (const [kpiName, series] of this.measurementCache.entries()) {
        const now = Date.now();
        const baselineCutoff =
          now - this.cfg.baselineWindowMinutes * 60 * 1_000;
        const productionCutoff =
          now - this.cfg.prodWindowMinutes * 60 * 1_000;

        const baseline = series
          .filter((d) => d.ts >= baselineCutoff && d.ts < productionCutoff)
          .map((d) => d.value);

        const production = series
          .filter((d) => d.ts >= productionCutoff)
          .map((d) => d.value);

        const driftEvent = this.strategy.detectDrift(
          kpiName,
          baseline,
          production
        );
        if (driftEvent) {
          this.driftBus.emit(driftEvent);
        }
      }
    }, this.cfg.evaluationIntervalMs);

    // Ensure Node doesn't keep process alive solely for the timer.
    evaluationTimer.unref();

    this.subscriptions.push(ingestSub);
  }
}

// ================================================================================================
// Validation Utilities
// ================================================================================================

function validateKpiEvent(event: KPIEvent): void {
  if (!event) throw new Error('KPIEvent is null/undefined');
  const { kpiName, timestamp, value } = event;

  if (!kpiName || typeof kpiName !== 'string') {
    throw new Error('KPIEvent.kpiName must be a non-empty string');
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`KPIEvent.timestamp (“${timestamp}”) is not a valid ISO date`);
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error('KPIEvent.value must be a valid number');
  }
}
```