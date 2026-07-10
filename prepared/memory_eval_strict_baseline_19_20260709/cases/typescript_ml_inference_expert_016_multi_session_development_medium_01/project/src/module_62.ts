```typescript
/**
 * InsightHexaAI
 * src/module_62.ts
 *
 * Purpose:
 * Domain-level drift-monitoring service that sits inside the Hexagon.
 * Uses Strategy- and Observer-patterns so that:
 *   • Detection logic can be swapped without changing IO-adapters
 *   • External dashboards/alerting systems can subscribe to drift events
 *
 * NOTE: This file purposefully contains no code that touches frameworks,
 * databases, sockets, etc.—only pure domain logic plus Node’s EventEmitter
 * (which is acceptable inside the hexagon because it is easily replaceable).
 */

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------- */
/*                             Domain-Level Types                             */
/* -------------------------------------------------------------------------- */

/**
 * Extended, strongly-typed version of NodeJS EventEmitter to guarantee that
 * only declared events can be emitted/listened to.
 */
export interface DriftEvents {
  'drift:detected': (kpiName: string, details: DriftDetails) => void;
}

export interface DriftDetails {
  metricName: string;
  baselineMean: number;
  currentMean: number;
  threshold: number;
  pValue?: number; // optional—for advanced strategies
  timestamp: Date;
}

/* -------------------------------------------------------------------------- */
/*                          Drift-Detection Strategies                        */
/* -------------------------------------------------------------------------- */

/**
 * Strategy interface that concrete drift-detection algorithms must implement.
 * The hexagon relies on this abstraction so that Product can roll out more
 * sophisticated statistical tests without touching calling code.
 */
export interface DriftDetectionStrategy {
  readonly name: string;
  detect(baseline: number[], incoming: number[]): DriftDetails | null;
}

/**
 * Simple, comprehensible strategy that raises a drift event when the absolute
 * delta between means crosses a configurable threshold.
 */
export class AbsoluteMeanThresholdStrategy implements DriftDetectionStrategy {
  public readonly name = 'absolute_mean_threshold';

  constructor(private readonly threshold: number) {
    if (threshold <= 0) {
      throw new Error(
        `[${this.name}] Threshold must be > 0. Received: ${threshold}`,
      );
    }
  }

  public detect(baseline: number[], incoming: number[]): DriftDetails | null {
    if (baseline.length === 0 || incoming.length === 0) {
      // Not enough information to compute a delta
      return null;
    }

    const baselineMean =
      baseline.reduce((acc, v) => acc + v, 0) / baseline.length;
    const currentMean =
      incoming.reduce((acc, v) => acc + v, 0) / incoming.length;

    const delta = Math.abs(currentMean - baselineMean);

    if (delta >= this.threshold) {
      return {
        metricName: '',
        baselineMean,
        currentMean,
        threshold: this.threshold,
        timestamp: new Date(),
      };
    }

    return null;
  }
}

/**
 * Instrumented Kolmogorov–Smirnov test to compare two distributions. Uses lazy
 * import to avoid pulling heavy dependencies (e.g., `simple-statistics`) into
 * cold code paths; avoids breaking unit tests when the dependency is absent.
 *
 * DISCLAIMER: This is lightweight and *not* production-grade statistical
 * inference. Replace with a vetted library if you have regulatory constraints.
 */
export class KSTestStrategy implements DriftDetectionStrategy {
  public readonly name = 'ks_test';

  private readonly significance: number;

  constructor(significance = 0.05) {
    if (significance <= 0 || significance >= 1) {
      throw new Error(
        `[${this.name}] Significance must be within (0,1). Received: ${significance}`,
      );
    }
    this.significance = significance;
  }

  public detect(baseline: number[], incoming: number[]): DriftDetails | null {
    if (baseline.length === 0 || incoming.length === 0) {
      return null;
    }

    // Lazy load to keep top-level graph slim
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/no-extraneous-dependencies
    const { ksTest } = require('simple-statistics') as typeof import('simple-statistics');

    const { pValue, D } = ksTest(baseline, incoming);
    if (pValue < this.significance) {
      return {
        metricName: '',
        baselineMean: mean(baseline),
        currentMean: mean(incoming),
        threshold: D,
        pValue,
        timestamp: new Date(),
      };
    }
    return null;
  }
}

function mean(arr: number[]): number {
  return arr.reduce((acc, v) => acc + v, 0) / arr.length;
}

/* -------------------------------------------------------------------------- */
/*                         Strategy Factory (Factory)                         */
/* -------------------------------------------------------------------------- */

/**
 * Central place to construct concrete strategies from runtime config.
 * Keeps strategy-specific params in one spot—easier for ConfigOps teams.
 */
export class DriftDetectionStrategyFactory {
  public static create(
    id: string,
    params?: Record<string, unknown>,
  ): DriftDetectionStrategy {
    switch (id) {
      case 'absolute_mean_threshold': {
        const threshold = Number(params?.threshold ?? 0.05);
        return new AbsoluteMeanThresholdStrategy(threshold);
      }
      case 'ks_test': {
        const significance = Number(params?.significance ?? 0.05);
        return new KSTestStrategy(significance);
      }
      default:
        throw new Error(
          `Unknown DriftDetectionStrategy "${id}". Are you missing a factory case?`,
        );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                           Observer / EventEmitter                          */
/* -------------------------------------------------------------------------- */

type TypedEmitter<T extends Record<string, (...args: any[]) => void>> = {
  on<K extends keyof T>(event: K, listener: T[K]): TypedEmitter<T>;
  off<K extends keyof T>(event: K, listener: T[K]): TypedEmitter<T>;
  emit<K extends keyof T>(
    event: K,
    ...args: Parameters<T[K]>
  ): boolean;
};

class DriftEventBus
  extends EventEmitter
  implements TypedEmitter<DriftEvents> {}

/* -------------------------------------------------------------------------- */
/*                          Drift Monitoring Service                          */
/* -------------------------------------------------------------------------- */

export interface DriftMonitorOptions {
  /**
   * Sliding window size for baseline computation.
   * E.g., if `baselineWindow=500`, the service keeps the latest 500 values
   * when computing the baseline mean.
   */
  baselineWindow?: number;

  /**
   * Sliding window size for “incoming” real-time observations.
   */
  incomingWindow?: number;
}

/**
 * Core domain service responsible for:
 *   1. Storing metric histories in a memory-efficient way
 *   2. Delegating detection logic to Strategy
 *   3. Broadcasting drift events to outside adapters
 *
 * IO-side concerns (Kafka/SNS, Datadog, etc.) will subscribe to the
 * DriftEventBus from their respective adapter layers.
 */
export class DriftMonitorService {
  private readonly baselineWindow: number;
  private readonly incomingWindow: number;
  private readonly histories: Record<
    string,
    { baseline: number[]; incoming: number[] }
  > = {};

  private readonly bus = new DriftEventBus();

  constructor(
    private readonly strategies: Map<string, DriftDetectionStrategy>,
    opts: DriftMonitorOptions = {},
  ) {
    this.baselineWindow = opts.baselineWindow ?? 500;
    this.incomingWindow = opts.incomingWindow ?? 100;

    if (this.baselineWindow <= 0 || this.incomingWindow <= 0) {
      throw new Error(
        'baselineWindow and incomingWindow must both be > 0.',
      );
    }
  }

  /* ----------------------------- Public API ----------------------------- */

  /**
   * Subscribe to domain events in an Observer-pattern fashion.
   */
  public on<K extends keyof DriftEvents>(
    event: K,
    listener: DriftEvents[K],
  ): void {
    this.bus.on(event, listener);
  }

  public off<K extends keyof DriftEvents>(
    event: K,
    listener: DriftEvents[K],
  ): void {
    this.bus.off(event, listener);
  }

  /**
   * Process a new value for the given KPI. Maintains sliding windows, calls
   * into the chosen strategy, and emits a drift event if needed.
   */
  public ingest(kpiName: string, value: number): void {
    const history = this.getHistory(kpiName);
    // Add to incoming
    history.incoming.push(value);
    shrinkToSize(history.incoming, this.incomingWindow);

    // Build baseline from previous values
    if (history.baseline.length < this.baselineWindow) {
      history.baseline.push(value);
      shrinkToSize(history.baseline, this.baselineWindow);
      // Baseline still warming up; skip detection
      return;
    }

    // Pick strategy—fallback to default (absolute_mean_threshold)
    const strategy =
      this.strategies.get(kpiName) ||
      DriftDetectionStrategyFactory.create('absolute_mean_threshold', {
        threshold: 0.05,
      });

    // Run detection
    const maybeDrift = strategy.detect(
      history.baseline,
      history.incoming,
    );

    if (maybeDrift) {
      maybeDrift.metricName = kpiName; // mutate before emit
      this.bus.emit('drift:detected', kpiName, maybeDrift);
      // Refresh baseline after drift so we don’t spam
      history.baseline.splice(0, history.baseline.length);
      history.baseline.push(...history.incoming);
    }
  }

  /* ---------------------------- Implementation ---------------------------- */

  private getHistory(kpiName: string): {
    baseline: number[];
    incoming: number[];
  } {
    if (!this.histories[kpiName]) {
      this.histories[kpiName] = { baseline: [], incoming: [] };
    }
    return this.histories[kpiName];
  }
}

/* -------------------------------------------------------------------------- */
/*                              Helper Utilities                              */
/* -------------------------------------------------------------------------- */

function shrinkToSize(arr: unknown[], maxSize: number): void {
  if (arr.length > maxSize) {
    arr.splice(0, arr.length - maxSize);
  }
}

/* -------------------------------------------------------------------------- */
/*                               Example Usage                                */
/* -------------------------------------------------------------------------- */

/* The following block shows how Core code *could* be used by an adapter.
 * Delete in production if you don’t want demo scaffolding in the repo.
 */
if (process.env.NODE_ENV === 'demo') {
  // eslint-disable-next-line no-console
  console.log('Running DriftMonitorService demo…');

  const monitor = new DriftMonitorService(
    new Map([
      [
        'revenue',
        DriftDetectionStrategyFactory.create('absolute_mean_threshold', {
          threshold: 0.1,
        }),
      ],
      ['click_through_rate', DriftDetectionStrategyFactory.create('ks_test')],
    ]),
  );

  monitor.on('drift:detected', (kpi, details) => {
    // eslint-disable-next-line no-console
    console.log(`Drift detected on "${kpi}"`, details);
  });

  // Simulate traffic
  for (let i = 0; i < 1_000; i += 1) {
    // revenue is stable
    monitor.ingest('revenue', 50 + Math.random() * 2 - 1);

    // CTR gradually drifts
    monitor.ingest(
      'click_through_rate',
      0.08 + Math.random() * 0.02 + i * 0.0001,
    );
  }
}
```