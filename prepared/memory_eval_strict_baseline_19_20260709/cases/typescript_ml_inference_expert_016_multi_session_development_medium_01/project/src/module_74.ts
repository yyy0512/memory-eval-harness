```typescript
/**
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * Module: src/module_74.ts
 *
 * Purpose
 * -------
 * 1. Provide an extensible, hexagon-friendly implementation of KPI-drift
 *    detection that is fully decoupled from infrastructure concerns.
 * 2. Leverage Strategy, Factory and Observer patterns so the core domain
 *    stays agnostic to run-time details such as dashboards, alerting tools
 *    or storage engines.
 * 3. Serve as an example of production-quality TypeScript used inside the
 *    “inside” of the hexagon—pure business logic & rules.
 *
 * NOTE:  No external libraries are required.  All statistics are calculated
 *        in-house to avoid tight coupling with ML/Math ecosystems while still
 *        keeping the code realistic for production use-cases.
 */

/* -------------------------------------------------------------------------- */
/*                                Type Helpers                                */
/* -------------------------------------------------------------------------- */

export type NumericArray = readonly number[];

export interface DriftResult {
  readonly drifted: boolean;
  readonly pValue: number;          // Statistical significance of the drift
  readonly statistic: number;       // Test statistic (e.g., KS-D, PSI score)
  readonly method: string;          // Friendly name of the method used
}

/* -------------------------------------------------------------------------- */
/*                        1️⃣  Strategy Pattern: API                           */
/* -------------------------------------------------------------------------- */

export interface DriftDetectionStrategy {
  /** Human-friendly name, used in logs & observability. */
  readonly name: string;

  /**
   * Detects whether the `current` sample drifts significantly from the
   * `baseline` sample.
   */
  detectDrift(baseline: NumericArray, current: NumericArray): DriftResult;
}

/* -------------------------------------------------------------------------- */
/*            2️⃣  Concrete Strategies: KS-Test & PSI Implementation           */
/* -------------------------------------------------------------------------- */

/**
 * Kolmogorov-Smirnov two-sample drift detection.
 * Suitable for continuous distributions, small to mid-sized samples.
 */
export class KSDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'Kolmogorov-Smirnov';

  detectDrift(baseline: NumericArray, current: NumericArray): DriftResult {
    validateSamples(baseline, current);

    const sortedBase = [...baseline].sort((a, b) => a - b);
    const sortedCurr = [...current].sort((a, b) => a - b);

    let i = 0, j = 0;
    const n1 = sortedBase.length;
    const n2 = sortedCurr.length;
    let cdf1 = 0;
    let cdf2 = 0;
    let dStatistic = 0;

    while (i < n1 && j < n2) {
      const v1 = sortedBase[i];
      const v2 = sortedCurr[j];

      if (v1 <= v2) {
        i++;
        cdf1 = i / n1;
      }
      if (v2 <= v1) {
        j++;
        cdf2 = j / n2;
      }
      dStatistic = Math.max(dStatistic, Math.abs(cdf1 - cdf2));
    }

    // Approximate p-value for large samples using Smirnov distribution
    const ne = (n1 * n2) / (n1 + n2);
    const lambda = (Math.sqrt(ne) + 0.12 + 0.11 / Math.sqrt(ne)) * dStatistic;
    const pValue = approximateKSPValue(lambda);

    return {
      drifted: pValue < 0.05,
      pValue,
      statistic: dStatistic,
      method: this.name,
    };
  }
}

/**
 * Population Stability Index drift detection.
 * Commonly used in credit-risk and churn models.
 */
export class PSIDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'Population Stability Index';

  detectDrift(baseline: NumericArray, current: NumericArray): DriftResult {
    validateSamples(baseline, current);

    const numBins = 10;
    const binEdges = quantileEdges(baseline, numBins);
    const baselineBins = binFrequencies(baseline, binEdges);
    const currentBins = binFrequencies(current, binEdges);

    let psi = 0;
    for (let k = 0; k < numBins; k++) {
      const expected = baselineBins[k];
      const actual = currentBins[k];

      // Smooth to avoid division by zero
      const eps = 1e-6;
      psi += (actual - expected) * Math.log((actual + eps) / (expected + eps));
    }

    return {
      drifted: psi > 0.25, // Typical PSI threshold
      pValue: Number.NaN,  // PSI is not a statistical test → no p-value
      statistic: psi,
      method: this.name,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*            3️⃣  Factory Pattern: Obtain Strategy by Name or Key             */
/* -------------------------------------------------------------------------- */

export type DriftStrategyType = 'ks' | 'psi';

export class DriftDetectionStrategyFactory {
  private static readonly map: Record<DriftStrategyType, DriftDetectionStrategy> = {
    ks: new KSDriftStrategy(),
    psi: new PSIDriftStrategy(),
  };

  /**
   * Returns a singleton instance of the requested strategy.  This prevents
   * unnecessary object allocations during high-throughput inference.
   */
  static get(type: DriftStrategyType): DriftDetectionStrategy {
    const strategy = this.map[type];
    if (!strategy) {
      throw new Error(`DriftDetectionStrategyFactory: Unknown strategy "${type}"`);
    }
    return strategy;
  }
}

/* -------------------------------------------------------------------------- */
/*          4️⃣  Observer Pattern: Publisher → Subscriber Interface            */
/* -------------------------------------------------------------------------- */

export interface KPIDriftEvent {
  readonly kpi: string;
  readonly result: DriftResult;
  readonly timestamp: Date;
}

export interface KPIDriftSubscriber {
  onDrift(event: KPIDriftEvent): Promise<void> | void;
}

/**
 * In-memory, lightweight publisher.  Because we are in the domain layer,
 * this should not know anything about Kafka, SNS, etc; those will become
 * adapters that subscribe here and forward events outward.
 */
export class KPIDriftPublisher {
  private readonly subscribers = new Set<KPIDriftSubscriber>();

  subscribe(subscriber: KPIDriftSubscriber): void {
    this.subscribers.add(subscriber);
  }

  unsubscribe(subscriber: KPIDriftSubscriber): void {
    this.subscribers.delete(subscriber);
  }

  publish(event: KPIDriftEvent): void {
    for (const s of this.subscribers) {
      try {
        // Fire-and-forget; ensure domain logic never crashes on consumer error.
        void Promise.resolve(s.onDrift(event)).catch(err => {
          /* eslint-disable no-console */
          console.error(
            `[KPIDriftPublisher] Subscriber error (${event.kpi}):`,
            err instanceof Error ? err.message : err,
          );
          /* eslint-enable no-console */
        });
      } catch (err) {
        // Synchronous exception guard
        /* eslint-disable no-console */
        console.error(
          `[KPIDriftPublisher] Sync subscriber error (${event.kpi}):`,
          err instanceof Error ? err.message : err,
        );
        /* eslint-enable no-console */
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                  5️⃣  High-Level Monitoring Service API                     */
/* -------------------------------------------------------------------------- */

export interface DriftMonitoringConfig {
  readonly strategyType: DriftStrategyType;
  readonly kpiName: string;
}

export class KPIDriftMonitoringService {
  constructor(
    private readonly publisher: KPIDriftPublisher,
    private readonly config: DriftMonitoringConfig,
  ) {}

  /**
   * Runs drift detection on the provided samples and publishes results.
   *
   * @throws Error if drift detection fails due to malformed input
   */
  public detectAndPublish(
    baseline: NumericArray,
    current: NumericArray,
  ): DriftResult {
    const strategy = DriftDetectionStrategyFactory.get(this.config.strategyType);
    const result = strategy.detectDrift(baseline, current);

    const event: KPIDriftEvent = {
      kpi: this.config.kpiName,
      result,
      timestamp: new Date(),
    };

    this.publisher.publish(event);
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/*                            6️⃣  Helper Functions                            */
/* -------------------------------------------------------------------------- */

function validateSamples(baseline: NumericArray, current: NumericArray): void {
  if (!baseline?.length || !current?.length) {
    throw new Error('Both baseline and current samples must be non-empty arrays.');
  }
}

/**
 * Approximates the p-value of the KS statistic using the asymptotic formula.
 * Adequate for n > 20. For smaller samples, an exact algorithm would be needed.
 */
function approximateKSPValue(lambda: number): number {
  const sumTerms = 100; // Controls accuracy
  let sum = 0;
  for (let j = 1; j <= sumTerms; j++) {
    const term = Math.exp(-2 * Math.pow(j * lambda, 2));
    sum += (2 * (j % 2 ? 1 : -1)) * term; // Alternating series
  }
  return Math.max(Math.min(sum, 1), 0);
}

/**
 * Returns bin edges based on quantiles of the input array.
 */
function quantileEdges(arr: NumericArray, bins: number): number[] {
  if (bins < 2) throw new Error('Number of bins must be >= 2.');
  const sorted = [...arr].sort((a, b) => a - b);
  const edges: number[] = [Number.NEGATIVE_INFINITY];

  for (let i = 1; i < bins; i++) {
    const q = i / bins;
    const pos = q * (sorted.length - 1);
    const lower = Math.floor(pos);
    const upper = Math.ceil(pos);
    const weight = pos - lower;
    const value =
      sorted[lower] * (1 - weight) + sorted[upper] * weight; // Linear interpolation
    edges.push(value);
  }
  edges.push(Number.POSITIVE_INFINITY);
  return edges;
}

/**
 * Calculates normalized frequencies of data points that fall into each bin.
 */
function binFrequencies(arr: NumericArray, edges: number[]): number[] {
  const counts = new Array(edges.length - 1).fill(0);
  for (const x of arr) {
    // Binary search could be used here; linear scan for clarity.
    for (let i = 0; i < edges.length - 1; i++) {
      if (x > edges[i] && x <= edges[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  const total = arr.length;
  return counts.map(c => c / total);
}
```
