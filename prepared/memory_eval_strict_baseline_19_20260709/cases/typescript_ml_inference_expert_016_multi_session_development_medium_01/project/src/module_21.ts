```typescript
/**************************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * Module: KPI Drift Monitoring (hexagon–core domain)
 *
 * File path: src/module_21.ts
 *
 * Role:
 *   1. Receives inference-time “prediction vs. actual” KPI tuples from adapters (Kafka, REST, etc.).
 *   2. Applies pluggable DriftDetectionStrategy (Strategy Pattern) to decide whether drift occurred.
 *   3. Publishes DriftDetectedDomainEvent onto a domain-level EventBus (Observer Pattern) so that
 *      dashboards, alerting adapters, or automated retraining pipelines can react.
 *
 * NOTE:
 *   – This module purposefully avoids direct IO concerns. All interaction with outside tech happens
 *     through ports (interfaces) so that the hexagon remains testable and stable.
 *   – For brevity, certain dependencies (e.g. uuid) are imported directly; in the real repo they
 *     would be wrapped by dedicated adapters as well.
 **************************************************************************************************/

import { EventEmitter } from 'events';
import { v4 as uuidV4 } from 'uuid';

/**
 * A finite list of KPI types that the platform cares about.
 * Extend as needed; this is only domain-level nomenclature.
 */
export type KPIType = 'revenue' | 'customer_lifetime_value' | 'churn_probability';

/**
 * Single inference observation (prediction + ground-truth once available).
 * Invariants:
 *  – predicted & actual numbers should be finite values
 *  – timestamp MUST be in UTC (enforced upstream)
 */
export interface KPIRecord {
  readonly modelId: string;
  readonly kpiType: KPIType;
  readonly timestamp: Date;
  readonly predicted: number;
  readonly actual: number;
}

/**
 * Domain event that signals a statistically significant drift in a KPI
 * produced by a specific model.
 */
export interface DriftDetectedDomainEvent {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly modelId: string;
  readonly kpiType: KPIType;
  readonly severity: 'low' | 'medium' | 'high';
  readonly metadata: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*                                Event  Bus                                  */
/* -------------------------------------------------------------------------- */

/**
 * A lightweight, in-memory event bus for domain events.
 * Replaced by Kafka/SNS/etc. adapters in production via the same interface.
 */
export interface DomainEventBus {
  emit<TEvent>(eventName: string, event: TEvent): void;
  on<TEvent>(eventName: string, listener: (event: TEvent) => void): void;
}

export class InMemoryDomainEventBus implements DomainEventBus {
  private readonly emitter = new EventEmitter();

  emit<TEvent>(eventName: string, event: TEvent): void {
    this.emitter.emit(eventName, event);
  }

  on<TEvent>(eventName: string, listener: (event: TEvent) => void): void {
    this.emitter.on(eventName, listener);
  }
}

/* -------------------------------------------------------------------------- */
/*                       Drift-detection Strategy Pattern                     */
/* -------------------------------------------------------------------------- */

/**
 * Encapsulates drift-detection logic. Allows business stakeholders to pick/
 * switch algorithms at run-time with zero code changes in outer layers.
 */
export interface DriftDetectionStrategy {
  readonly name: string;
  /**
   * @returns boolean – whether the incoming observation indicates drift.
   */
  isDrift(record: KPIRecord, history: ReadonlyArray<KPIRecord>): boolean;
}

/**
 * Simple % error threshold: |actual - predicted| / |predicted| > tolerance
 */
export class AbsolutePercentageDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'absolute_percentage_threshold';

  constructor(private readonly tolerance: number = 0.2) {
    if (tolerance <= 0) {
      throw new Error('Tolerance must be > 0');
    }
  }

  isDrift(record: KPIRecord): boolean {
    const { actual, predicted } = record;
    if (!isFinite(actual) || !isFinite(predicted)) return false;

    const percentageError = Math.abs(actual - predicted) / (Math.abs(predicted) + 1e-9);
    return percentageError > this.tolerance;
  }
}

/**
 * Rolling window z-score drift detector.
 * Flags a drift if current error deviates > zThreshold * σ from μ.
 */
export class RollingZScoreDriftStrategy implements DriftDetectionStrategy {
  public readonly name = 'rolling_z_score';

  constructor(
    private readonly windowSize: number = 50,
    private readonly zThreshold: number = 3
  ) {
    if (windowSize < 10) throw new Error('windowSize must be ≥ 10');
  }

  isDrift(record: KPIRecord, history: ReadonlyArray<KPIRecord>): boolean {
    const recent = history.slice(-this.windowSize);
    if (recent.length < this.windowSize) return false; // insufficient data

    const errors = recent.map(r => Math.abs(r.actual - r.predicted));
    const mean =
      errors.reduce((sum, e) => sum + e, 0) / errors.length || Number.EPSILON;
    const variance =
      errors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / errors.length;
    const stdDev = Math.sqrt(variance);

    const currentError = Math.abs(record.actual - record.predicted);
    const zScore = (currentError - mean) / (stdDev + 1e-9);
    return zScore > this.zThreshold;
  }
}

/**
 * Factory (Factory Pattern) that resolves a strategy based on configuration,
 * environment flags, or even run-time AB-tests.
 */
export type DriftStrategyConfig =
  | { kind: 'absolute'; tolerance: number }
  | { kind: 'rolling_z'; windowSize?: number; zThreshold?: number };

export class DriftDetectionStrategyFactory {
  static fromConfig(config: DriftStrategyConfig): DriftDetectionStrategy {
    switch (config.kind) {
      case 'absolute':
        return new AbsolutePercentageDriftStrategy(config.tolerance);
      case 'rolling_z':
        return new RollingZScoreDriftStrategy(config.windowSize, config.zThreshold);
      default:
        // Using exhaustive check for compile-time safety
        const _exhaustive: never = config;
        throw new Error(`Unsupported drift strategy: ${_exhaustive}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                          KPI Drift Monitoring  Service                     */
