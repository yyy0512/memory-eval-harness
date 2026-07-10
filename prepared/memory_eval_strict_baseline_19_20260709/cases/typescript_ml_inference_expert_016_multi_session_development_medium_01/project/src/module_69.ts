```typescript
/**************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:         src/module_69.ts
 *  Responsibility:
 *      • Domain-centric KPI drift detection service that raises alerts whenever statistically
 *        significant changes are detected in critical business metrics.
 *      • Implements Strategy Pattern (multiple drift-detection algorithms) and Factory Pattern to
 *        select the correct algorithm at runtime.
 *      • Follows Hexagonal Architecture: core service is decoupled from IO by well-defined ports.
 *
 *  NOTE:
 *      • This file is fully functional and self-contained; external adapters can be swapped in
 *        without touching business logic.
 **************************************************************************************************/

/* ---------------------------------  External Imports  ---------------------------------- */
import { EventEmitter } from 'events';

/* ----------------------------------  Domain Models  ----------------------------------- */

/**
 * Represents a single KPI observation at a point in time.
 */
export interface KPIReading {
    readonly kpiName: string;
    readonly timestamp: Date;
    readonly value: number;
}

/**
 * Alert emitted when KPI drift is detected.
 */
export interface DriftAlert {
    readonly kpiName: string;
    readonly severity: 'low' | 'medium' | 'high';
    readonly detector: string;                                   // Which strategy triggered the alert
    readonly pValue: number;                                     // Statistical significance
    readonly message: string;
    readonly occurredAt: Date;
}

/* ------------------------------------  Ports  ----------------------------------------- */

/**
 * Port for retrieving KPI time-series data; implemented by infrastructure adapters.
 */
export interface KPIMonitoringPort {
    /**
     * Fetches a historic reference sample (e.g., last 30 days) used for baseline.
     */
    getReferenceWindow(kpiName: string): Promise<number[]>;

    /**
     * Fetches the most recent sample window (e.g., last 24 hours) for comparison.
     */
    getCurrentWindow(kpiName: string): Promise<number[]>;
}

/**
 * Port for sending alerts to downstream systems (Slack, PagerDuty, etc.).
 */
export interface AlertingPort {
    sendAlert(alert: DriftAlert): Promise<void>;
}

/* -----------------------------  Strategy Pattern: DriftDetector ------------------------ */

/**
 * Strategy interface for drift-detection algorithms.
 */
export interface DriftDetector {
    readonly name: string;

    /**
     * Computes whether drift exists between reference and current distributions.
     *
     * Returns:
     *      • DriftAlert if drift is found beyond the configured threshold
     *      • null otherwise
     *
     * Throws:
     *      • Error if inputs are invalid or calculations fail
     */
    detect(kpiName: string, reference: number[], current: number[]): DriftAlert | null;
}

/**
 * Utility function to compute empirical CDF at each sorted point.
 */
const empiricalCDF = (sample: number[]): { x: number[]; cdf: number[] } => {
    const sorted = [...sample].sort((a, b) => a - b);
    const n = sorted.length;
    const cdf = sorted.map((_, i) => (i + 1) / n);
    return { x: sorted, cdf };
};

/**
 * Kolmogorov–Smirnov drift detector (two-sample KS test).
 */
class KolmogorovSmirnovDetector implements DriftDetector {
    public readonly name = 'kolmogorov-smirnov';

    constructor(private readonly alpha: number = 0.05) {}

    detect(kpiName: string, reference: number[], current: number[]): DriftAlert | null {
        if (!reference.length || !current.length) {
            throw new Error(`[${this.name}] Both reference and current windows must be non-empty.`);
        }

        const { x: refX, cdf: refCDF } = empiricalCDF(reference);
        const { x: curX, cdf: curCDF } = empiricalCDF(current);

        // Merge sorted values to evaluate the CDFs at combined support
        const combined = [...new Set([...refX, ...curX])].sort((a, b) => a - b);
        let d = 0;

        for (const val of combined) {
            const refProb = refCDF[refX.findIndex(v => v >= val)] ?? 1;
            const curProb = curCDF[curX.findIndex(v => v >= val)] ?? 1;
            d = Math.max(d, Math.abs(refProb - curProb));
        }

        const n = reference.length;
        const m = current.length;
        const en = Math.sqrt((n * m) / (n + m));
        const critical = 1.36 / en; // Approximation for alpha=0.05

        if (d > critical) {
            const severity: DriftAlert['severity'] =
                d > critical * 1.5 ? 'high' : d > critical * 1.2 ? 'medium' : 'low';

            return {
                kpiName,
                severity,
                detector: this.name,
                pValue: Math.exp(-2 * (en * d) ** 2), // Massey approximation
                message: `KPI "${kpiName}" drift detected (KS-stat ${d.toFixed(
                    4,
                )} > critical ${critical.toFixed(4)}).`,
                occurredAt: new Date(),
            };
        }

        return null;
    }
}

/**
 * Population Stability Index drift detector (PSI).
 */
class PopulationStabilityIndexDetector implements DriftDetector {
    public readonly name = 'population-stability-index';

    constructor(
        private readonly bucketCount: number = 10,
        private readonly threshold: number = 0.2,
    ) {}

    detect(kpiName: string, reference: number[], current: number[]): DriftAlert | null {
        if (!reference.length || !current.length) {
            throw new Error(`[${this.name}] Both reference and current windows must be non-empty.`);
        }

        // Determine bin edges from reference distribution
        const sorted = [...reference].sort((a, b) => a - b);
        const edges: number[] = [];
        const step = sorted.length / this.bucketCount;

        for (let i = 1; i < this.bucketCount; i++) {
            edges.push(sorted[Math.floor(i * step)]);
        }
        edges.push(Number.POSITIVE_INFINITY); // last edge

        const refCounts = new Array(this.bucketCount).fill(0);
        const curCounts = new Array(this.bucketCount).fill(0);

        // Populate counts
        for (const val of reference) {
            const idx = edges.findIndex(edge => val <= edge);
            if (idx >= 0) refCounts[idx]++;
        }
        for (const val of current) {
            const idx = edges.findIndex(edge => val <= edge);
            if (idx >= 0) curCounts[idx]++;
        }

        const nRef = reference.length;
        const nCur = current.length;

        let psi = 0;
        for (let i = 0; i < this.bucketCount; i++) {
            const refProp = refCounts[i] / nRef || 1e-6;
            const curProp = curCounts[i] / nCur || 1e-6;
            psi += (curProp - refProp) * Math.log(curProp / refProp);
        }

        if (psi > this.threshold) {
            const severity: DriftAlert['severity'] =
                psi > this.threshold * 2 ? 'high' : psi > this.threshold * 1.5 ? 'medium' : 'low';
            return {
                kpiName,
                severity,
                detector: this.name,
                pValue: Number.NaN, // PSI is not a p-value-based test
                message: `KPI "${kpiName}" drift detected (PSI=${psi.toFixed(4)} > threshold ${this.threshold}).`,
                occurredAt: new Date(),
            };
        }

        return null;
    }
}

/* -------------------------------  Factory Pattern  ------------------------------------ */

interface DriftDetectorConfig {
    type: 'ks' | 'psi';
    params?: Record<string, unknown>;
}

class DriftDetectorFactory {
    static create(config: DriftDetectorConfig): DriftDetector {
        switch (config.type) {
            case 'ks':
                return new KolmogorovSmirnovDetector(
                    (config.params?.alpha as number | undefined) ?? 0.05,
                );
            case 'psi':
                return new PopulationStabilityIndexDetector(
                    (config.params?.bucketCount as number | undefined) ?? 10,
                    (config.params?.threshold as number | undefined) ?? 0.2,
                );
            default:
                throw new Error(`Unsupported detector type "${config.type}"`);
        }
    }
}

/* --------------------------  Observer Pattern: Event Bus  ----------------------------- */

/**
 * Domain event bus dedicated to KPI monitoring.
 * Consumers can subscribe to "alert" events for real-time notifications.
 */
export const kpiEventBus = new EventEmitter();

/* -------------------------  Core Service: KPI Monitoring  ----------------------------- */

export class KPIModelMonitorService {
    private readonly detectors: ReadonlyArray<DriftDetector>;

    constructor(
        private readonly kpiMonitoringPort: KPIMonitoringPort,
        private readonly alertingPort: AlertingPort,
        detectorConfigs: DriftDetectorConfig[],
    ) {
        if (!detectorConfigs.length) {
            throw new Error('At least one drift-detector configuration must be provided.');
        }
        this.detectors = detectorConfigs.map(DriftDetectorFactory.create);
    }

    /**
     * Checks drift for the specified KPI using all configured strategies.
     */
    async checkKPIDrift(kpiName: string): Promise<void> {
        try {
            const [reference, current] = await Promise.all([
                this.kpiMonitoringPort.getReferenceWindow(kpiName),
                this.kpiMonitoringPort.getCurrentWindow(kpiName),
            ]);

            for (const detector of this.detectors) {
                const alert = detector.detect(kpiName, reference, current);
                if (alert) {
                    // Emit event for observers inside the hexagon
                    kpiEventBus.emit('alert', alert);
                    // Notify external systems
                    await this.alertingPort.sendAlert(alert);
                    // Assuming we only need to notify once per strategy; continue looping for other detectors
                }
            }
        } catch (err) {
            // Fail fast yet traceably; in production we'd wire this to structured logging
            console.error(`[KPIModelMonitorService] Error while checking drift for "${kpiName}":`, err);
        }
    }
}

/* -----------------------  Reference Adapters (In-Memory)  ------------------------------ */

/**
 * Naïve in-memory adapter for KPIMonitoringPort (for demo/unit-test usage only).
 */
export class InMemoryKPIMonitoringAdapter implements KPIMonitoringPort {
    private readonly store: Record<string, number[]> = {};

    constructor(seed: Record<string, number[]>) {
        this.store = seed;
    }

    async getReferenceWindow(kpiName: string): Promise<number[]> {
        // Clone to protect encapsulation
        return [...(this.store[kpiName] ?? [])];
    }

    async getCurrentWindow(kpiName: string): Promise<number[]> {
        // For demonstration, returns last 10% of data or random noise if missing
        const data = this.store[kpiName] ?? [];
        const start = Math.floor(data.length * 0.9);
        return [...data.slice(start)];
    }
}

/**
 * Console-based alerting adapter useful during development.
 */
export class ConsoleAlertingAdapter implements AlertingPort {
    async sendAlert(alert: DriftAlert): Promise<void> {
        // In reality, this would integrate with Slack/PagerDuty
        console.warn(
            `[ALERT][${alert.severity.toUpperCase()}] ${alert.message} (detector=${alert.detector}, p=${
                isNaN(alert.pValue) ? 'n/a' : alert.pValue.toExponential(2)
            })`,
        );
    }
}

/* ------------------------------------  Example Usage ---------------------------------- */

if (require.main === module) {
    // Only execute when this file is run directly (not imported)
    (async () => {
        // Mock KPI values: reference is normal(100, 5), current is shifted
        const generateSamples = (mean: number, stdDev: number, n: number) =>
            Array.from({ length: n }, () => mean + stdDev * (Math.random() * 2 - 1));

        const kpiData = generateSamples(100, 5, 1000).concat(generateSamples(120, 5, 100)); // shift +20

        const monitoringPort = new InMemoryKPIMonitoringAdapter({ revenue_per_user: kpiData });
        const alertingPort = new ConsoleAlertingAdapter();

        const monitorService = new KPIModelMonitorService(
            monitoringPort,
            alertingPort,
            [
                { type: 'ks', params: { alpha: 0.05 } },
                { type: 'psi', params: { bucketCount: 10, threshold: 0.2 } },
            ],
        );

        // Subscribe an observer to log alerts internally
        kpiEventBus.on('alert', (alert: DriftAlert) => {
            console.log(
                `[Observer] Drift alert received for ${alert.kpiName}: severity=${alert.severity}`,
            );
        });

        // Check KPI drift; in production this would be scheduled (e.g., cron or Airflow)
        await monitorService.checkKPIDrift('revenue_per_user');
    })();
}
```
