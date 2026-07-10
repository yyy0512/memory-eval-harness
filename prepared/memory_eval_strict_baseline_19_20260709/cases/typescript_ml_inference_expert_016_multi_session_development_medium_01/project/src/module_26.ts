```typescript
/**************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  ----------------------------------------------------------------------------------------------
 *  File:        src/module_26.ts
 *  Responsibility:
 *      • Implements an Observer-Pattern–driven KPI monitoring service that publishes metric-drift
 *        events to multiple subscribers (dashboards, messaging adapters, etc.).
 *      • Uses the Strategy & Factory patterns to allow runtime selection of “drift detection”
 *        logic without modifying dependent code.
 *
 *  High-level flow:
 *      1. A domain service (KPIDriftMonitor) receives fresh KPI snapshots pushed by the inference
 *         pipelines.
 *      2. It delegates “is this drift?” decisions to a pluggable ThresholdStrategy implementation.
 *      3. On drift, it publishes a KPIDriftEvent via KPIEventPublisher.
 *      4. Any registered observers (e.g., DashboardNotifier, SlackNotifier) react immediately,
 *         remaining decoupled from core business logic.
 *
 *  NOTE: Concrete adapter implementations (e.g., SlackNotifier -> Slack API) live outside the
 *        hexagon and are therefore only represented by interfaces here.
 **************************************************************************************************/

//#region Imports
import { v4 as uuid } from 'uuid'; // RFC-4122 IDs for auditability
//#endregion

//#region Shared Types & Utilities

/**
 * Fails fast on impossible control flows that should never happen at runtime,
 * yet satisfy the compiler that we handled every variant of a discriminated union.
 */
function assertNever(x: never): never {
  throw new Error(`Unexpected object: ${JSON.stringify(x)}`);
}

/**
 * ISO-8601 timestamp helper for consistent time handling.
 */
const now = (): string => new Date().toISOString();

//#endregion

//#region Observer Pattern ––– Events, Subjects, Observers

/**
 * Domain event types emitted by KPI monitoring.
 */
export enum KPIEventType {
  DRIFT_DETECTED = 'DRIFT_DETECTED',
  KPI_RESTORED   = 'KPI_RESTORED',
}

/**
 * Extended metadata associated with every emitted event.
 */
export interface KPIEventMeta {
  correlationId: string;           // Cross-service trace id
  occurredAt:    string;           // ISO timestamp
  source:        string;           // Who/what produced it
}

/**
 * Base shape for KPI-related events.
 */
export interface KPIEvent<TPayload = unknown> {
  type: KPIEventType;
  payload: TPayload;
  meta: KPIEventMeta;
}

/**
 * Generic Observer contract.
 */
export interface Observer<T> {
  id: string;
  next(event: T): void | Promise<void>;
}

/**
 * Generic Subject contract.
 */
export interface Subject<T> {
  attach(observer: Observer<T>): void;
  detach(observerId: string): void;
  notify(event: T): void;
}

/**
 * Concrete Subject for KPI events.
 */
export class KPIEventPublisher implements Subject<KPIEvent> {
  private observers: Map<string, Observer<KPIEvent>> = new Map();

  attach(observer: Observer<KPIEvent>): void {
    if (this.observers.has(observer.id)) {
      // Prevent duplicates
      return;
    }
    this.observers.set(observer.id, observer);
  }

  detach(observerId: string): void {
    this.observers.delete(observerId);
  }

  notify(event: KPIEvent): void {
    this.observers.forEach((observer) => {
      try {
        // Allow both sync and async observers
        const result = observer.next(event);
        if (result instanceof Promise) {
          result.catch((err) =>
            console.error(`[Observer:${observer.id}] async error:`, err),
          );
        }
      } catch (err) {
        // Never let one bad observer break the publication chain
        console.error(`[Observer:${observer.id}] error:`, err);
      }
    });
  }
}

//#endregion

//#region Strategy Pattern ––– Drift-Detection Algorithms

/**
 * Input structure given to drift detection strategies.
 */
export interface KPISnapshot {
  kpiName:     string;
  value:       number;       // Current KPI figure
  baseline:    number;       // Baseline used for comparison
  windowSize?: number;       // Optional rolling window information
  timestamp:   string;       // ISO timestamp when snapshot was taken
}

/**
 * Each strategy decides whether the snapshot deviates enough
 * from its baseline to be considered “drift”.
 */
export interface ThresholdStrategy {
  readonly name: string;
  isDrift(snapshot: KPISnapshot): boolean;
}

/**
 * Strategy #1 – Simple percentage-based threshold.
 */
export class StaticThresholdStrategy implements ThresholdStrategy {
  readonly name = StaticThresholdStrategy.name;

  constructor(private readonly tolerancePct: number) {
    if (tolerancePct <= 0 || tolerancePct >= 100) {
      throw new RangeError('tolerancePct must be between 0 and 100');
    }
  }

  isDrift({ value, baseline }: KPISnapshot): boolean {
    if (baseline === 0) {
      // Edge-case: baseline is zero, treat any non-zero value as drift.
      return value !== 0;
    }
    const diffPct = Math.abs((value - baseline) / baseline) * 100;
    return diffPct > this.tolerancePct;
  }
}

/**
 * Strategy #2 – Z-score based threshold for statistically robust detection.
 */
export class ZScoreThresholdStrategy implements ThresholdStrategy {
  readonly name = ZScoreThresholdStrategy.name;

  constructor(
    private readonly historicalMean: number,
    private readonly historicalStdDev: number,
    private readonly zScoreLimit: number,
  ) {
    if (historicalStdDev <= 0) {
      throw new RangeError('historicalStdDev must be > 0');
    }
    if (zScoreLimit <= 0) {
      throw new RangeError('zScoreLimit must be > 0');
    }
  }

  isDrift({ value }: KPISnapshot): boolean {
    const z = Math.abs((value - this.historicalMean) / this.historicalStdDev);
    return z > this.zScoreLimit;
  }
}

/**
 * Factory – selects an appropriate strategy at runtime based on config.
 */
export interface ThresholdStrategyConfig {
  type: 'STATIC' | 'ZSCORE';
  params: Record<string, unknown>;
}

export class ThresholdStrategyFactory {
  static build(cfg: ThresholdStrategyConfig): ThresholdStrategy {
    switch (cfg.type) {
      case 'STATIC': {
        const tolerancePct = Number(cfg.params['tolerancePct'] ?? 10);
        return new StaticThresholdStrategy(tolerancePct);
      }
      case 'ZSCORE': {
        const historicalMean    = Number(cfg.params['mean']);
        const historicalStdDev  = Number(cfg.params['stddev']);
        const zScoreLimit       = Number(cfg.params['limit'] ?? 3);
        return new ZScoreThresholdStrategy(
          historicalMean,
          historicalStdDev,
          zScoreLimit,
        );
      }
      default:
        return assertNever(cfg.type as never);
    }
  }
}

//#endregion

//#region Concrete Observers ––– Dashboard & Slack Notifiers
// (Note: only interfaces; concrete adapters live outside the core hexagon.)

export interface DashboardNotifierOptions {
  route: string; // REST endpoint or message queue topic
}

export class DashboardNotifier implements Observer<KPIEvent> {
  readonly id = DashboardNotifier.name;

  constructor(private readonly opts: DashboardNotifierOptions) {}

  next(event: KPIEvent): void {
    // Placeholder: route event to BI dashboard
    /* istanbul ignore next */
    console.debug(`[DashboardNotifier] POST ${this.opts.route}`, event);
  }
}

export interface SlackNotifierOptions {
  channel: string;
}

export class SlackNotifier implements Observer<KPIEvent> {
  readonly id = SlackNotifier.name;

  constructor(private readonly opts: SlackNotifierOptions) {}

  next(event: KPIEvent): void {
    // Placeholder: send Slack message
    /* istanbul ignore next */
    console.debug(
      `[SlackNotifier] -> #${this.opts.channel}:`,
      JSON.stringify(event),
    );
  }
}

