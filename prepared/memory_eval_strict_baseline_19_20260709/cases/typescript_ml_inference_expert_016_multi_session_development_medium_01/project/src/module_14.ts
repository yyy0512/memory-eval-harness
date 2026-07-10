```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 *  File:        src/module_14.ts
 *  Description: KPI-drift monitoring core (hexagon) + adapters
 *               – Demonstrates Strategy, Factory, Observer patterns
 *               – Emits domain events whenever business-critical KPIs drift
 * ----------------------------------------------------------------
 *  NOTE:
 *  • External technologies (e.g. Kafka, Slack, PagerDuty) are only ADAPTERS.
 *  • Core domain logic is fully isolated and testable without IO.
 */

import { cloneDeep, isNumber } from 'lodash';
import { EventEmitter } from 'events';
import winston from 'winston';

/* ============================================================================
 *                          DOMAIN  ───────────────────────────────────────────
 * ==========================================================================*/

/**
 * Strongly-typed representation of a business KPI we care about.
 */
export interface KPI {
  readonly name: string;                                // e.g. "ARPU", "CLV", "ChurnRate"
  readonly unit: string;                                // e.g. "$", "ratio"
  readonly currentValue: number;                        // latest observed value
  readonly baselineValue: number;                       // expected or target value
  readonly metadata?: Record<string, unknown>;          // free-form contextual data
}

/**
 * Domain event emitted when a KPI breaches its configured drift threshold.
 */
export interface KPIDriftEvent {
  readonly kpi: KPI;
  readonly percentChange: number;                       // +25% or –12% deviation
  readonly timestamp: number;                           // Unix epoch ms
}

/* ============================================================================
 *                          STRATEGY  ─────────────────────────────────────────
 * ==========================================================================*/

/**
 * Strategy contract defining how to compute drift magnitude.
 */
export interface DriftComputationStrategy {
  /**
   * Calculates the percent change between baseline and current values.
   * Returns a value in range [-100, +∞).
   */
  computePercentChange(baseline: number, current: number): number;
}

/**
 * Default percentage-based drift computation.
 * percentChange = (current - baseline) / baseline * 100
 */
export class PercentageDriftStrategy implements DriftComputationStrategy {
  public computePercentChange(baseline: number, current: number): number {
    if (!isNumber(baseline) || !isNumber(current) || baseline === 0) {
      throw new Error('Invalid numeric input to PercentageDriftStrategy');
    }
    return ((current - baseline) / baseline) * 100;
  }
}

/**
 * Log-ratio based drift computation
 * percentChange = ln(current / baseline) * 100
 * Less sensitive to outliers when baseline ≈ 0.
 */
export class LogRatioDriftStrategy implements DriftComputationStrategy {
  public computePercentChange(baseline: number, current: number): number {
    if (!isNumber(baseline) || !isNumber(current) || baseline <= 0 || current <= 0) {
      throw new Error('Invalid numeric input to LogRatioDriftStrategy');
    }
    const lnRatio = Math.log(current / baseline);
    return lnRatio * 100;
  }
}

/* ============================================================================
 *                          FACTORY  ──────────────────────────────────────────
 * ==========================================================================*/

/**
 * Simple factory that materializes DriftComputationStrategy by name.
 */
export class DriftStrategyFactory {
  public static build(strategy: 'percentage' | 'log-ratio' = 'percentage'): DriftComputationStrategy {
    switch (strategy) {
      case 'percentage':
        return new PercentageDriftStrategy();
      case 'log-ratio':
        return new LogRatioDriftStrategy();
      default:
        throw new Error(`Unsupported drift strategy: ${strategy as string}`);
    }
  }
}

/* ============================================================================
 *                          OBSERVER  ─────────────────────────────────────────
 * ==========================================================================*/

export interface DriftObserver {
  onDrift(event: KPIDriftEvent): Promise<void>;
}

/**
 * SUBJECT: Emits KPI drift events to registered observers.
 * Internally uses Node.js EventEmitter for lightweight async pub/sub.
 */
export class KPIDriftSubject {
  private readonly emitter = new EventEmitter();

  public register(observer: DriftObserver): void {
    this.emitter.on('drift', (event: KPIDriftEvent) => {
      observer
        .onDrift(event)
        .catch(err =>
          winston.error(`[KPIDriftSubject] Observer error: ${(err as Error).message}`, {
            observer: observer.constructor.name,
            event,
          }),
        );
    });
  }

  public async notify(event: KPIDriftEvent): Promise<void> {
    this.emitter.emit('drift', cloneDeep(event));
  }
}

/* ============================================================================
 *                     OBSERVER ADAPTERS  ─────────────────────────────────────
 * ==========================================================================*/

/**
 * Sends drift notifications to Slack (external adapter).
 * NOTE: Placeholder implementation – replace with @slack/web-api, etc.
 */
export class SlackNotifier implements DriftObserver {
  constructor(private readonly webhookUrl: string) {}

  public async onDrift(event: KPIDriftEvent): Promise<void> {
    // Placeholder: In production, POST to Slack Webhook
    winston.info(`[SlackNotifier] KPI drift alert sent`, { event, webhookUrl: this.webhookUrl });
  }
}

/**
 * Persists KPI drift events into the model monitoring store.
 * Example adapter for Snowflake, PostgreSQL, etc.
 */
export class PersistenceObserver implements DriftObserver {
  constructor(private readonly dbConn: { query: (q: string, p?: unknown[]) => Promise<unknown> }) {}

  public async onDrift(event: KPIDriftEvent): Promise<void> {
    const sql = `INSERT INTO kpi_drift_audit (kpi_name, percent_change, ts) VALUES ($1, $2, to_timestamp($3 / 1000.0))`;
    await this.dbConn.query(sql, [event.kpi.name, event.percentChange, event.timestamp]);
    winston.debug('[PersistenceObserver] Drift event persisted', { event });
  }
}

/* ============================================================================
 *                     KPI DRIFT MONITORING SERVICE  ──────────────────────────
 * ==========================================================================*/

/**
 * Service responsible for evaluating KPIs and publishing drift events
 * – Pure domain logic; no external IO here.
 */
export class KPIDriftMonitoringService {
  constructor(
    private readonly strategy: DriftComputationStrategy,
    private readonly thresholdPercent: number,
    private readonly subject: KPIDriftSubject,
  ) {
    if (thresholdPercent <= 0) {
      throw new Error('thresholdPercent must be > 0');
    }
  }

  /**
   * Evaluate a single KPI snapshot and publish drift event if needed.
   */
  public async evaluate(kpiSnapshot: KPI): Promise<void> {
    try {
      const percentChange = this.strategy.computePercentChange(
        kpiSnapshot.baselineValue,
        kpiSnapshot.currentValue,
      );

      const absChange = Math.abs(percentChange);

      winston.debug('[KPIDriftMonitoringService] KPI evaluated', {
        name: kpiSnapshot.name,
        baseline: kpiSnapshot.baselineValue,
        current: kpiSnapshot.currentValue,
        percentChange,
      });

      if (absChange >= this.thresholdPercent) {
        const event: KPIDriftEvent = {
          kpi: cloneDeep(kpiSnapshot),
          percentChange,
          timestamp: Date.now(),
        };
        await this.subject.notify(event);
      }
    } catch (err) {
      winston.error('[KPIDriftMonitoringService] Evaluation error', {
        kpi: kpiSnapshot.name,
        error: (err as Error).message,
      });
    }
  }
}

/* ============================================================================
 *            EXAMPLE COMPOSITION ROOT (would live elsewhere)  ────────────────
 * ==========================================================================*/

/**
 * Example wiring. In a real application, this would reside in a dedicated
 * composition module or dependency-injection container.
 */
async function exampleBootstrap(): Promise<void> {
  // 1) Select strategy at runtime (Strategy + Factory)
  const driftStrategy = DriftStrategyFactory.build(process.env.DRIFT_STRATEGY as any);

  // 2) Instantiate subject
  const subject = new KPIDriftSubject();

  // 3) Register observers (Observer pattern)
  subject.register(new SlackNotifier(process.env.SLACK_WEBHOOK_URL || 'https://hooks.slack.mock'));
  subject.register(
    new PersistenceObserver({
      // Mocked DB adapter; replace with actual ORM/client
      query: async (q: string, p: unknown[]) => winston.debug('[MockDB] Query executed', { q, p }),
    }),
  );

  // 4) Create service with 10% threshold
  const monitoringService = new KPIDriftMonitoringService(driftStrategy, 10, subject);

  // 5) Evaluate sample KPI snapshot
  await monitoringService.evaluate({
    name: 'Customer Lifetime Value',
    unit: '$',
    currentValue: 245.12,
    baselineValue: 200.0,
    metadata: { segment: 'Enterprise' },
  });
}

// Only execute when run directly (not when imported by tests)
if (require.main === module) {
  exampleBootstrap().catch(err => {
    winston.error('[Bootstrap] Unhandled exception', { error: (err as Error).message });
    process.exit(1);
  });
}
```