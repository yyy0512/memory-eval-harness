```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * -----------------------------------------------------------------------------------------------
 * File:        src/module_41.ts
 * Author:      InsightHexaAI Contributors
 * Description: Domain-level inference-pricing engine (hexagon core). Implements the Strategy
 *              & Factory patterns to dynamically select a tenant-specific pricing strategy while
 *              exposing an observable service that produces auditable billing events.
 *
 *              The module purposefully lives inside the core hexagon—no IO concerns are leaked.
 *              Adapters (REST, gRPC, Kafka, etc.) will invoke the exported `InferencePricingService`
 *              and subscribe to the emitted events from outside the hexagon.
 ***************************************************************************************************/

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/* -------------------------------------------------------------------------------------------------
 * Domain Types
 * -----------------------------------------------------------------------------------------------*/

/**
 * Monetary representation in the smallest currency unit to avoid floating point errors.
 * Example: 9.99 USD === { amount: 999, currency: 'USD' }
 */
export interface Money {
  amount: number;           // Always expressed in minor units (e.g., cents)
  currency: string;         // ISO-4217 currency code
}

/**
 * SLA tiers offered by InsightHexaAI.
 * Higher tiers guarantee stricter latencies and higher availability, affecting price.
 */
export enum SlaTier {
  Bronze   = 'Bronze',
  Silver   = 'Silver',
  Gold     = 'Gold',
  Platinum = 'Platinum'
}

/**
 * Inference request metadata required for billing computation.
 */
export interface InferenceRequest {
  readonly id: string;          // Original request UUID
  readonly timestamp: Date;     // When the request was received
  readonly modelName: string;   // Canonical model identifier
  readonly inputSizeKB: number; // Size of the payload (KB)
  readonly latencyMs: number;   // Observed end-to-end latency
  readonly sla: SlaTier;        // SLA tier the tenant purchased
}

/**
 * Tenant profile that dictates which pricing strategy to load.
 */
export interface TenantProfile {
  readonly tenantId: string;
  readonly currency: string;               // ISO-4217
  readonly strategy: PricingStrategyType;  // Strategy name
  readonly subscriptionPlan?: {            // Optional sub-plan details
    readonly monthlyFeeMinor: number;      // e.g., cents
    readonly includedRequests: number;     // Requests included in subscription
  };
}

/* -------------------------------------------------------------------------------------------------
 * Strategy Pattern
 * -----------------------------------------------------------------------------------------------*/

/**
 * Contract for all pricing strategies.
 */
export interface PricingStrategy {
  /**
   * Compute the price for a single inference request.
   */
  calculatePrice(request: InferenceRequest): Money;

  /**
   * Invoked once every successful billing cycle (e.g., month-end) so that
   * strategies can reset their internal counters.
   */
  reset(): void;
}

/**
 * Human-readable identifiers for mapping config/DB values to concrete strategies.
 */
export enum PricingStrategyType {
  UsageBased     = 'USAGE_BASED',
  Subscription   = 'SUBSCRIPTION',
  Hybrid         = 'HYBRID'
}

/**
 * Utility: map SLA tiers to dynamic multipliers.
 * These numbers are purely illustrative—tuning happens elsewhere.
 */
const SLA_MULTIPLIERS: Record<SlaTier, number> = {
  [SlaTier.Bronze]:   1.0,
  [SlaTier.Silver]:   1.2,
  [SlaTier.Gold]:     1.5,
  [SlaTier.Platinum]: 2.0
};

/* ----------------------------------  Concrete Strategies  -------------------------------------*/

/**
 * Simple pay-as-you-go strategy.
 * price = base + (payloadSize * rate) + (latencyPenalty)
 */
class UsageBasedPricing implements PricingStrategy {
  private static readonly BASE_PRICE_MINOR = 5;          // 0.05 USD
  private static readonly SIZE_RATE_MINOR  = 1;          // per KB
  private static readonly LAT_PENALTY_MINOR = 2;         // per 100ms over 50ms

  constructor(private readonly currency: string) {}

  calculatePrice(request: InferenceRequest): Money {
    const multiplier = SLA_MULTIPLIERS[request.sla];
    const sizeComponent   = UsageBasedPricing.SIZE_RATE_MINOR * request.inputSizeKB;
    const latencyOverhead = Math.max(request.latencyMs - 50, 0);
    const latencyComponent = UsageBasedPricing.LAT_PENALTY_MINOR * Math.floor(latencyOverhead / 100);

    const rawPrice = (UsageBasedPricing.BASE_PRICE_MINOR + sizeComponent + latencyComponent) * multiplier;

    return { amount: Math.round(rawPrice), currency: this.currency };
  }

  /* Nothing stateful to reset. */
  reset(): void { /* no-op */ }
}

/**
 * Flat-rate strategy where each inference is effectively prepaid up to a quota.
 * If quota is exceeded, the overage is billed using UsageBasedPricing rules.
 */
class SubscriptionPricing implements PricingStrategy {
  private consumedRequests = 0;
  private readonly overageDelegate: UsageBasedPricing;

  constructor(
    private readonly plan: NonNullable<TenantProfile['subscriptionPlan']>,
    currency: string
  ) {
    this.overageDelegate = new UsageBasedPricing(currency);
  }

  calculatePrice(request: InferenceRequest): Money {
    if (this.consumedRequests < this.plan.includedRequests) {
      this.consumedRequests++;
      return { amount: 0, currency: 'USD' };  // Already covered by subscription
    }

    // Delegate overage calculation
    return this.overageDelegate.calculatePrice(request);
  }

  reset(): void {
    this.consumedRequests = 0;
  }
}

/**
 * Hybrid strategy: a reduced monthly fee with lowered usage costs.
 */
class HybridPricing implements PricingStrategy {
  private readonly usageDelegate: UsageBasedPricing;

  constructor(
    private readonly plan: NonNullable<TenantProfile['subscriptionPlan']>,
    currency: string
  ) {
    // Override UsageBased base rates by 50% discount for hybrid customers.
    this.usageDelegate = new UsageBasedPricing(currency);
  }

  calculatePrice(request: InferenceRequest): Money {
    const basePrice = this.usageDelegate.calculatePrice(request);
    // 50% discount after applying usage-based calculation
    return { amount: Math.round(basePrice.amount * 0.5), currency: basePrice.currency };
  }

  reset(): void { /* Stateless in this version */ }
}

/* -------------------------------------------------------------------------------------------------
 * Factory Pattern
 * -----------------------------------------------------------------------------------------------*/

/**
 * Resolves an appropriate strategy for a given tenant profile.
 */
export class PricingStrategyFactory {
  static getStrategy(profile: TenantProfile): PricingStrategy {
    switch (profile.strategy) {
      case PricingStrategyType.UsageBased:
        return new UsageBasedPricing(profile.currency);

      case PricingStrategyType.Subscription:
        if (!profile.subscriptionPlan) {
          throw new PricingError(
            'SUBSCRIPTION_MISSING_PLAN',
            `Tenant ${profile.tenantId} selected subscription strategy, but no plan details provided.`
          );
        }
        return new SubscriptionPricing(profile.subscriptionPlan, profile.currency);

      case PricingStrategyType.Hybrid:
        if (!profile.subscriptionPlan) {
          throw new PricingError(
            'HYBRID_MISSING_PLAN',
            `Tenant ${profile.tenantId} selected hybrid strategy, but no plan details provided.`
          );
        }
        return new HybridPricing(profile.subscriptionPlan, profile.currency);

      default:
        /* Exhaustive check – ensures compile-time safety when new enums added */
        const _exhaustive: never = profile.strategy;
        throw new PricingError(
          'UNSUPPORTED_STRATEGY',
          `Pricing strategy '${_exhaustive}' is not supported.`
        );
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * Observer Pattern – Domain Eventing
 * -----------------------------------------------------------------------------------------------*/

/**
 * Event payload produced after every price calculation.
 */
export interface PriceCalculatedEvent {
  readonly eventId: string;
  readonly occurredOn: Date;
  readonly tenantId: string;
  readonly requestId: string;
  readonly price: Money;
}

/**
 * Concrete event names for external adapters to subscribe to.
 */
export enum PricingEvents {
  PriceCalculated = 'pricing.price_calculated'
}

/* -------------------------------------------------------------------------------------------------
 * Domain Errors
 * -----------------------------------------------------------------------------------------------*/

export class PricingError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(`[PricingError:${code}] ${message}`);
    this.name = 'PricingError';
  }
}

/* -------------------------------------------------------------------------------------------------
 * Public Service API
 * -----------------------------------------------------------------------------------------------*/

/**
 * InferencePricingService – orchestrates strategy delegation, emits domain events, and serves as
 *                          the single entry point for pricing within the core domain.
 */
export class InferencePricingService extends EventEmitter {
  private readonly strategy: PricingStrategy;

  constructor(private readonly tenantProfile: TenantProfile) {
    super();
    this.strategy = PricingStrategyFactory.getStrategy(tenantProfile);
  }

  /**
   * Computes the price for a given inference request and publishes an immutable domain event.
   */
  public price(request: InferenceRequest): Money {
    try {
      const price = this.strategy.calculatePrice(request);

      const event: PriceCalculatedEvent = {
        eventId: uuidv4(),
        occurredOn: new Date(),
        tenantId: this.tenantProfile.tenantId,
        requestId: request.id,
        price
      };

      // Notify observers (billing adapter, analytics, audit trail, etc.)
      this.emit(PricingEvents.PriceCalculated, event);
      return price;
    } catch (error) {
      // Wrap low-level errors with domain-specific context
      if (error instanceof PricingError) {
        throw error;
      }
      throw new PricingError('INTERNAL_PRICING_FAILURE', (error as Error).message);
    }
  }

  /**
   * Resets internal strategy counters—should be called by a scheduler at billing cycle close.
   */
  public newBillingCycle(): void {
    this.strategy.reset();
  }
}

/* -------------------------------------------------------------------------------------------------
 * Example Usage (Would be placed in application layer/adapters, shown here for completeness)
 * -----------------------------------------------------------------------------------------------*/
// const tenantProfile: TenantProfile = {
//   tenantId: 'acme-corp',
//   currency: 'USD',
//   strategy: PricingStrategyType.Hybrid,
//   subscriptionPlan: {
//     monthlyFeeMinor: 19900, // $199.00
//     includedRequests: 50000
//   }
// };
//
// const service = new InferencePricingService(tenantProfile);
// service.on(PricingEvents.PriceCalculated, (event) => console.log('Billing Event:', event));
//
// const req: InferenceRequest = {
//   id: uuidv4(),
//   timestamp: new Date(),
//   modelName: 'customer-churn-v3',
//   inputSizeKB: 24,
//   latencyMs: 63,
//   sla: SlaTier.Gold
// };
//
// const price = service.price(req);
// console.log('Calculated price:', price);
```
