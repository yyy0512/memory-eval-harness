```typescript
/***************************************************************************************************
 *  InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *  File: src/module_30.ts
 *
 *  Module: Real-time KPI Monitor (Observer + Strategy + Factory Patterns)
 *  Responsibility:
 *      • Collect streaming KPI measurements produced by model-serving adapters
 *      • Detect SLA breaches / statistical drifts with pluggable threshold strategies
 *      • Notify downstream adapters (e-mail, Slack, PagerDuty, etc.) through Observer pattern
 *
 *  NOTE: This file is self-contained; external dependencies referenced via import statements
 *  are assumed to exist elsewhere in the code-base (hexagonal adapters, domain services, etc.).
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { z } from 'zod'; // Runtime validation for config objects
import {
    LoggerPort,               // Hexagonal port – logging adapter
    NotificationPort,         // Hexagonal port – generic notification adapter
    MetricRepositoryPort,     // Hexagonal port – time-series storage adapter
} from './ports';             // <- Domain ports live in src/ports/index.ts (not shown)

/**
 * Domain-level value objects & types
 * -------------------------------------------------------------------------- */
export type KpiName = string;

export interface MetricSnapshot {
    readonly kpi: KpiName;
    readonly timestamp: Date;
    readonly value: number;
}

/**
 * Observer Pattern Contracts
 * -------------------------------------------------------------------------- */
export interface KpiDriftEvent {
    readonly kpi: KpiName;
    readonly currentValue: number;
    readonly expectedValue: number;
    readonly breached: boolean;
    readonly reason: string;
    readonly timestamp: Date;
}

export interface KpiObserver {
    update(event: KpiDriftEvent): Promise<void>;
}

/**
 * Strategy Pattern Contracts
 * -------------------------------------------------------------------------- */
export interface ThresholdStrategy {
    /**
     * Returns true if KPI value is considered a breach when compared to the baseline.
     */
    isBreach(options: {
        readonly current: number;
        readonly baseline: number;
    }): boolean;

    /**
     * Human-readable description of why a value is labelled breach / healthy.
     */
    explain(options: {
        readonly current: number;
        readonly baseline: number;
    }): string;
}

/**
 * Concrete Threshold Strategies
 * -------------------------------------------------------------------------- */
export class PercentageThresholdStrategy implements ThresholdStrategy {
    constructor(private readonly maxDeltaPercent: number) {
        if (maxDeltaPercent <= 0) {
            throw new Error('maxDeltaPercent must be positive.');
        }
    }

    isBreach({ current, baseline }: { current: number; baseline: number }): boolean {
        if (baseline === 0) return true; // Div/0 guard – automatically breach
        const delta = Math.abs((current - baseline) / baseline) * 100;
        return delta > this.maxDeltaPercent;
    }

    explain({ current, baseline }: { current: number; baseline: number }): string {
        const delta = baseline === 0 ? 100 : Math.abs((current - baseline) / baseline) * 100;
        return `Current = ${current.toFixed(
            4,
        )}, Baseline = ${baseline.toFixed(
            4,
        )}, Δ = ${delta.toFixed(2)}% (max allowed ${this.maxDeltaPercent}%)`;
    }
}

export class AbsoluteThresholdStrategy implements ThresholdStrategy {
    constructor(private readonly maxDelta: number) {
        if (maxDelta <= 0) {
            throw new Error('maxDelta must be positive.');
        }
    }

    isBreach({ current, baseline }: { current: number; baseline: number }): boolean {
        return Math.abs(current - baseline) > this.maxDelta;
    }

    explain({ current, baseline }: { current: number; baseline: number }): string {
        const delta = Math.abs(current - baseline);
        return `Current = ${current.toFixed(
            4,
        )}, Baseline = ${baseline.toFixed(4)}, Δ = ${delta.toFixed(
            4,
        )} (max allowed ${this.maxDelta})`;
    }
}

/**
 * Factory Pattern – resolves a strategy from config
 * -------------------------------------------------------------------------- */
export type ThresholdStrategyKind = 'percentage' | 'absolute';

export interface ThresholdStrategyConfig {
    readonly kind: ThresholdStrategyKind;
    readonly value: number; // % or absolute value depending on kind
}

export class ThresholdStrategyFactory {
    private static readonly ConfigSchema = z.object({
        kind: z.enum(['percentage', 'absolute']),
        value: z.number().positive(),
    });

    public static create(config: ThresholdStrategyConfig): ThresholdStrategy {
        // Runtime validation → throws if config shape invalid
        ThresholdStrategyFactory.ConfigSchema.parse(config);

        switch (config.kind) {
            case 'percentage':
                return new PercentageThresholdStrategy(config.value);
            case 'absolute':
                return new AbsoluteThresholdStrategy(config.value);
            default:
                // Exhaustive check
                /* istanbul ignore next */
                throw new Error(`Unsupported threshold strategy: ${config.kind}`);
        }
    }
}

/**
 * Core Service – KPI Monitor
 * -------------------------------------------------------------------------- */
export interface KpiMonitorOptions {
    readonly baselineRepository: MetricRepositoryPort;
    readonly observers: ReadonlyArray<KpiObserver>;
    readonly logger: LoggerPort;
    readonly strategyConfig: ThresholdStrategyConfig;
    readonly samplingWindowMs?: number; // default: 5 minutes
}

/**
 * KpiMonitor – orchestrates metric sampling, drift detection and notifications.
 * Non-blocking design: internal EventEmitter decouples collection from processing.
 */
export class KpiMonitor {
    private readonly strategy: ThresholdStrategy;
    private readonly eventBus = new EventEmitter();
    private readonly samplingWindowMs: number;

    // Guard for excessive listeners; we expect configurable #observers
    private static readonly MAX_LISTENERS = 20;

    constructor(private readonly opts: KpiMonitorOptions) {
        this.strategy = ThresholdStrategyFactory.create(opts.strategyConfig);
        this.samplingWindowMs = opts.samplingWindowMs ?? 5 * 60 * 1000;

        this.initObserverBridge();
        opts.logger.info(
            `KpiMonitor initialized – Strategy=${opts.strategyConfig.kind}, Value=${opts.strategyConfig.value}, Window=${this.samplingWindowMs}ms`,
        );
    }

    /**
     * Public API: ingest raw metric snapshots from external adapters.
     */
    public async ingest(snapshot: MetricSnapshot): Promise<void> {
        try {
            // Validate minimal sanity
            if (Number.isNaN(snapshot.value)) {
                throw new Error('Snapshot value must be numeric.');
            }

            // Emit internally, preserving async boundary
            this.eventBus.emit('metric', snapshot);
        } catch (err) {
            this.opts.logger.error(
                `Failed to ingest snapshot [kpi=${snapshot.kpi}] – ${String(err)}`,
            );
        }
    }

    /**
     * Wires EventEmitter → Observer[] pipeline. This keeps business logic self-contained
     * while allowing scalable number of observers (Slack, Datadog, etc.).
     */
    private initObserverBridge(): void {
        if (this.opts.observers.length > KpiMonitor.MAX_LISTENERS) {
            this.opts.logger.warn(
                `More than ${KpiMonitor.MAX_LISTENERS} observers registered; potential memory leak.`,
            );
        }

        // Setup metric event → drift detection
        this.eventBus.on('metric', async (snapshot: MetricSnapshot) => {
            await this.handleSnapshot(snapshot);
        });
    }

    /**
     * Core routine – fetch baseline, evaluate drift, broadcast.
     */
    private async handleSnapshot(snapshot: MetricSnapshot): Promise<void> {
        // Retrieve baseline for KPI within sampling window
        const since = new Date(snapshot.timestamp.getTime() - this.samplingWindowMs);
        const baseline = await this.opts.baselineRepository.getAverage(snapshot.kpi, since);

        if (baseline === null) {
            this.opts.logger.debug(
                `No baseline available for KPI "${snapshot.kpi}". Skipping drift detection.`,
            );
            return;
        }

        const breached = this.strategy.isBreach({
            current: snapshot.value,
            baseline,
        });

        if (!breached) return; // Fast return for healthy metrics

        // Build event payload
        const event: KpiDriftEvent = {
            kpi: snapshot.kpi,
            currentValue: snapshot.value,
            expectedValue: baseline,
            breached: true,
            reason: this.strategy.explain({
                current: snapshot.value,
                baseline,
            }),
            timestamp: snapshot.timestamp,
        };

        // Parallel broadcast → Promise.all settles all, allowing partial failures
        await Promise.all(
            this.opts.observers.map(async (observer) => {
                try {
                    await observer.update(event);
                } catch (err) {
                    this.opts.logger.error(
                        `Observer update failed for KPI "${snapshot.kpi}" – ${String(err)}`,
                    );
                }
            }),
        );
    }
}

/**
 * Example Implementation – ConsoleLoggerObserver
 * --------------------------------------------------------------------------
 * In real code each observer would live in its own adapter. Provided here for
 * demonstration and immediate usability.
 */
export class LoggerObserver implements KpiObserver {
    constructor(private readonly logger: LoggerPort, private readonly channel?: string) {}

    async update(event: KpiDriftEvent): Promise<void> {
        const msg = `[ALERT] KPI "${event.kpi}" breached at ${event.timestamp.toISOString()} – ${event.reason}`;
        if (this.channel) {
            this.logger.publish(msg, this.channel); // hypothetical method
        } else {
            this.logger.warn(msg);
        }
    }
}

/**
 * Example Implementation – NotificationObserver
 * --------------------------------------------------------------------------
 * Wraps NotificationPort (e.g., Slack or PagerDuty adapter).
 */
export class NotificationObserver implements KpiObserver {
    constructor(
        private readonly notifier: NotificationPort,
        private readonly severity: 'info' | 'warning' | 'critical' = 'critical',
    ) {}

    async update(event: KpiDriftEvent): Promise<void> {
        const payload = {
            title: `🚨 KPI Breach: ${event.kpi}`,
            text: event.reason,
            timestamp: event.timestamp,
            severity: this.severity,
        };

        await this.notifier.send(payload); // Implementation delegated to adapter
    }
}

/***************************************************************************************************
 *  Usage Example (would typically live in a composition root, not in this file)
 * -------------------------------------------------------------------------------------------------
 *
 *  const monitor = new KpiMonitor({
 *      baselineRepository: new InfluxMetricRepositoryAdapter(...),
 *      observers: [
 *          new LoggerObserver(consoleLogger),
 *          new NotificationObserver(slackAdapter, 'critical'),
 *      ],
 *      logger: consoleLogger,
 *      strategyConfig: { kind: 'percentage', value: 5 },
 *      samplingWindowMs: 10 * 60 * 1000, // 10 minutes
 *  });
 *
 *  // Somewhere inside Kafka consumer...
 *  monitor.ingest({
 *      kpi: 'conversion_rate',
 *      timestamp: new Date(),
 *      value: 0.0432,
 *  });
 ***************************************************************************************************/
```