/* -------------------------------------------------------------------------- */

/**
 * Core service that:
 *  – Stores minimal history for drift strategies that need it.
 *  – Evaluates incoming observations against the configured strategy.
 *  – Publishes DriftDetectedDomainEvent when drift is found.
 */
export class KPIDriftMonitorService {
  private readonly history: KPIRecord[] = [];

  constructor(
    private readonly strategy: DriftDetectionStrategy,
    private readonly eventBus: DomainEventBus
  ) {}

  /**
   * Ingests a single KPI observation and checks for drift.
   * IO/broker layers are expected to call this method in real-time.
   */
  ingest(record: KPIRecord): void {
    try {
      this.validateRecord(record);

      const drift = this.strategy.isDrift(record, this.history);
      this.history.push(record);

      if (drift) {
        const event: DriftDetectedDomainEvent = {
          eventId: uuidV4(),
          occurredAt: new Date(),
          modelId: record.modelId,
          kpiType: record.kpiType,
          severity: this.calculateSeverity(record),
          metadata: {
            strategy: this.strategy.name,
            predicted: record.predicted,
            actual: record.actual,
          },
        };
        this.eventBus.emit<DriftDetectedDomainEvent>('KPI_DRIFT_DETECTED', event);
      }
    } catch (err) {
      /* In hexagon we merely bubble up domain errors;
         adapters can decide whether to log/alert */
      // eslint-disable-next-line no-console
      console.error('KPIDriftMonitorService failed to ingest record:', err);
    }
  }

  /**
   * Naïve severity computation. Product managers can iterate on this without
   * touching IO layers thanks to clean architecture.
   */
  private calculateSeverity(record: KPIRecord): DriftDetectedDomainEvent['severity'] {
    const error = Math.abs(record.actual - record.predicted);
    if (error > 0.5) return 'high';
    if (error > 0.25) return 'medium';
    return 'low';
  }

  /**
   * Domain validation (lightweight; deeper validation occurs in adapters)
   */
  private validateRecord(record: KPIRecord): void {
    if (!record.modelId) throw new Error('modelId is required');
    if (!['revenue', 'customer_lifetime_value', 'churn_probability'].includes(record.kpiType))
      throw new Error(`Unsupported KPI type: ${record.kpiType}`);
    if (!isFinite(record.predicted) || !isFinite(record.actual))
      throw new Error('predicted and actual must be finite numbers');
  }
}

/* -------------------------------------------------------------------------- */
/*                                Example Usage                              */
/* -------------------------------------------------------------------------- */

/**
 * The following demonstration would sit in an integration test or an adapter
 * (e.g., a Kafka consumer). Left here to illustrate the hexagonal boundaries.
 */

if (process.env.NODE_ENV !== 'production') {
  // Domain wiring
  const bus = new InMemoryDomainEventBus();
  const strategy = DriftDetectionStrategyFactory.fromConfig({
    kind: 'rolling_z',
    windowSize: 20,
    zThreshold: 2.5,
  });
  const monitor = new KPIDriftMonitorService(strategy, bus);

  // Subscribe a simple console logger as an observer.
  bus.on<DriftDetectedDomainEvent>('KPI_DRIFT_DETECTED', event => {
    // eslint-disable-next-line no-console
    console.info('[ALERT] KPI drift detected:', JSON.stringify(event, null, 2));
  });

  // Simulate streaming observations
  for (let i = 0; i < 100; i++) {
    const fakeRecord: KPIRecord = {
      modelId: 'model-123',
      kpiType: 'revenue',
      timestamp: new Date(),
      predicted: 100,
      actual: 100 + (Math.random() - 0.5) * 40, // ±20% noise
    };
    monitor.ingest(fakeRecord);
  }

  // Inject a significant outlier to trigger high-severity drift
  monitor.ingest({
    modelId: 'model-123',
    kpiType: 'revenue',
    timestamp: new Date(),
    predicted: 100,
    actual: 1000, // 10× spike
  });
}
```
