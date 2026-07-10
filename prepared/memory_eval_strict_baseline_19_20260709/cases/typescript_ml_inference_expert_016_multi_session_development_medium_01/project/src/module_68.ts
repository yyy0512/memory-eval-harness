```typescript
/***************************************************************************************************
 *  File:          src/module_68.ts
 *  Project:       InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  Description:   Production-grade KPI monitoring module that demonstrates the Strategy,
 *                 Factory, and Observer patterns inside the hexagonal architecture.
 *
 *  NOTE:          All outward-facing concerns (SMTP, Slack, Kafka, etc.) are expressed as
 *                 “ports” (interfaces) so that real adapters can be injected without
 *                 polluting the core domain logic or test suite.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/* -------------------------------------------------------------------------------------------------
 * Shared Domain Types
 * -----------------------------------------------------------------------------------------------*/

export type KpiName =
  | 'CTR'
  | 'Precision'
  | 'Recall'
  | 'F1'
  | 'CostPerInference'
  | 'LatencyP95';

export interface KpiEvent {
  readonly modelId: string;
  readonly kpi: KpiName;
  readonly value: number;
  readonly timestamp: Date;
}

/* -------------------------------------------------------------------------------------------------
 * Strategy Pattern: KPI Breach Evaluation
 * -----------------------------------------------------------------------------------------------*/

/**
 * Evaluates whether a given KPI event has breached its threshold.
 */
export interface ThresholdStrategy {
  /**
   * @param event – KPI event emitted by the system.
   * @returns boolean – True when the KPI breach should raise an alert.
   */
  isThresholdBreach(event: KpiEvent): boolean;
}

/**
 * Static threshold strategy configured via environment or admin panel.
 */
export class StaticThresholdStrategy implements ThresholdStrategy {
  constructor(private readonly thresholds: Record<KpiName, number>) {}

  isThresholdBreach(event: KpiEvent): boolean {
    const threshold = this.thresholds[event.kpi];

    // Unknown KPIs are considered non-breaching for forward compatibility.
    if (threshold === undefined) return false;

    // Example rule: higher is better for positive KPIs, lower is better for cost/latency.
    const inverseKpis: KpiName[] = ['CostPerInference', 'LatencyP95'];
    return inverseKpis.includes(event.kpi)
      ? event.value > threshold
      : event.value < threshold;
  }
}

/**
 * Adaptive threshold strategy using rolling statistics.
 * Minimal implementation—swap in Z-score or Bayesian estimators as needed.
 */
export class AdaptiveThresholdStrategy implements ThresholdStrategy {
  private readonly window: Map<KpiName, number[]> = new Map();

  constructor(private readonly windowSize = 100, private readonly sigma = 3) {}

  isThresholdBreach(event: KpiEvent): boolean {
    const series = this.window.get(event.kpi) ?? [];
    series.push(event.value);

    if (series.length > this.windowSize) series.shift(); // maintain window
    this.window.set(event.kpi, series);

    // Not enough data → never breach.
    if (series.length < this.windowSize) return false;

    // Calculate mean & std-dev.
    const mean =
      series.reduce((sum, v) => sum + v, 0) / this.windowSize;
    const variance =
      series.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) /
      this.windowSize;
    const stdDev = Math.sqrt(variance);

    return Math.abs(event.value - mean) > this.sigma * stdDev;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Factory Pattern: Alert Handlers
 * -----------------------------------------------------------------------------------------------*/

/**
 * Port for sending alerts. Adapters live outside the hexagon.
 */
export interface AlertHandler {
  sendAlert(event: KpiEvent, message: string): Promise<void>;
}

/**
 * Mock email handler – replace with actual SMTP implementation.
 */
export class EmailAlertHandler implements AlertHandler {
  constructor(private readonly toAddress: string) {}

  async sendAlert(event: KpiEvent, message: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.info(`📧  Email sent to ${this.toAddress}: ${message}`, event);
  }
}

/**
 * Mock Slack handler – replace with @slack/web-api in adapter layer.
 */
export class SlackAlertHandler implements AlertHandler {
  constructor(private readonly channel: string) {}

  async sendAlert(event: KpiEvent, message: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.info(`💬  Slack message to ${this.channel}: ${message}`, event);
  }
}

/**
 * Runtime factory for alert handlers based on user/team preference.
 */
export class AlertHandlerFactory {
  static create(config: {
    type: 'email' | 'slack';
    recipient: string;
  }): AlertHandler {
    switch (config.type) {
      case 'email':
        return new EmailAlertHandler(config.recipient);
      case 'slack':
        return new SlackAlertHandler(config.recipient);
      default:
        // Compile-time exhaustiveness parity check.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _exhaustive: never = config.type;
        throw new Error(`Unsupported alert handler type: ${config.type}`);
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Observer Implementation: KPI Monitor
 * -----------------------------------------------------------------------------------------------*/

/**
 * Hexagon-internal EventBus interface (simplified).
 * Outside adapters can proxy Kafka, RabbitMQ, or WebSockets into this port.
 */
export interface EventBus {
  on(event: 'kpi', listener: (payload: KpiEvent) => void): this;
  emit(event: 'kpi', payload: KpiEvent): boolean;
}

export class InMemoryEventBus extends EventEmitter implements EventBus {}

/**
 * Observer that listens for KPI events and delegates breach detection to strategy.
 */
export class KpiMonitor {
  private readonly monitorId: string;

  constructor(
    private readonly bus: EventBus,
    private readonly strategy: ThresholdStrategy,
    private readonly alertHandler: AlertHandler
  ) {
    this.monitorId = randomUUID();
  }

  start(): void {
    this.bus.on('kpi', this.handleEvent);
    // eslint-disable-next-line no-console
    console.info(`[Monitor ${this.monitorId}] started.`);
  }

  stop(): void {
    this.bus.removeListener('kpi', this.handleEvent);
    // eslint-disable-next-line no-console
    console.info(`[Monitor ${this.monitorId}] stopped.`);
  }

  /* ---------------------------------------------------------------------------------------------
   * Private helpers
   * -------------------------------------------------------------------------------------------*/

  private readonly handleEvent = async (event: KpiEvent): Promise<void> => {
    try {
      if (!this.strategy.isThresholdBreach(event)) return;

      const message = this.buildAlertMessage(event);
      await this.alertHandler.sendAlert(event, message);
    } catch (error) {
      // Fail-safe logging; never throw upstream.
      // eslint-disable-next-line no-console
      console.error(
        `[Monitor ${this.monitorId}] failed to process KPI event`,
        { event, error }
      );
    }
  };

  private buildAlertMessage(event: KpiEvent): string {
    return `⚠️  KPI breach detected for model '${event.modelId}':
    • KPI: ${event.kpi}
    • Value: ${event.value}
    • Timestamp: ${event.timestamp.toISOString()}`;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Example Bootstrap (would be in a separate main.ts file in real project)
 * -----------------------------------------------------------------------------------------------*/

if (require.main === module) {
  // Quick demo when executed directly via ts-node or compiled JS.
  const eventBus = new InMemoryEventBus();

  const monitor = new KpiMonitor(
    eventBus,
    new StaticThresholdStrategy({
      CTR: 0.05,
      Precision: 0.8,
      Recall: 0.75,
      F1: 0.77,
      CostPerInference: 0.001,
      LatencyP95: 200
    }),
    AlertHandlerFactory.create({
      type: 'slack',
      recipient: '#ml-alerts'
    })
  );

  monitor.start();

  // Simulated KPI events
  setInterval(() => {
    const mockEvent: KpiEvent = {
      modelId: 'clf_customer_churn_v42',
      kpi: 'LatencyP95',
      value: Math.random() * 400, // 0–400 ms
      timestamp: new Date()
    };
    eventBus.emit('kpi', mockEvent);
  }, 3_000);
}

/***************************************************************************************************
 * End of file
 ***************************************************************************************************/
```