//#endregion

//#region Domain Service ––– KPIDriftMonitor

/**
 * KPIDriftMonitor ties everything together. Consumes KPI snapshots,
 * decides drift via strategy, and publishes events.
 */
export class KPIDriftMonitor {
  private publisher: KPIEventPublisher;
  private strategy: ThresholdStrategy;

  constructor(
    strategy: ThresholdStrategy,
    publisher?: KPIEventPublisher,
  ) {
    this.strategy  = strategy;
    this.publisher = publisher ?? new KPIEventPublisher();
  }

  /**
   * Allows external composition/injection of observers without exposing
   * the underlying publisher implementation details.
   */
  addObserver(observer: Observer<KPIEvent>): void {
    this.publisher.attach(observer);
  }

  /**
   * Processes an incoming KPI snapshot from the inference pipeline.
   * If drift detected -> publish DRIFT_DETECTED event.
   */
  handleSnapshot(snapshot: KPISnapshot): void {
    try {
      const isDrift = this.strategy.isDrift(snapshot);
      const eventType = isDrift
        ? KPIEventType.DRIFT_DETECTED
        : KPIEventType.KPI_RESTORED;

      const event: KPIEvent<KPISnapshot> = {
        type: eventType,
        payload: snapshot,
        meta: {
          correlationId: uuid(),
          occurredAt: now(),
          source: KPIDriftMonitor.name,
        },
      };

      this.publisher.notify(event);
    } catch (err) {
      // Propagate without throwing; observers rely on monitor stability
      console.error(`[KPIDriftMonitor] failed to process snapshot`, {
        err,
        snapshot,
      });
    }
  }

  /**
   * Allows strategy swapping at runtime, critical for feature flags
   * or A/B experiments of drift-detection algorithms.
   */
  switchStrategy(strategy: ThresholdStrategy): void {
    console.info(
      `[KPIDriftMonitor] Switching strategy ${this.strategy.name} -> ${strategy.name}`,
    );
    this.strategy = strategy;
  }
}

//#endregion

//#region Example Usage (lights-out tests / self-demo)

// Only run demo in non-production environments
/* istanbul ignore next */
if (process.env.NODE_ENV !== 'production') {
  // 1) Build strategy from config (would come from config service)
  const strategyConfig: ThresholdStrategyConfig = {
    type: 'STATIC',
    params: { tolerancePct: 5 },
  };
  const strategy = ThresholdStrategyFactory.build(strategyConfig);

  // 2) Instantiate monitor
  const monitor = new KPIDriftMonitor(strategy);

  // 3) Register observers
  monitor.addObserver(
    new DashboardNotifier({ route: '/internal/bi/kpi-events' }),
  );
  monitor.addObserver(new SlackNotifier({ channel: 'ml-alerts' }));

  // 4) Feed snapshots
  monitor.handleSnapshot({
    kpiName: 'CTR',
    baseline: 0.04,
    value: 0.033,
    timestamp: now(),
  });

  monitor.handleSnapshot({
    kpiName: 'CTR',
    baseline: 0.04,
    value: 0.039,
    timestamp: now(),
  });
}

//#endregion
```