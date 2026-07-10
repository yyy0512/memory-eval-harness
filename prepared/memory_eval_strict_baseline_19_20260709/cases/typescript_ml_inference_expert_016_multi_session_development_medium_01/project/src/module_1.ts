```typescript
/**
 * src/module_1.ts
 *
 * Core domain logic that lives *inside* the hexagon.  No IO or framework
 * specifics are allowed to bleed into this file.  Its single responsibility is
 * to orchestrate the life-cycle of a single inference call and compute the
 * business-driven charge associated with it, while emitting domain events that
 * observers (dashboards, alerting, data contracts, etc.) can consume.
 *
 * Patterns used:
 *   • Strategy Pattern  – pluggable billing schemes
 *   • Factory Pattern   – runtime selection of billing strategies
 *   • Observer Pattern  – KPI/usage event propagation
 *
 * NOTE: All external concerns (Kafka, REST controllers, DBs, etc.) must talk to
 * this service through the ports declared here.  That guarantees that the
 * hexagon boundaries remain intact and that nothing outside can corrupt the
 * business rules guarded herein.
 */

/////////////////////////////
// 🛂  DOMAIN–LEVEL TYPES  //
/////////////////////////////

export type SLA = 'STANDARD' | 'LOW_LATENCY' | 'HIGH_THROUGHPUT';

export interface InferenceRequestMeta {
  readonly requestId: string;
  readonly modelName: string;
  readonly tokensProcessed: number;
  readonly latencyMs: number;
  readonly sla: SLA;
  readonly timestamp: Date;
}

export interface BillingRecord {
  readonly requestId: string;
  readonly costInCents: number;
  readonly strategyName: string;
}

/////////////////////////////
//  HEXAGONAL PORTS (IO)   //
/////////////////////////////

/**
 * Outbound port for persisting billing records.
 * An adapter will implement this interface to store data in
 * Postgres, DynamoDB, Kafka, etc.
 */
export interface BillingRepositoryPort {
  persist(record: BillingRecord): Promise<void>;
}

/**
 * Outbound port for emitting events to the rest of the platform:
 * – dashboards
 * – alerting systems
 * – audit logs
 */
export interface DomainEventPublisherPort {
  publish<TEvent extends object>(event: TEvent): Promise<void>;
}

/**
 * Inbound port for runtime configuration/feature flags,
 * e.g., to toggle between billing strategies without redeploy.
 */
export interface ConfigProviderPort {
  get<T = unknown>(key: string): Promise<T>;
}

/////////////////////////////////
// 📏  BILLING STRATEGIES      //
/////////////////////////////////

export interface BillingStrategy {
  readonly name: string;
  calculate(meta: InferenceRequestMeta): number; // → cost in *cents*
}

/**
 * Usage-based billing: charge per token with SLA multipliers.
 */
export class UsageBasedBillingStrategy implements BillingStrategy {
  public readonly name = 'USAGE_BASED';

  // cents per token for standard SLA
  private static readonly BASE_RATE_PER_TOKEN = 0.01;

  public calculate(meta: InferenceRequestMeta): number {
    const baseCost = meta.tokensProcessed * UsageBasedBillingStrategy.BASE_RATE_PER_TOKEN;
    const slaMultiplier = this.getSlaMultiplier(meta.sla);
    return Math.ceil(baseCost * slaMultiplier);
  }

  private getSlaMultiplier(sla: SLA): number {
    switch (sla) {
      case 'LOW_LATENCY':
        return 1.5;
      case 'HIGH_THROUGHPUT':
        return 1.2;
      case 'STANDARD':
      default:
        return 1;
    }
  }
}

/**
 * Subscription-style flat-rate billing.
 */
export class SubscriptionBillingStrategy implements BillingStrategy {
  public readonly name = 'SUBSCRIPTION';

  private static readonly INCLUDED_TOKENS = 1_000_000;
  private static readonly OVERAGE_RATE_PER_TOKEN = 0.005; // cents
  private static readonly MONTHLY_FLAT_FEE = 5000; // cents ($50)

  public calculate(meta: InferenceRequestMeta): number {
    const overageTokens = Math.max(meta.tokensProcessed - SubscriptionBillingStrategy.INCLUDED_TOKENS, 0);
    const overageCost = overageTokens * SubscriptionBillingStrategy.OVERAGE_RATE_PER_TOKEN;
    return Math.ceil(SubscriptionBillingStrategy.MONTHLY_FLAT_FEE + overageCost);
  }
}

/**
 * Strategy Factory that decouples the selection logic from the strategies
 * themselves.  Selection can happen via runtime config, environment variable,
 * or even ML-driven optimization logic.
 */
export class BillingStrategyFactory {
  public constructor(private readonly configProvider: ConfigProviderPort) {}

  public async create(): Promise<BillingStrategy> {
    const key = await this.configProvider.get<string>('BILLING_STRATEGY');
    switch (key?.toUpperCase()) {
      case 'SUBSCRIPTION':
        return new SubscriptionBillingStrategy();
      case 'USAGE_BASED':
      default:
        return new UsageBasedBillingStrategy();
    }
  }
}

/////////////////////////////////////////
// 🔔  OBSERVER EVENT IMPLEMENTATIONS  //
/////////////////////////////////////////

export interface InferenceCompletedEvent {
  readonly type: 'InferenceCompleted';
  readonly payload: InferenceRequestMeta & { billing: BillingRecord };
}

export interface BillingFailedEvent {
  readonly type: 'BillingFailed';
  readonly payload: InferenceRequestMeta & { reason: string };
}

////////////////////////////////////////////////////////////////////////////////
// 🧠  CORE DOMAIN SERVICE: InferenceLifecycleManager                          //
////////////////////////////////////////////////////////////////////////////////

export class InferenceLifecycleManager {
  private readonly observers = new Set<DomainEventPublisherPort>();
  private billingStrategy?: BillingStrategy;

  public constructor(
    private readonly billingRepo: BillingRepositoryPort,
    private readonly strategyFactory: BillingStrategyFactory,
  ) {}

  //////////////////////////////
  // Observer Pattern methods //
  //////////////////////////////
  public registerObserver(observer: DomainEventPublisherPort): void {
    this.observers.add(observer);
  }

  public removeObserver(observer: DomainEventPublisherPort): void {
    this.observers.delete(observer);
  }

  //////////////////////////////
  // Primary use-case method  //
  //////////////////////////////

  /**
   * Main entry point called by adapters (REST Controller, Kafka Consumer, etc.)
   */
  public async handleInferenceCompleted(meta: InferenceRequestMeta): Promise<void> {
    try {
      // Lazy-load billing strategy so that hot-swapping a strategy at runtime
      // merely requires updating ConfigProvider + clearing factory's cache.
      if (!this.billingStrategy) {
        this.billingStrategy = await this.strategyFactory.create();
      }

      const costInCents = this.billingStrategy.calculate(meta);

      const record: BillingRecord = {
        requestId: meta.requestId,
        costInCents,
        strategyName: this.billingStrategy.name,
      };

      // ###############################################################
      // Persist billing BEFORE notifying observers to ensure database
      // is source-of-truth in case observers fail.
      // ###############################################################
      await this.billingRepo.persist(record);

      await this.notifyObservers<InferenceCompletedEvent>({
        type: 'InferenceCompleted',
        payload: { ...meta, billing: record },
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'Unknown';
      await this.notifyObservers<BillingFailedEvent>({
        type: 'BillingFailed',
        payload: { ...meta, reason },
      });
      // Re-throw so that upstream adapters can implement retry policies
      throw error;
    }
  }

  ////////////////////////////
  //  Private helper logic  //
  ////////////////////////////

  private async notifyObservers<TEvent extends object>(event: TEvent): Promise<void> {
    await Promise.allSettled(
      Array.from(this.observers).map((observer) =>
        observer.publish(event).catch((err) => {
          // No observer should crash the domain. We log and swallow errors
          // to avoid cascading failures; instrumentation will pick it up.
          // eslint-disable-next-line no-console -- acceptable inside core
          console.error('Observer notification failed', err);
        }),
      ),
    );
  }
}
```