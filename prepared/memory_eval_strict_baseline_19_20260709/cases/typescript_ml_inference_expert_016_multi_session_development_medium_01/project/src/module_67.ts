```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * File: src/module_67.ts
 *
 * Pricing engine for SLA-aware inference requests.
 *
 * Core concerns:
 *   • Strategy-Pattern – interchangeable billing rules (usage, subscription, tiered)
 *   • Factory-Pattern  – dynamic strategy resolution based on customer / SLA context
 *   • Observer-Pattern – asynchronous notification of downstream audit & BI adapters
 *
 * This file purposefully contains _only_ domain logic and pure TypeScript,
 * keeping IO (DB, Kafka, HTTP, …) in outer adapters per hexagonal architecture.
 */

import { v4 as uuid } from 'uuid'; // Lightweight util, allowed in core
// NOTE: Types such as DomainEventBus, Clock, Money may live in adjacent core modules.
import { DomainEventBus } from './core/events/domain-event-bus';
import { Clock } from './core/time/clock';
import { Money } from './core/finance/money';

/* ------------------------------------------------------------------------- */
/*                               Domain Models                               */
/* ------------------------------------------------------------------------- */

/** Immutable summary of an inference invocation from the outside world. */
export interface InferenceRequestSummary {
  readonly modelId: string;
  readonly accountId: string;
  readonly charCount: number;      // Example feature: text tokens processed
  readonly startedAt: Date;
  readonly latencyMs: number;
  /** SLA tier governed by legal contract. */
  readonly sla: 'STANDARD' | 'PREMIUM' | 'ENTERPRISE';
}

/** Monetary result of running an inference. */
export type InferenceCost = Money;

/**
 * Internal representation of customer-level commercial agreements retrieved
 * from a Contract Service (adapter plugged in at runtime).
 */
export interface CommercialTerms {
  readonly strategy: StrategyType;
  readonly unitPriceCents?: number;          // For usage-based
  readonly monthlySubscriptionCents?: number;
  readonly includedChars?: number;           // For subscription
  readonly tiers?: Array<{ upTo: number; unitPriceCents: number }>; // For tiered
}

/* ------------------------------------------------------------------------- */
/*                              Strategy Pattern                             */
/* ------------------------------------------------------------------------- */

/** Strategy discriminant union for compile-time exhaustiveness checks. */
export type StrategyType = 'USAGE_BASED' | 'SUBSCRIPTION' | 'TIERED';

export interface PricingStrategy {
  readonly type: StrategyType;
  /** Pure function: no side-effects, no IO. */
  computeCost(
    request: InferenceRequestSummary,
    contract: CommercialTerms,
  ): InferenceCost;
}

/**
 * Usage-based: simple per-char rate.
 * Example: $0.0004 / char
 */
export class UsageBasedStrategy implements PricingStrategy {
  public readonly type: StrategyType = 'USAGE_BASED';

  public computeCost(
    request: InferenceRequestSummary,
    contract: CommercialTerms,
  ): InferenceCost {
    if (typeof contract.unitPriceCents !== 'number') {
      throw new PricingConfigurationError(
        'unitPriceCents is required for usage-based contracts',
      );
    }
    const cents = Math.ceil(request.charCount * contract.unitPriceCents);
    return Money.cents(cents);
  }
}

/**
 * Subscription: pre-paid allowance, overages fall back to usage-based rate.
 */
export class SubscriptionStrategy implements PricingStrategy {
  public readonly type: StrategyType = 'SUBSCRIPTION';

  public computeCost(
    request: InferenceRequestSummary,
    contract: CommercialTerms,
  ): InferenceCost {
    if (
      typeof contract.monthlySubscriptionCents !== 'number' ||
      typeof contract.unitPriceCents !== 'number' ||
      typeof contract.includedChars !== 'number'
    ) {
      throw new PricingConfigurationError(
        'Subscription contract incomplete (price, unit, or allowance)',
      );
    }

    // Simplistic allowance consumption: assume caller has decremented remaining balance.
    const overageChars = Math.max(0, request.charCount - contract.includedChars);
    const overageCents = overageChars * contract.unitPriceCents;
    return Money.cents(overageCents);
  }
}

/**
 * Tiered: progressive volume discounts.
 */
export class TieredStrategy implements PricingStrategy {
  public readonly type: StrategyType = 'TIERED';

  public computeCost(
    request: InferenceRequestSummary,
    contract: CommercialTerms,
  ): InferenceCost {
    if (!contract.tiers || contract.tiers.length === 0) {
      throw new PricingConfigurationError('Tier configuration is required');
    }

    let remaining = request.charCount;
    let totalCents = 0;

    // Ensure tiers sorted ascending
    const tiers = [...contract.tiers].sort((a, b) => a.upTo - b.upTo);

    for (const { upTo, unitPriceCents } of tiers) {
      if (remaining <= 0) break;

      const tierVolume = Math.min(remaining, upTo);
      totalCents += tierVolume * unitPriceCents;
      remaining -= tierVolume;
    }

    // Anything past the final tier uses the last tier's price.
    if (remaining > 0) {
      const lastTierPrice = tiers[tiers.length - 1].unitPriceCents;
      totalCents += remaining * lastTierPrice;
    }

    return Money.cents(totalCents);
  }
}

/* ------------------------------------------------------------------------- */
/*                              Factory Pattern                              */
/* ------------------------------------------------------------------------- */

export class PricingStrategyFactory {
  private constructor() {}

  public static resolve(
    contract: CommercialTerms,
  ): PricingStrategy {
    switch (contract.strategy) {
      case 'USAGE_BASED':
        return new UsageBasedStrategy();
      case 'SUBSCRIPTION':
        return new SubscriptionStrategy();
      case 'TIERED':
        return new TieredStrategy();
      /* c8 ignore next 2 */
      default:
        throw new UnknownPricingStrategyError(contract.strategy as string);
    }
  }
}

/* ------------------------------------------------------------------------- */
/*                               Observer Pattern                            */
/* ------------------------------------------------------------------------- */

/**
 * Domain event emitted once cost has been successfully calculated.
 */
export class PricingCalculatedEvent {
  public readonly id = uuid();
  public readonly occurredAt: Date;

  constructor(
    public readonly summary: InferenceRequestSummary,
    public readonly cost: InferenceCost,
  ) {
    this.occurredAt = Clock.now();
  }
}

/* ------------------------------------------------------------------------- */
/*                              Domain Service                               */
/* ------------------------------------------------------------------------- */

/**
 * Pure application-level service – no adapters,
 * orchestrates strategy selection & event publication.
 */
export class PricingService {
  constructor(private readonly eventBus: DomainEventBus) {}

  public calculate(
    request: InferenceRequestSummary,
    contract: CommercialTerms,
  ): InferenceCost {
    const strategy = PricingStrategyFactory.resolve(contract);

    const cost = strategy.computeCost(request, contract);

    // Publish atomically ‑ if bus throws, propagate to caller
    this.eventBus.publish(new PricingCalculatedEvent(request, cost));

    return cost;
  }
}

/* ------------------------------------------------------------------------- */
/*                              Error Handling                               */
/* ------------------------------------------------------------------------- */

export class PricingConfigurationError extends Error {
  constructor(message: string) {
    super(`[PricingConfigurationError] ${message}`);
  }
}

export class UnknownPricingStrategyError extends Error {
  constructor(type: string) {
    super(`[UnknownPricingStrategy] Strategy "${type}" is not supported.`);
  }
}

/* ------------------------------------------------------------------------- */
/*                              Helper Exports                               */
/* ------------------------------------------------------------------------- */

export const __testables = {
  UsageBasedStrategy,
  SubscriptionStrategy,
  TieredStrategy,
  PricingService,
};
```