```typescript
/**************************************************************************************************
 * InsightHexaAI — Strategic ML Inference Suite for Enterprise KPIs
 * File:        src/module_77.ts
 * Module:      KPI Drift Monitoring (Observer Pattern & Strategy Pattern)
 *
 * Rationale:
 *   Production‐grade, domain‐centric implementation that continuously observes KPI streams emitted
 *   by inference services.  Detects statistical drift, classifies severity via pluggable strategies,
 *   and dispatches downstream notifications (dashboards, audit trails, auto‐retraining triggers).
 *
 * Architectural notes:
 *   • ObserverPattern: KPIEventBus (Subject) + multiple concrete observers.
 *   • StrategyPattern: SeverityStrategy is interchangeable (e.g., z‐score, KS‐test, MMD, etc.).
 *   • FactoryPattern: SeverityStrategyFactory wires runtime strategy selection from config/flags.
 *
 * External dependencies are purposefully lightweight (Node.js stdlib only) so that the core
 *   business logic remains testable without external services.
 **************************************************************************************************/

// ────────────────────────────────────────────────────────────────────────────────
// Imports
// ────────────────────────────────────────────────────────────────────────────────
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';

// ────────────────────────────────────────────────────────────────────────────────
// Domain Types & Utilities
// ────────────────────────────────────────────────────────────────────────────────

/** High-level KPI buckets that the platform cares about. */
export enum KPIType {
    CLV = 'customer_lifetime_value',
    CHURN = 'churn_probability',
    CONVERSION_RATE = 'conversion_rate',
    REVENUE_PREDICTION = 'revenue_prediction',
}

/** Immutable KPI event payload published by inference services. */
export interface KPIEvent {
    readonly timestamp: number;           // epoch millis
    readonly kpi: KPIType;                // KPI bucket
    readonly modelVersion: string;        // ex: '2024-Q2-prod-6789abc'
    readonly environment: 'prod' | 'staging' | 'dev';
    readonly value: number;               // numeric KPI value
    readonly baseline: number;            // historic/expected KPI value
}

/** Result of severity classification. */
export interface SeverityResult {
    readonly severity: 'LOW' | 'MEDIUM' | 'HIGH';
    readonly delta: number;               // relative delta (e.g., ‑0.12)
}

/** Observer interface — reacts to KPI events & their classified severity. */
export interface KPIObserver {
    onDrift(event: KPIEvent, severity: SeverityResult): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────────
// Severity Strategy Pattern
// ────────────────────────────────────────────────────────────────────────────────

/** Strategy contract for severity calculation algorithms. */
export interface SeverityStrategy {
    classify(event: KPIEvent): SeverityResult;
}

/** Default z-score based implementation (simplified for example). */
class ZScoreSeverityStrategy implements SeverityStrategy {
    private readonly thresholdLow = 1.0;   // 1σ
    private readonly thresholdHigh = 2.0;  // 2σ

    classify(event: KPIEvent): SeverityResult {
        const delta = (event.value - event.baseline) / (event.baseline || 1); // prevent ÷0
        const absDelta = Math.abs(delta);

        if (absDelta >= this.thresholdHigh) {
            return { severity: 'HIGH', delta };
        }
        if (absDelta >= this.thresholdLow) {
            return { severity: 'MEDIUM', delta };
        }
        return { severity: 'LOW', delta };
    }
}

/** Factory for configurable strategy instantiation. */
export class SeverityStrategyFactory {
    static create(strategyName?: string): SeverityStrategy {
        switch (strategyName?.toLowerCase()) {
            case 'zscore':
            case undefined: // default
                return new ZScoreSeverityStrategy();

            // Future: add 'kstest', 'mmd', etc.
            default:
                throw new Error(`Unsupported severity strategy: ${strategyName}`);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────────
// KPI Event Bus (Subject in Observer Pattern)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around EventEmitter with typed publish/subscribe helpers so that
 *   business code remains decoupled from Node’s EventEmitter internals.
 */
export class KPIEventBus {
    private readonly emitter = new EventEmitter({ captureRejections: true });

    publish(event: KPIEvent): void {
        this.emitter.emit('kpi', event);
    }

    subscribe(listener: (evt: KPIEvent) => void): void {
        this.emitter.on('kpi', listener);
    }

    unsubscribe(listener: (evt: KPIEvent) => void): void {
        this.emitter.off('kpi', listener);
    }
}

// ────────────────────────────────────────────────────────────────────────────────
// Concrete Observers
// ────────────────────────────────────────────────────────────────────────────────

/** Persists HIGH/MEDIUM severity events to an append-only audit trail file. */
export class AuditTrailObserver implements KPIObserver {
    private readonly auditFile: string;

    constructor(auditDirectory: string = '.audit') {
        this.auditFile = path.join(auditDirectory, 'kpi_drift_audit.jsonl');
    }

    async onDrift(event: KPIEvent, severity: SeverityResult): Promise<void> {
        if (severity.severity === 'LOW') return;

        const line = JSON.stringify({ ...event, ...severity }) + '\n';
        try {
            await fs.mkdir(path.dirname(this.auditFile), { recursive: true });
            await fs.appendFile(this.auditFile, line, 'utf8');
        } catch (err) {
            // Production: replace console.error with centralized logger
            console.error('[AuditTrailObserver] Failed to persist audit trail.', err);
        }
    }
}

/** Emits web‐socket compatible payloads to dashboards in real time. */
export class DashboardObserver implements KPIObserver {
    constructor(private readonly send: (payload: unknown) => Promise<void>) {}

    async onDrift(event: KPIEvent, severity: SeverityResult): Promise<void> {
        try {
            await this.send({
                type: 'KPI_DRIFT',
                payload: { event, severity },
            });
        } catch (err) {
            console.error('[DashboardObserver] Failed to push dashboard event.', err);
        }
    }
}

/** Triggers automatic model retraining pipeline for HIGH severity drift. */
export class RetrainingObserver implements KPIObserver {
    constructor(private readonly retrain: (modelVersion: string) => Promise<void>) {}

    async onDrift(event: KPIEvent, severity: SeverityResult): Promise<void> {
        if (severity.severity !== 'HIGH') return;

        try {
            await this.retrain(event.modelVersion);
        } catch (err) {
            console.error('[RetrainingObserver] Failed to trigger retraining.', err);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────────
// Composition Root — “wire‐up” for runtime usage
// ────────────────────────────────────────────────────────────────────────────────

/**
 * KPIWatcher orchestrates subscription lifecycle and delegates drift detection.
 * Consumers (e.g., CLI, HTTP server, Kafka adapter) instantiate this once.
 */
export class KPIWatcher {
    private readonly strategy: SeverityStrategy;
    private readonly observers: KPIObserver[] = [];

    constructor(
        private readonly bus: KPIEventBus,
        strategyName?: string,
    ) {
        this.strategy = SeverityStrategyFactory.create(strategyName);
        this.bus.subscribe(this.handleEvent);
    }

    /** Dependency injection for observers. */
    registerObserver(observer: KPIObserver): void {
        this.observers.push(observer);
    }

    /** Unsubscribes from the EventBus and cleans up resources. */
    dispose(): void {
        this.bus.unsubscribe(this.handleEvent);
    }

    // Bound arrow fn so we can safely unsubscribe
    private readonly handleEvent = (event: KPIEvent): void => {
        try {
            const severity = this.strategy.classify(event);
            void Promise.all(
                this.observers.map((obs) => obs.onDrift(event, severity)),
            );
        } catch (err) {
            console.error('[KPIWatcher] Failed handling KPI event.', err);
        }
    };
}

// ────────────────────────────────────────────────────────────────────────────────
// Example Usage (would typically live in an adapter layer, not core module)
// ────────────────────────────────────────────────────────────────────────────────

/* istanbul ignore next — illustrative bootstrap code */
if (require.main === module) {
    const bus = new KPIEventBus();
    const watcher = new KPIWatcher(bus, 'zscore');

    // Wire observers
    watcher.registerObserver(new AuditTrailObserver());
    watcher.registerObserver(
        new DashboardObserver(async (payload) => {
            // For demo: log instead of real web-socket push
            console.info('[Dashboard] ', JSON.stringify(payload));
        }),
    );
    watcher.registerObserver(
        new RetrainingObserver(async (modelVersion) => {
            console.info(`[Retraining] Triggered for model ${modelVersion}.`);
        }),
    );

    // Simulate streaming KPI data
    setInterval(() => {
        const sample: KPIEvent = {
            timestamp: Date.now(),
            kpi: KPIType.CLV,
            modelVersion: '2024-Q2-prod-6789abc',
            environment: 'prod',
            value: Math.random() * 100,
            baseline: 50,
        };
        bus.publish(sample);
    }, 1_000);

    // Clean exit after demonstration window
    setTimeout(() => {
        watcher.dispose();
        process.exit(0);
    }, 10_000);
}
```
