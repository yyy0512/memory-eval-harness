```typescript
/*  ===========================================================================
    InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
    File: src/module_25.ts
    Purpose:
        Core-hexagon utilities for streaming KPI samples, detecting metric drift,
        and notifying external dashboards/alerting systems.  Exemplifies the
        Observer-Pattern and Strategy-Pattern working together inside the
        ports-and-adapters architecture.

    NOTE:
        • No framework dependencies—only RxJS for reactive streams and Axios for
          HTTP calls (both already widely used across the project).
        • All I/O (Slack webhook, etc.) is isolated in adapters so domain logic
          remains pure and unit-testable.
   ============================================================================ */

import axios, { AxiosError } from 'axios';
import { Subject, Observable, Subscription } from 'rxjs';
import { bufferTime, filter, map } from 'rxjs/operators';

/* ---------------------------------------------------------------------------
   Domain Models
---------------------------------------------------------------------------- */

export type MetricName = string;

/**
 * An individual observation of a numeric metric (e.g., revenue, latency).
 */
export interface MetricSample {
  metricName: MetricName;
  /** Unix epoch (ms) */
  timestamp: number;
  value: number;
}

/**
 * A domain event emitted when KPI drift is detected.
 */
export interface MetricDriftEvent {
  type: 'KPI_DRIFT';
  metricName: MetricName;
  baselineMean: number;
  currentMean: number;
  /** Human-readable root cause analysis (optional). */
  message?: string;
  /** When the drift was detected. */
  detectedAt: number;
}

/* ---------------------------------------------------------------------------
   MetricBus – central in-memory event bus (hexagon-internal)
---------------------------------------------------------------------------- */

/**
 * MetricBus is the single source of truth for streaming metric samples and
 * domain events within the hexagon.  External systems (Kafka, Snowflake, etc.)
 * interact only via adapters built on top of this bus.
 */
export class MetricBus {
  private readonly sample$ = new Subject<MetricSample>();
  private readonly event$ = new Subject<MetricDriftEvent>();

  /* -------------------------- Singleton Boilerplate ----------------------- */
  private static _instance: MetricBus | null = null;
  private constructor() {
    /* hide constructor */
  }
  public static get instance(): MetricBus {
    if (!MetricBus._instance) MetricBus._instance = new MetricBus();
    return MetricBus._instance;
  }

  /* ------------------------------ Samples --------------------------------- */

  /**
   * Publish a single metric sample.
   */
  emitSample(sample: MetricSample): void {
    this.sample$.next(sample);
  }

  /**
   * Listen to raw metric samples as an RxJS observable.
   */
  samples$(): Observable<MetricSample> {
    return this.sample$.asObservable();
  }

  /* ------------------------------- Events --------------------------------- */

  /**
   * Emit a domain event (e.g., KPI drift).
   */
  emitEvent(event: MetricDriftEvent): void {
    this.event$.next(event);
  }

  /**
   * Listen to domain events.
   */
  events$(): Observable<MetricDriftEvent> {
    return this.event$.asObservable();
  }
}

/* ---------------------------------------------------------------------------
   Strategy: WindowedMeanStrategy
   Calculates a rolling mean for a metric, configurable via window & filter fn.
---------------------------------------------------------------------------- */

export interface RollingMeanStrategyConfig {
  /** Time window in ms used to buffer samples. */
  windowMs: number;
  /** Optional minimum number of samples before statistics are calculated. */
  minSamples?: number;
}

/**
 * Strategy that converts a stream of MetricSample into a stream of rolling
 * means.  Uses RxJS bufferTime under the hood.
 */
export const buildWindowedMeanStrategy = (
  config: RollingMeanStrategyConfig,
  metricName: MetricName
): Observable<number> => {
  const { windowMs, minSamples = 5 } = config;

  return MetricBus.instance
    .samples$()
    .pipe(
      filter((sample) => sample.metricName === metricName),
      bufferTime(windowMs),
      filter((samples) => samples.length >= minSamples),
      map((samples) => {
        const sum = samples.reduce((acc, s) => acc + s.value, 0);
        return sum / samples.length;
      })
    );
};

/* ---------------------------------------------------------------------------
   KPIDriftDetector – Observer that identifies abnormal mean shifts.
---------------------------------------------------------------------------- */

export interface KPIDriftDetectorConfig {
  metricName: MetricName;
  baselineMean: number;
  /** Allowed % deviation before flagging drift (e.g., 0.1 = 10 %). */
  allowedRelativeDeviation: number;
  /** Rolling mean strategy configuration. */
  windowConfig: RollingMeanStrategyConfig;
}

/**
 * Observes a rolling mean stream and emits MetricDriftEvent when the mean
 * deviates outside the allowed bounds.
 */
export class KPIDriftDetector {
  private readonly subscription: Subscription;

  constructor(private readonly cfg: KPIDriftDetectorConfig) {
    const { metricName, baselineMean, allowedRelativeDeviation, windowConfig } =
      cfg;

    const rollingMean$ = buildWindowedMeanStrategy(windowConfig, metricName);

    this.subscription = rollingMean$.subscribe((currentMean) => {
      const deviation = Math.abs(currentMean - baselineMean) / baselineMean;
      if (deviation > allowedRelativeDeviation) {
        MetricBus.instance.emitEvent({
          type: 'KPI_DRIFT',
          metricName,
          baselineMean,
          currentMean,
          detectedAt: Date.now(),
          message: `Mean ${metricName} drifted by ${(deviation * 100).toFixed(
            2
          )}%`,
        });
      }
    });
  }

  /**
   * Stop listening for drift.
   */
  public dispose(): void {
    this.subscription.unsubscribe();
  }
}

/* ---------------------------------------------------------------------------
   Adapter: SlackNotifier – external observer for drift events
---------------------------------------------------------------------------- */

export interface SlackNotifierConfig {
  /** Slack Incoming Webhook URL */
  webhookUrl: string;
  /** Which metric names should be forwarded (others ignored). */
  watchlist?: MetricName[];
  /** HTTP timeout in ms */
  timeoutMs?: number;
}

/**
 * Sends KPI drift alerts to a Slack channel via Incoming Webhook.
 */
export class SlackNotifier {
  private readonly subscription: Subscription;

  constructor(private readonly cfg: SlackNotifierConfig) {
    const { watchlist } = cfg;

    this.subscription = MetricBus.instance
      .events$()
      .pipe(
        filter((evt) => (watchlist ? watchlist.includes(evt.metricName) : true))
      )
      .subscribe({
        next: (evt) => this.sendSlackMessage(evt),
        error: (err) =>
          /* eslint-disable no-console */
          console.error(
            '[SlackNotifier] Unhandled error in event stream:',
            err
          ),
      });
  }

  private async sendSlackMessage(evt: MetricDriftEvent): Promise<void> {
    const { webhookUrl, timeoutMs = 5_000 } = this.cfg;

    const payload = {
      text: `:rotating_light: *KPI Drift Detected* :rotating_light:\n` +
        `• *Metric*: ${evt.metricName}\n` +
        `• *Baseline mean*: ${evt.baselineMean.toFixed(3)}\n` +
        `• *Current mean*: ${evt.currentMean.toFixed(3)}\n` +
        `• *Deviation* : ${((
          Math.abs(evt.currentMean - evt.baselineMean) / evt.baselineMean
        ) * 100).toFixed(2)}%\n` +
        `• *Detected at*: ${new Date(evt.detectedAt).toISOString()}`,
    };

    try {
      await axios.post(webhookUrl, payload, { timeout: timeoutMs });
    } catch (error) {
      const err = error as AxiosError;
      // Log but never throw: notification failures must not crash core logic.
      console.error(
        `[SlackNotifier] Failed to send alert for ${evt.metricName}:`,
        err.message
      );
    }
  }

  /**
   * Clean up resources.
   */
  public dispose(): void {
    this.subscription.unsubscribe();
  }
}

/* ---------------------------------------------------------------------------
   Example bootstrap (would usually live in a DI container / IOC setup)
---------------------------------------------------------------------------- */

/**
 * This function is NOT executed automatically; it exists to demonstrate how
 * other modules could wire together the bus, detector, and notifier.
 */
export function exampleBootstrap(): void {
  /* Domain-side: start watching revenue metric for 5 % drift. */
  const detector = new KPIDriftDetector({
    metricName: 'monthly_recurring_revenue',
    baselineMean: 1_000_000, // $1M baseline
    allowedRelativeDeviation: 0.05, // 5 %
    windowConfig: { windowMs: 60_000, minSamples: 10 },
  });

  /* Adapter-side: push alerts to Slack. */
  const notifier = new SlackNotifier({
    webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '',
    watchlist: ['monthly_recurring_revenue'],
  });

  /* Simulate streaming samples (remove in production). */
  const interval = setInterval(() => {
    MetricBus.instance.emitSample({
      metricName: 'monthly_recurring_revenue',
      timestamp: Date.now(),
      value: 1_000_000 + Math.random() * 150_000, // ±15 %
    });
  }, 5_000);

  /* Dispose after 10 minutes to free resources in the example. */
  setTimeout(() => {
    clearInterval(interval);
    detector.dispose();
    notifier.dispose();
  }, 10 * 60 * 1_000);
}
```