```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ---------------------------------------------------------------
 * File:        src/module_18.ts
 * Module:      Model-Selection Strategy Factory + Observer
 *
 * This module lives in the “core” (hexagon) and owns the domain logic for
 * choosing which model version should serve an online-prediction request.
 * The Strategy Pattern allows product managers to switch algorithms (A/B,
 * multi-armed bandit, deterministic routing, etc.) without touching IO code.
 * The Observer Pattern broadcasts a domain event every time a model version
 * is selected, enabling downstream adapters (dashboards, cost monitors, SLA
 * guards) to react in real-time.
 *
 * NO external framework dependencies are required; everything is kept
 * framework-agnostic to honour the ports-and-adapters architecture.
 */

import { v4 as uuidv4 } from 'uuid'; // RFC-compliant GUIDs for correlation IDs

/*****************************************************************
 *                         Domain Types                          *
 *****************************************************************/

export type ModelId = string;

export interface ModelVersion {
  readonly modelId: ModelId;
  readonly version: string;
  readonly createdAt: Date;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Runtime context fed into the strategy—think request metadata, customer
 * segment, or campaign ID. 100% domain, 0% infrastructure.
 */
export interface InferenceContext {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly timestamp: Date;
  readonly tags?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Reinforcement learning reward — e.g., “clicked”, “converted”, revenue
 * generated, or any other arbitrary business metric you care about.
 */
export type Reward = number;

/*****************************************************************
 *                         Domain Events                         *
 *****************************************************************/

/**
 * Base interface every domain event must fulfil. Having a sealed interface
 * makes it trivial to funnel events into a typed, versioned event store.
 */
export interface DomainEvent<TPayload = unknown> {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;
}

export interface ModelSelectedPayload {
  readonly context: InferenceContext;
  readonly selectedModel: ModelVersion;
  readonly strategyName: StrategyName;
}

export type ModelSelectedEvent = DomainEvent<ModelSelectedPayload>;

/*****************************************************************
 *                         Observer Bus                          *
 *****************************************************************/

export interface EventSubscriber<TEvent extends DomainEvent> {
  (event: TEvent): void | Promise<void>;
}

class InMemoryEventBus {
  private readonly handlers = new Map<string, Set<EventSubscriber<DomainEvent>>>();

  subscribe<TEvent extends DomainEvent>(
    eventName: string,
    handler: EventSubscriber<TEvent>,
  ): void {
    const set = this.handlers.get(eventName) ?? new Set();
    set.add(handler as EventSubscriber<DomainEvent>);
    this.handlers.set(eventName, set);
  }

  async publish<TEvent extends DomainEvent>(event: TEvent): Promise<void> {
    const handlers = this.handlers.get(event.name);
    if (!handlers?.size) return;

    // Run handlers in parallel, but isolate failures
    await Promise.all(
      Array.from(handlers).map(async (handler) => {
        try {
          await handler(event);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(
            `[DomainEventBus] Error in ${handler.name ?? 'anon'}:`,
            (err as Error).stack || err,
          );
        }
      }),
    );
  }
}

export const DomainEventBus = new InMemoryEventBus();

/*****************************************************************
 *                    Strategy Pattern Contracts                 *
 *****************************************************************/

export interface ModelSelectionStrategy {
  /**
   * Main entry-point. Carries no I/O concerns—pure business logic.
   */
  select(
    context: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion>;
}

export type StrategyName =
  | 'AB_TEST'
  | 'MULTI_ARMED_BANDIT'
  | 'DETERMINISTIC'
  | 'SHADOW';

/*****************************************************************
 *                      Concrete Strategies                      *
 *****************************************************************/

/**
 * Pseudo-random split based on configured traffic ratios.
 * Expects “trafficWeight” in each candidate’s meta.
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
  async select(
    _: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion> {
    if (!candidates.length) {
      throw new Error('[ABTestingStrategy] No candidate model versions supplied.');
    }

    const totalWeight = candidates.reduce((acc, c) => {
      const w = (c.meta.trafficWeight as number | undefined) ?? 1;
      return acc + w;
    }, 0);

    const pivot = Math.random() * totalWeight;
    let cumulative = 0;

    for (const candidate of candidates) {
      cumulative += (candidate.meta.trafficWeight as number | undefined) ?? 1;
      if (pivot <= cumulative) return candidate;
    }

    // Fallback (should never happen)
    return candidates[candidates.length - 1];
  }
}

/**
 * Simple ε-greedy multi-armed bandit implementation. Keeps local statistics in
 * memory for illustration purposes; production code would externalise this
 * state to Redis, a DB, or an experimentation platform.
 */
export class EpsilonGreedyBanditStrategy implements ModelSelectionStrategy {
  // Stats keyed by candidateId -> { pulls, rewardSum }
  private readonly stats = new Map<ModelId, { pulls: number; rewardSum: number }>();

  constructor(private readonly epsilon: number = 0.1) {
    if (epsilon < 0 || epsilon > 1) {
      throw new Error('[EpsilonGreedyBanditStrategy] epsilon must be ∈ [0, 1].');
    }
  }

  async select(
    _: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion> {
    if (!candidates.length) {
      throw new Error('[EpsilonGreedyBanditStrategy] No candidate model versions supplied.');
    }

    // Exploration
    if (Math.random() < this.epsilon) {
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Exploitation
    let bestCandidate = candidates[0];
    let highestMeanReward = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      const { pulls, rewardSum } = this.stats.get(candidate.modelId) ?? {
        pulls: 0,
        rewardSum: 0,
      };

      const mean = pulls === 0 ? 0 : rewardSum / pulls;

      if (mean > highestMeanReward) {
        highestMeanReward = mean;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  }

  /**
   * Report outcome back into the bandit for online learning.
   */
  public backPropagate(modelId: ModelId, reward: Reward): void {
    const entry = this.stats.get(modelId) ?? { pulls: 0, rewardSum: 0 };
    entry.pulls += 1;
    entry.rewardSum += reward;
    this.stats.set(modelId, entry);
  }
}

/**
 * Single winner, no randomness—useful for hot fixes or “champion” routing.
 */
export class DeterministicRoutingStrategy implements ModelSelectionStrategy {
  constructor(private readonly winnerVersion: string) {}

  async select(
    _: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion> {
    const winner = candidates.find((c) => c.version === this.winnerVersion);
    if (!winner)
      throw new Error(
        `[DeterministicRoutingStrategy] Candidate set does not contain version ${this.winnerVersion}`,
      );
    return winner;
  }
}

/**
 * Shadow mode duplicates traffic to a canary model without impacting
 * production decisions. For selection we always return “primary”, but we
 * decorate the payload with the shadow candidate so that observers can
 * duplicate the request.
 */
export class ShadowTrafficStrategy implements ModelSelectionStrategy {
  async select(
    _: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion> {
    if (candidates.length < 2)
      throw new Error(
        '[ShadowTrafficStrategy] Requires at least TWO candidates (primary + shadow).',
      );
    const primary = candidates[0];
    // NOTE: We are purposely ignoring the shadow model for decision making.
    return primary;
  }
}

/*****************************************************************
 *                   Strategy Factory (Factory Pattern)          *
 *****************************************************************/

export class ModelSelectionStrategyFactory {
  private static readonly registry = new Map<
    StrategyName,
    () => ModelSelectionStrategy
  >([
    ['AB_TEST', () => new ABTestingStrategy()],
    ['MULTI_ARMED_BANDIT', () => new EpsilonGreedyBanditStrategy()],
    // Default deterministic picks first in list (may be overridden)
    ['DETERMINISTIC', () => new DeterministicRoutingStrategy('')],
    ['SHADOW', () => new ShadowTrafficStrategy()],
  ]);

  /**
   * Register or override a strategy at runtime. Enables blue/green deploys.
   */
  static register(
    name: StrategyName,
    factoryFn: () => ModelSelectionStrategy,
  ): void {
    ModelSelectionStrategyFactory.registry.set(name, factoryFn);
  }

  static create(name: StrategyName): ModelSelectionStrategy {
    const factory = ModelSelectionStrategyFactory.registry.get(name);
    if (!factory)
      throw new Error(`[StrategyFactory] Strategy "${name}" is not registered.`);
    return factory();
  }
}

/*****************************************************************
 *            Orchestrator: Application Service / Use-Case       *
 *****************************************************************/

/**
 * Core business service orchestrating model-selection. Serves as a façade so
 * that adapters (HTTP, Kafka, gRPC, etc.) don’t need to know about strategies.
 */
export class ModelSelectorService {
  constructor(
    private readonly strategy: ModelSelectionStrategy,
  ) {}

  /**
   * Entry-point called by external adapters.
   */
  async execute(
    context: InferenceContext,
    candidates: readonly ModelVersion[],
  ): Promise<ModelVersion> {
    // Delegate decision to the strategy
    const selected = await this.strategy.select(context, candidates);

    // Broadcast event for observers—no side-effects in this service
    const event: ModelSelectedEvent = {
      id: uuidv4(),
      name: 'ModelSelected',
      occurredAt: new Date(),
      payload: { context, selectedModel: selected, strategyName: this.getStrategyName() },
    };
    await DomainEventBus.publish(event);

    return selected;
  }

  /**
   * Reflection helper (not 100% reliable with minification, but OK in TS env)
   */
  private getStrategyName(): StrategyName {
    const proto = Object.getPrototypeOf(this.strategy);
    const ctorName: string = proto?.constructor?.name ?? 'UNKNOWN';
    switch (ctorName) {
      case ABTestingStrategy.name:
        return 'AB_TEST';
      case EpsilonGreedyBanditStrategy.name:
        return 'MULTI_ARMED_BANDIT';
      case DeterministicRoutingStrategy.name:
        return 'DETERMINISTIC';
      case ShadowTrafficStrategy.name:
        return 'SHADOW';
      default:
        return 'DETERMINISTIC';
    }
  }
}

/*****************************************************************
 *                    Example Observer Adapter                   *
 *****************************************************************/

// Lightweight logger until real logging adapter is wired in.
const logEvent: EventSubscriber<ModelSelectedEvent> = (evt) => {
  // eslint-disable-next-line no-console
  console.info(
    `[ModelSelected] strategy=${evt.payload.strategyName} model=${evt.payload.selectedModel.modelId}@${evt.payload.selectedModel.version} correlation=${evt.payload.context.correlationId}`,
  );
};

// Register observer
DomainEventBus.subscribe('ModelSelected', logEvent);
```
