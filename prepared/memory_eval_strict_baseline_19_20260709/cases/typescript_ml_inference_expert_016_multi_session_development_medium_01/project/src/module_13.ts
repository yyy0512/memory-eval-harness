```typescript
/***************************************************************************************************
 *  InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:        src/module_13.ts
 *  Author:      InsightHexaAI Engineering
 *  Description: Domain-layer implementation of KPI drift monitoring combining
 *               – Strategy Pattern    · interchangeable drift–detection algorithms
 *               – Factory  Pattern    · dynamic construction of strategy implementations
 *               – Observer Pattern    · event-driven publication of drift findings
 *               The module lives inside the business-logic hexagon and therefore contains
 *               zero technical details about message brokers, dashboards or alerting systems.
 *               Adapters subscribe through the generic Observer interface exposed here.
 ***************************************************************************************************/

import { z } from 'zod'; // Runtime schema validation (peer-dependency)
import { mean, variance } from 'simple-statistics'; // Lightweight math utilities

/*****************************************
 *               Errors                  *
 *****************************************/

export class DriftDetectionError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DriftDetectionError';
    this.cause = cause;
    Object.setPrototypeOf(this, DriftDetectionError.prototype);
  }
}

/*****************************************
 *       Domain Types & Enumerations     *
 *****************************************/

/**
 * Enumeration of KPI families we monitor for statistical drift.
 * Extend with additional KPIs as the product grows.
 */
export enum KPIType {
  REVENUE = 'REVENUE',
  CLV = 'CUSTOMER_LIFETIME_VALUE',
  CHURN_PROBABILITY = 'CHURN_PROBABILITY',
  CONVERSION_RATE = 'CONVERSION_RATE',
}

/**
 * Qualitative severity labels used by finance & ops teams.
 */
export enum DriftSeverity {
  NONE = 'NONE',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

/**
 * Every drift–detection implementation must return this canonical object.
 */
export interface DriftReport {
  readonly kpi: KPIType;
  readonly severity: DriftSeverity;
  readonly pValue: number;        // Statistical confidence of the observed drift
  readonly metricValue: number;   // e.g. PSI, KL-divergence, Welch-t statistic etc.
  readonly createdAt: Date;
}

/*****************************************
 *       Observer (Publish / Subscribe)  *
 *****************************************/

/**
 * Generic subscriber interface.
 */
export interface Subscriber<T> {
  onEvent(event: T): void | Promise<void>;
}

/**
 * Simple in-memory event bus used by hexagon.
 * Adapters wrap this when integrating with Kafka, SNS, WebSockets, etc.
 */
export class InMemoryEventBus<T> {
  private readonly subscribers = new Set<Subscriber<T>>();

  public subscribe(listener: Subscriber<T>): void {
    this.subscribers.add(listener);
  }

  public unsubscribe(listener: Subscriber<T>): void {
    this.subscribers.delete(listener);
  }

  public async publish(event: T): Promise<void> {
    const deliveryTasks = [...this.subscribers].map((listener) =>
      Promise.resolve().then(() => listener.onEvent(event)),
    );
    await Promise.allSettled(deliveryTasks);
  }
}

/*****************************************
 *    Strategy: Drift-Detection Engines  *
 *****************************************/

/**
 * Contract every strategy must fulfill.
 */
export interface DriftDetectionStrategy {
  /**
   * @param baseline  Observations used to capture expected distribution.
   * @param incoming  New observations we test for drift.
   */
  detect(
    baseline: number[],
    incoming: number[],
    kpi: KPIType,
  ): DriftReport;
}

/**
 * Utility: Robust two-sample t-test (Welch).
 * Throws DriftDetectionError if assumptions are violated (e.g., empty samples).
 */
function welchsTTest(sampleA: number[], sampleB: number[]): { t: number; p: number } {
  if (sampleA.length < 2 || sampleB.length < 2) {
    throw new DriftDetectionError('Samples must contain at least two observations each.');
  }

  const meanA = mean(sampleA);
  const meanB = mean(sampleB);
  const varA = variance(sampleA);
  const varB = variance(sampleB);
  const nA = sampleA.length;
  const nB = sampleB.length;

  const numerator = meanA - meanB;
  const denominator = Math.sqrt(varA / nA + varB / nB);

  if (denominator === 0) {
    throw new DriftDetectionError('Degenerate variance encountered in Welch’s t-test.');
  }

  const tStatistic = numerator / denominator;

  // Degrees of freedom (Welch–Satterthwaite equation)
  const dfNumerator = (varA / nA + varB / nB) ** 2;
  const dfDenominator =
    (varA ** 2) / (nA ** 2 * (nA - 1)) + (varB ** 2) / (nB ** 2 * (nB - 1));
  const degreesFreedom = dfNumerator / dfDenominator;

  // Approximate two-tailed p-value via Student-t CDF.
  // For brevity, approximate with survival of normal distribution when df > 30.
  let pValue: number;
  if (degreesFreedom > 30) {
    const zScore = Math.abs(tStatistic);
    pValue = 2 * (1 - normalCdf(zScore));
  } else {
    pValue = 2 * (1 - studentTCdf(Math.abs(tStatistic), degreesFreedom));
  }

  return { t: tStatistic, p: pValue };
}

/**
 * Normal CDF approximation (error function).
 */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Error function approximation (Abramowitz & Stegun, 1964)
 */
function erf(x: number): number {
  // Save the sign of x
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * x);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);

  return sign * y;
}

/**
 * Student-t CDF using a series expansion.
 * NOTE: For production, consider a numerically-stable stats library.
 */
function studentTCdf(t: number, df: number): number {
  // Simplistic approximation using incomplete beta function via continued fractions
  // For brevity we fallback to normalCdf when df > 100.
  if (df > 100) return normalCdf(t);
  // Placeholder: assume symmetric distribution and use normalCdf.
  return normalCdf(t); // Acceptable for demonstration.
}

/**
 * Concrete Strategy: Population Stability Index.
 * Baselined for categorical/histogram distributions – approximated for continuous.
 */
export class PSIDriftDetectionStrategy implements DriftDetectionStrategy {
  private readonly binCount: number;

  constructor(binCount = 10) {
    this.binCount = binCount;
  }

  detect(baseline: number[], incoming: number[], kpi: KPIType): DriftReport {
    if (baseline.length === 0 || incoming.length === 0) {
      throw new DriftDetectionError('PSI requires non-empty samples.');
    }

    const { psi, severity } = this.calculatePSI(baseline, incoming);

    return {
      kpi,
      severity,
      pValue: 1 - Math.min(psi / 100, 0.9999), // Not strictly accurate; illustrative
      metricValue: psi,
      createdAt: new Date(),
    };
  }

  private calculatePSI(expected: number[], actual: number[]): { psi: number; severity: DriftSeverity } {
    const combined = [...expected, ...actual];
    const min = Math.min(...combined);
    const max = Math.max(...combined);
    const binWidth = (max - min) / this.binCount;

    if (binWidth === 0) {
      return { psi: 0, severity: DriftSeverity.NONE };
    }

    let psi = 0;
    for (let i = 0; i < this.binCount; i++) {
      const lower = min + i * binWidth;
      const upper = lower + binWidth;

      const expectedCount = expected.filter((v) => v >= lower && v < upper).length;
      const actualCount = actual.filter((v) => v >= lower && v < upper).length;

      const expectedPerc = expectedCount / expected.length;
      const actualPerc = actualCount / actual.length;

      if (expectedPerc === 0 || actualPerc === 0) continue; // Avoid log(0)

      psi += (actualPerc - expectedPerc) * Math.log(actualPerc / expectedPerc);
    }

    psi *= 100; // Scale for readability (industry convention)

    const severity =
      psi < 10
        ? DriftSeverity.NONE
        : psi < 20
        ? DriftSeverity.LOW
        : psi < 30
        ? DriftSeverity.MEDIUM
        : DriftSeverity.HIGH;

    return { psi, severity };
  }
}

/**
 * Concrete Strategy: Welch’s t-test for mean shift detection.
 * Suitable for continuous KPIs (e.g., revenue per order).
 */
export class MeanShiftDriftDetectionStrategy implements DriftDetectionStrategy {
  detect(baseline: number[], incoming: number[], kpi: KPIType): DriftReport {
    const { t, p } = welchsTTest(baseline, incoming);

    let severity: DriftSeverity;
    if (p >= 0.05) severity = DriftSeverity.NONE;
    else if (p >= 0.01) severity = DriftSeverity.LOW;
    else if (p >= 0.001) severity = DriftSeverity.MEDIUM;
    else severity = DriftSeverity.HIGH;

    return {
      kpi,
      severity,
      pValue: p,
      metricValue: Math.abs(t),
      createdAt: new Date(),
    };
  }
}

/*****************************************
 *            Factory Pattern            *
 *****************************************/

/**
 * Factory parameters validated with zod at runtime.
 */
const StrategyConfigSchema = z.union([
  z.object({
    type: z.literal('PSI'),
    binCount: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('MEAN_SHIFT'),
  }),
]);
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export class DriftDetectionStrategyFactory {
  /**
   * Produces a Strategy implementation based on config.
   * @throws DriftDetectionError when config invalid or strategy unsupported.
   */
  public static create(config: StrategyConfig): DriftDetectionStrategy {
    const parsed = StrategyConfigSchema.parse(config);

    switch (parsed.type) {
      case 'PSI':
        return new PSIDriftDetectionStrategy(parsed.binCount);
      case 'MEAN_SHIFT':
        return new MeanShiftDriftDetectionStrategy();
      default:
        /* c8 ignore next 2 */ // compile-time exhaustive – never reached
        throw new DriftDetectionError(`Unsupported drift-detection strategy: ${(parsed as any).type}`);
    }
  }
}

/*****************************************
 *          Drift Monitor (Facade)       *
 *****************************************/

export class DriftMonitor {
  private readonly bus: InMemoryEventBus<DriftReport>;

  constructor(private readonly strategyFactory = DriftDetectionStrategyFactory) {
    this.bus = new InMemoryEventBus<DriftReport>();
  }

  /**
   * Attach an Observer (adapter) that wants to receive DriftReport events.
   */
  public registerSubscriber(subscriber: Subscriber<DriftReport>): void {
    this.bus.subscribe(subscriber);
  }

  /**
   * Perform drift detection and publish results.
   */
  public async evaluate(
    baseline: number[],
    incoming: number[],
    kpi: KPIType,
    strategyConfig: StrategyConfig,
  ): Promise<DriftReport> {
    try {
      const strategy = this.strategyFactory.create(strategyConfig);
      const report = strategy.detect(baseline, incoming, kpi);
      await this.bus.publish(report);
      return report;
    } catch (err) {
      // Wrap third-party lib errors into domain-specific error.
      throw err instanceof DriftDetectionError
        ? err
        : new DriftDetectionError('Unable to evaluate drift.', err);
    }
  }
}

/*****************************************
 *              EXAMPLE USAGE            *
 *  (Would live in unit tests / adapters)
 *****************************************/

// This section is intentionally wrapped in a block to prevent accidental
// execution when imported via Node – it serves as illustrative documentation.
if (process.env.NODE_ENV === 'test-example') {
  (async () => {
    const monitor = new DriftMonitor();

    // Subscribe a simple console logger – adapters could push to Slack, Kafka, etc.
    monitor.registerSubscriber({
      onEvent: (event) => {
        // eslint-disable-next-line no-console
        console.info(`[DriftMonitor] Detected drift:`, JSON.stringify(event, null, 2));
      },
    });

    const baselineData = Array.from({ length: 1000 }, () => 50 + Math.random() * 10); // mean≈55
    const incomingData = Array.from({ length: 1000 }, () => 65 + Math.random() * 12); // mean≈71

    await monitor.evaluate(baselineData, incomingData, KPIType.REVENUE, { type: 'MEAN_SHIFT' });
  })().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  });
}
```
