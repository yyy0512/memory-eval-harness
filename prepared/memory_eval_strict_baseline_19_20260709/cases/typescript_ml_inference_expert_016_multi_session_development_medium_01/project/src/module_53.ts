```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite
 * File: src/module_53.ts
 *
 * Purpose:
 * =========
 *  • Production-grade, hexagonal-compliant monitoring layer for model-serving KPIs.
 *  • Leverages Observer, Strategy, and Factory patterns to:
 *      – Evaluate multiple model-health metrics (drift, data quality, latency, etc.)
 *      – Dispatch structured domain events to interested adapters (dashboards, pagers).
 *      – Select the proper remediation strategy (alert-only, auto-retrain, hybrid…)
 *
 * External dependencies are purposefully lightweight (built-ins only) in order
 * to keep the core domain free from vendor lock-in. Concrete adapters (e.g.,
 * KafkaPublisher, SlackNotifier) live outside the hexagon and subscribe to the
 * domain events emitted here.
 */

import { EventEmitter } from 'events';

/* -------------------------------------------------------------------------- */
/*                               Domain Typings                               */
/* -------------------------------------------------------------------------- */

/**
 * Enumeration of the high-level monitoring events that
 * downstream adapters may listen for.
 */
export enum MonitoringEventType {
    KPI_DRIFT_DETECTED = 'KPI_DRIFT_DETECTED',
    DATA_QUALITY_ISSUE = 'DATA_QUALITY_ISSUE',
    LATENCY_SLA_BREACH = 'LATENCY_SLA_BREACH',
}

/** Snapshot of a single KPI value at a given point in time. */
export interface MetricSnapshot {
    readonly name: string;
    readonly value: number;
    readonly timestamp: Date;
}

/** Evaluation outcome emitted by any metric monitor. */
export interface MonitoringResult {
    readonly eventType: MonitoringEventType | null;
    readonly message: string;
    /** Confidence score in [0, 1] for how certain we are that the issue is real. */
    readonly confidence: number;
    /** Raw metric payload for auditing / downstream processing. */
    readonly snapshot: MetricSnapshot;
}

/* -------------------------------------------------------------------------- */
/*                             Observer: Event Bus                            */
/* -------------------------------------------------------------------------- */

/** Central domain event bus (Observer pattern). */
export class MonitoringEventBus extends EventEmitter {
    private static instance: MonitoringEventBus;

    private constructor() {
        super();
        // Ensures we never exceed the Node default of 10 listeners.
        this.setMaxListeners(100);
    }

    /** Singleton accessor to keep a single bus per process. */
    public static getInstance(): MonitoringEventBus {
        if (!MonitoringEventBus.instance) {
            MonitoringEventBus.instance = new MonitoringEventBus();
        }
        return MonitoringEventBus.instance;
    }
}

/* -------------------------------------------------------------------------- */
/*                       Strategy: Remediation Behaviours                     */
/* -------------------------------------------------------------------------- */

/** Contextual information provided to remediation strategies. */
export interface RemediationContext {
    readonly modelName: string;
    readonly environment: 'dev' | 'staging' | 'prod';
    readonly result: MonitoringResult;
}

/** Strategy interface for post-monitoring remediation. */
export interface RemediationStrategy {
    /** Returns true if the strategy took a definitive action (e.g., paged on-call). */
    execute(ctx: RemediationContext): Promise<boolean>;
}

/** -------- Concrete Strategies ------------------------------------------- */

/** Simple strategy that only emits an event – no automatic action. */
export class AlertOnlyStrategy implements RemediationStrategy {
    async execute(ctx: RemediationContext): Promise<boolean> {
        const bus = MonitoringEventBus.getInstance();
        bus.emit('alert', {
            model: ctx.modelName,
            env: ctx.environment,
            message: ctx.result.message,
            severity: this.computeSeverity(ctx.result.confidence),
        });
        return true;
    }

    private computeSeverity(confidence: number): 'low' | 'medium' | 'high' {
        if (confidence > 0.8) return 'high';
        if (confidence > 0.5) return 'medium';
        return 'low';
    }
}

/** Automatic strategy that triggers a retraining pipeline. */
export class AutoRetrainStrategy implements RemediationStrategy {
    async execute(ctx: RemediationContext): Promise<boolean> {
        const bus = MonitoringEventBus.getInstance();

        // Step 1 – Notify dashboards.
        bus.emit('alert', {
            model: ctx.modelName,
            env: ctx.environment,
            message: `[AUTO-RETRAIN] ${ctx.result.message}`,
            severity: 'high',
        });

        // Step 2 – Emit domain event that the pipeline orchestrator listens to.
        bus.emit('trigger_retraining', {
            model: ctx.modelName,
            env: ctx.environment,
            reason: ctx.result.eventType,
        });

        return true;
    }
}

/** Hybrid strategy: alert immediately, auto-retrain if high confidence. */
export class HybridStrategy implements RemediationStrategy {
    constructor(private readonly confidenceThreshold: number = 0.85) {}

    async execute(ctx: RemediationContext): Promise<boolean> {
        await new AlertOnlyStrategy().execute(ctx);

        if (ctx.result.confidence >= this.confidenceThreshold) {
            return new AutoRetrainStrategy().execute(ctx);
        }
        return false;
    }
}

/* -------------------------------------------------------------------------- */
/*                 Strategy Factory – resolves at runtime by cfg              */
/* -------------------------------------------------------------------------- */

export type StrategyType = 'alert' | 'auto_retrain' | 'hybrid';

export class RemediationStrategyFactory {
    static build(type: StrategyType, extra?: Record<string, unknown>): RemediationStrategy {
        switch (type) {
            case 'alert':
                return new AlertOnlyStrategy();
            case 'auto_retrain':
                return new AutoRetrainStrategy();
            case 'hybrid':
                return new HybridStrategy(
                    typeof extra?.confidenceThreshold === 'number'
                        ? (extra.confidenceThreshold as number)
                        : undefined
                );
            default:
                // Exhaustive check for compile-time safety
                const _never: never = type;
                throw new Error(`Unsupported strategy: ${_never}`);
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                          Monitor Interfaces & Factory                      */
/* -------------------------------------------------------------------------- */

/** Monitor Interface (Port) – hexagon-friendly. */
export interface MetricMonitor {
    /**
     * Evaluate the last metric snapshot(s) and return a MonitoringResult
     * if an anomaly is detected; null otherwise.
     */
    evaluate(snapshots: MetricSnapshot[]): Promise<MonitoringResult | null>;
}

/** Drift detection based on simple POP shift (placeholder for real stats). */
export class DriftMonitor implements MetricMonitor {
    private readonly driftThreshold: number;

    constructor(params?: { driftThreshold?: number }) {
        this.driftThreshold = params?.driftThreshold ?? 0.2; // ±20% allowed
    }

    async evaluate(snapshots: MetricSnapshot[]): Promise<MonitoringResult | null> {
        if (snapshots.length < 2) return null;

        const latest = snapshots[snapshots.length - 1];
        const previous = snapshots[snapshots.length - 2];

        const delta = Math.abs(latest.value - previous.value) / (previous.value || 1);
        if (delta >= this.driftThreshold) {
            return {
                eventType: MonitoringEventType.KPI_DRIFT_DETECTED,
                message: `KPI "${latest.name}" drifted by ${(delta * 100).toFixed(2)}%`,
                confidence: Math.min(1, delta / this.driftThreshold), // crude confidence
                snapshot: latest,
            };
        }
        return null;
    }
}

/** Checks for % of missing or invalid inputs. */
export class DataQualityMonitor implements MetricMonitor {
    private readonly maxNullRate: number;

    constructor(params?: { maxNullRate?: number }) {
        this.maxNullRate = params?.maxNullRate ?? 0.05; // 5% default
    }

    async evaluate(snapshots: MetricSnapshot[]): Promise<MonitoringResult | null> {
        const latest = snapshots[snapshots.length - 1];
        const nullRate = latest.value; // here value == %nulls

        if (nullRate > this.maxNullRate) {
            return {
                eventType: MonitoringEventType.DATA_QUALITY_ISSUE,
                message: `Null rate ${(nullRate * 100).toFixed(
                    1
                )}% exceeds allowed ${(this.maxNullRate * 100).toFixed(1)}%`,
                confidence: Math.min(1, nullRate / this.maxNullRate),
                snapshot: latest,
            };
        }
        return null;
    }
}

/** SLA monitor for inference latency. */
export class LatencyMonitor implements MetricMonitor {
    constructor(private readonly slaMs: number) {}

    async evaluate(snapshots: MetricSnapshot[]): Promise<MonitoringResult | null> {
        const latest = snapshots[snapshots.length - 1];
        if (latest.value > this.slaMs) {
            const overage = latest.value - this.slaMs;
            return {
                eventType: MonitoringEventType.LATENCY_SLA_BREACH,
                message: `Latency ${latest.value}ms exceeded SLA by ${overage}ms`,
                confidence: 1,
                snapshot: latest,
            };
        }
        return null;
    }
}

export interface MonitorFactoryParams {
    type: 'drift' | 'data_quality' | 'latency';
    params?: Record<string, unknown>;
}

export class MetricMonitorFactory {
    static build(cfg: MonitorFactoryParams): MetricMonitor {
        switch (cfg.type) {
            case 'drift':
                return new DriftMonitor({
                    driftThreshold: (cfg.params?.driftThreshold as number) ?? undefined,
                });
            case 'data_quality':
                return new DataQualityMonitor({
                    maxNullRate: (cfg.params?.maxNullRate as number) ?? undefined,
                });
            case 'latency':
                const sla = cfg.params?.slaMs as number;
                if (typeof sla !== 'number' || isNaN(sla)) {
                    throw new Error('Latency monitor requires numeric slaMs param');
                }
                return new LatencyMonitor(sla);
            default:
                const _never: never = cfg.type;
                throw new Error(`Unknown monitor type: ${_never}`);
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                         Core Service: Model Monitoring                     */
/* -------------------------------------------------------------------------- */

export interface ModelMonitoringServiceConfig {
    readonly modelName: string;
    readonly environment: 'dev' | 'staging' | 'prod';
    readonly monitors: MonitorFactoryParams[];
    readonly remediationStrategy: { type: StrategyType; extra?: Record<string, unknown> };
    /** Polling interval in milliseconds for pulling new metric snapshots.  */
    readonly pollingIntervalMs?: number;
    /** Function that fetches new snapshots from whichever storage (adapter). */
    fetchSnapshots(metricName: string): Promise<MetricSnapshot[]>;
}

/**
 * Hexagon-resident monitoring orchestrator.
 * Periodically polls metric snapshots, evaluates monitors, and
 * delegates to the injected remediation strategy.
 */
export class ModelMonitoringService {
    private readonly monitors: MetricMonitor[];
    private readonly strategy: RemediationStrategy;
    private readonly bus = MonitoringEventBus.getInstance();
    private timerHandle: NodeJS.Timer | null = null;

    constructor(private readonly cfg: ModelMonitoringServiceConfig) {
        this.monitors = cfg.monitors.map((m) => MetricMonitorFactory.build(m));
        this.strategy = RemediationStrategyFactory.build(
            cfg.remediationStrategy.type,
            cfg.remediationStrategy.extra
        );
    }

    public start(): void {
        if (this.timerHandle) return; // Already running
        const interval = this.cfg.pollingIntervalMs ?? 60_000; // default 1 minute
        this.timerHandle = setInterval(() => this.tick().catch(this.handleError), interval);

        // Fire a bootstrap event for observers to wire themselves.
        this.bus.emit('monitoring_service_started', {
            model: this.cfg.modelName,
            env: this.cfg.environment,
            intervalMs: interval,
        });
    }

    public stop(): void {
        if (this.timerHandle) {
            clearInterval(this.timerHandle);
            this.timerHandle = null;
            this.bus.emit('monitoring_service_stopped', {
                model: this.cfg.modelName,
                env: this.cfg.environment,
            });
        }
    }

    private async tick(): Promise<void> {
        for (const monitor of this.monitors) {
            const metricName = this.identifyMetricName(monitor);
            const snapshots = await this.cfg.fetchSnapshots(metricName);
            const result = await monitor.evaluate(snapshots);

            if (result) {
                // 1. Emit domain event for outside observers.
                this.bus.emit(result.eventType, {
                    model: this.cfg.modelName,
                    env: this.cfg.environment,
                    ...result,
                });

                // 2. Delegate to remediation strategy.
                await this.strategy.execute({
                    modelName: this.cfg.modelName,
                    environment: this.cfg.environment,
                    result,
                });
            }
        }
    }

    /** Attempt to derive a user-friendly metric name based on class. */
    private identifyMetricName(monitor: MetricMonitor): string {
        if (monitor instanceof DriftMonitor) return 'prediction_drift';
        if (monitor instanceof DataQualityMonitor) return 'null_ratio';
        if (monitor instanceof LatencyMonitor) return 'inference_latency';
        return 'unknown_metric';
    }

    private handleError = (err: unknown): void => {
        const error = err instanceof Error ? err : new Error(String(err));
        // Emit but never crash the core; monitoring should be resilient.
        this.bus.emit('monitoring_error', {
            model: this.cfg.modelName,
            env: this.cfg.environment,
            message: error.message,
            stack: error.stack,
        });
    };
}

/* -------------------------------------------------------------------------- */
/*                             Example Bootstrap                              */
/* -------------------------------------------------------------------------- */
/**
 * Example adapter demonstrating how the hexagon would be invoked.
 * In real life, this would live in an outer layer (e.g., src/adapters/…).
 */
if (require.main === module) {
    // Dummy in-memory metric storage
    const store: Record<string, MetricSnapshot[]> = {
        prediction_drift: [
            { name: 'prediction_drift', value: 0.05, timestamp: new Date(Date.now() - 60_000) },
            { name: 'prediction_drift', value: 0.32, timestamp: new Date() },
        ],
        null_ratio: [{ name: 'null_ratio', value: 0.01, timestamp: new Date() }],
        inference_latency: [{ name: 'inference_latency', value: 180, timestamp: new Date() }],
    };

    const monitoringService = new ModelMonitoringService({
        modelName: 'customer_churn_v7',
        environment: 'prod',
        monitors: [
            { type: 'drift', params: { driftThreshold: 0.25 } },
            { type: 'latency', params: { slaMs: 150 } },
        ],
        remediationStrategy: { type: 'hybrid', extra: { confidenceThreshold: 0.9 } },
        pollingIntervalMs: 5_000,
        fetchSnapshots: async (metricName: string) => store[metricName] ?? [],
    });

    // Simple console observer
    const bus = MonitoringEventBus.getInstance();
    bus.on(MonitoringEventType.KPI_DRIFT_DETECTED, console.log);
    bus.on(MonitoringEventType.LATENCY_SLA_BREACH, console.log);
    bus.on('alert', console.log);
    bus.on('trigger_retraining', console.log);
    bus.on('monitoring_error', console.error);

    monitoringService.start();

    // Graceful shutdown
    process.on('SIGINT', () => {
        monitoringService.stop();
        process.exit(0);
    });
}
```