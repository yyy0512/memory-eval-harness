```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * ================================================================
 * Module: src/module_7.ts
 * Responsibility:
 *   • Provide an extendable mechanism to choose the correct ModelVersion
 *     at inference-time according to dynamic business KPIs.
 *   • Implements Strategy & Factory patterns for model-selection.
 *   • Publishes observable domain events when a version is chosen
 *     (allowing dashboards or alerting rules to react in near real-time).
 *
 * NOTE:
 *   • This file is placed inside the “core” hexagon and therefore
 *     contains *no* IO-specific code (DB, HTTP, Kafka…). Adapters that
 *     persist or transmit the events live outside the hexagon.
 *   • All dates are UTC ISO-8601. All numbers are base-10 decimals.
 */

import { randomInt } from 'crypto'; // Node.js std-lib crypto provides CSPRNG.
import assert from 'assert';

/* ------------------------------------------------------------------ */
/*                             Domain Types                            */
/* ------------------------------------------------------------------ */

/**
 * KPI documented in the business glossary. Examples:
 *   • REVENUE
 *   • COST_SAVINGS
 *   • CUSTOMER_LIFETIME_VALUE
 */
export type KPI =
  | 'REVENUE'
  | 'COST_SAVINGS'
  | 'CUSTOMER_LIFETIME_VALUE'
  | 'ACCURACY'
  | 'LATENCY'
  | 'REGULATORY_COMPLIANCE';

/**
 * Domain representation of a model version registered in the core.
 */
export interface ModelVersion {
  readonly id: string;
  readonly createdAt: string; // ISO String
  readonly tags: ReadonlyArray<string>;
  readonly metadata: Readonly<Record<string, any>>;
  readonly metrics: ModelPerformanceMetrics;
}

/**
 * Performance metrics tracked at training/evaluation time.
 */
export interface ModelPerformanceMetrics {
  readonly accuracy: number; // 0..1
  readonly precision: number; // 0..1
  readonly recall: number; // 0..1
  readonly latencyP50: number; // ms
  readonly latencyP95: number; // ms
  readonly sampleSize: number; // Count of evaluation records
  readonly lastValidatedAt: string; // ISO String
}

/**
 * Context of the inference call.
 * Example: Which tenant, SLA tier, or feature flag is requesting inference.
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly kpiPriorityList: ReadonlyArray<KPI>;
  readonly correlationId: string;
}

/* ------------------------------------------------------------------ */
/*                    Strategy Pattern – Interfaces                    */
/* ------------------------------------------------------------------ */

export interface IModelSelectionStrategy {
  /**
   * Choose a `ModelVersion` from the candidate list for the given context.
   * Implementations MUST be side-effect free. Any IO should reside in adapters.
   */
  selectVersion(
    candidates: ReadonlyArray<ModelVersion>,
    context: RequestContext
  ): ModelVersion;
}

/* ------------------------------------------------------------------ */
/*               Strategy Implementations – Non-trivial logic          */
/* ------------------------------------------------------------------ */

/**
 * ABTestStrategy evenly splits traffic between two or more versions.
 * Useful for controlled experiments. Tie-breakers are decided randomly.
 */
export class ABTestStrategy implements IModelSelectionStrategy {
  selectVersion(
    candidates: ReadonlyArray<ModelVersion>,
    context: RequestContext
  ): ModelVersion {
    assert(
      candidates.length >= 2,
      'ABTestStrategy requires at least two model versions'
    );
    const idx = randomInt(0, candidates.length);
    return candidates[idx];
  }
}

/**
 * MultiArmedBanditStrategy dynamically shifts traffic towards versions
 * with higher KPI returns (e.g., accuracy or revenue).
 * Implements a simplistic ε-greedy algorithm for demonstration purposes.
 */
export class MultiArmedBanditStrategy implements IModelSelectionStrategy {
  private readonly epsilon: number;

  constructor(epsilon = 0.1) {
    if (epsilon < 0 || epsilon > 1)
      throw new RangeError('epsilon must be between 0 and 1');
    this.epsilon = epsilon;
  }

  selectVersion(
    candidates: ReadonlyArray<ModelVersion>,
    context: RequestContext
  ): ModelVersion {
    assert(
      candidates.length > 0,
      'MultiArmedBanditStrategy requires at least one model version'
    );

    // Exploration
    if (Math.random() < this.epsilon) {
      return candidates[randomInt(0, candidates.length)];
    }

    // Exploitation: pick model with highest weighted KPI score
    const priority = context.kpiPriorityList;
    const scored = candidates.map((mv) => ({
      mv,
      score: this.computeScore(mv, priority),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored[0].mv;
  }

  private computeScore(
    mv: ModelVersion,
    priorities: ReadonlyArray<KPI>
  ): number {
    // Scoring heuristic: weighted sum with simple weights
    const weights: Record<KPI, number> = {
      REVENUE: 1.0,
      COST_SAVINGS: 0.9,
      CUSTOMER_LIFETIME_VALUE: 0.8,
      ACCURACY: 0.7,
      LATENCY: -0.5, // Lower latency is better (negative weight)
      REGULATORY_COMPLIANCE: 0.6,
    };

    let score = 0;
    priorities.forEach((kpi, idx) => {
      const weight = weights[kpi] ?? 0.5;
      const factor =
        1 -
        idx * 0.1; // earlier KPIs carry more influence, decays 10% each step
      switch (kpi) {
        case 'ACCURACY':
          score += mv.metrics.accuracy * weight * factor;
          break;
        case 'LATENCY':
          // Invert latency to align with "higher is better"
          const invLatency = 1 / (1 + mv.metrics.latencyP50);
          score += invLatency * weight * factor;
          break;
        default:
          score += weight * factor; // Placeholder for other KPIs
      }
    });
    return score;
  }
}

/**
 * ChampionChallengerStrategy always returns the champion model except
 * for a small fraction of traffic routed to the challenger for ongoing
 * validation. Simple but powerful in highly regulated environments.
 */
export class ChampionChallengerStrategy implements IModelSelectionStrategy {
  private readonly challengerPercentage: number;

  constructor(challengerPercentage = 0.02) {
    if (challengerPercentage < 0 || challengerPercentage > 1)
      throw new RangeError('challengerPercentage must be between 0 and 1');
    this.challengerPercentage = challengerPercentage;
  }

  selectVersion(
    candidates: ReadonlyArray<ModelVersion>,
    context: RequestContext
  ): ModelVersion {
    assert(
      candidates.length >= 2,
      'ChampionChallengerStrategy requires at least two model versions'
    );
    // Sort by creation date: earliest is champion, latest is challenger
    const sorted = [...candidates].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const champion = sorted[0];
    const challenger = sorted[sorted.length - 1];

    return Math.random() < this.challengerPercentage ? challenger : champion;
  }
}

/* ------------------------------------------------------------------ */
/*                   Factory Pattern – Strategy Factory               */
/* ------------------------------------------------------------------ */

/**
 * Enumeration of supported strategy identifiers for safety.
 */
export type StrategyType = 'AB_TEST' | 'MULTI_ARMED_BANDIT' | 'CHAMP_CHALLENGER';

export interface StrategyConfig {
  readonly type: StrategyType;
  readonly params?: Record<string, any>;
}

/**
 * Factory responsible for instantiating strategy objects based on
 * configuration (potentially coming from feature flags or admin UI).
 */
export class ModelSelectionStrategyFactory {
  static create(config: StrategyConfig): IModelSelectionStrategy {
    switch (config.type) {
      case 'AB_TEST':
        return new ABTestStrategy();
      case 'MULTI_ARMED_BANDIT': {
        const epsilon = (config.params?.epsilon as number | undefined) ?? 0.1;
        return new MultiArmedBanditStrategy(epsilon);
      }
      case 'CHAMP_CHALLENGER': {
        const pct =
          (config.params?.challengerPercentage as number | undefined) ?? 0.02;
        return new ChampionChallengerStrategy(pct);
      }
      default:
        /* Exhaustive check at compile time */
        const _never: never = config.type;
        throw new Error(`Unsupported strategy type: ${_never as string}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                    Observer Pattern – Domain Events                */
/* ------------------------------------------------------------------ */

export interface DomainEvent {
  readonly occurredAt: string; // ISO String
  readonly name: string;
  readonly payload: Readonly<Record<string, any>>;
}

export type Observer<T extends DomainEvent> = (event: T) => void;

/**
 * Handles subscription management for observers interested in model selection.
 */
export class ModelSelectionNotifier {
  private observers: Set<Observer<DomainEvent>> = new Set();

  subscribe(observer: Observer<DomainEvent>): void {
    this.observers.add(observer);
  }

  unsubscribe(observer: Observer<DomainEvent>): void {
    this.observers.delete(observer);
  }

  notify(event: DomainEvent): void {
    this.observers.forEach((obs) => {
      try {
        obs(event);
      } catch (err) {
        /* Non-critical: failure of a single observer must not compromise flow */
        // TODO: push error to central error bus or observability platform
        // eslint-disable-next-line no-console
        console.error('Observer threw during notify:', err);
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/*              High-level Service Glue for Hexagonal Core           */
/* ------------------------------------------------------------------ */

/**
 * Service orchestrating strategy → selection → event-publish pipeline.
 * Remains agnostic of transport and persistence details.
 */
export class ModelVersionSelectionService {
  private readonly strategy: IModelSelectionStrategy;
  private readonly notifier: ModelSelectionNotifier;

  constructor(
    strategyConfig: StrategyConfig,
    notifier: ModelSelectionNotifier = new ModelSelectionNotifier()
  ) {
    this.strategy = ModelSelectionStrategyFactory.create(strategyConfig);
    this.notifier = notifier;
  }

  /**
   * Public API used by adapters (e.g., REST or gRPC controllers).
   */
  chooseModelVersion(
    candidates: ReadonlyArray<ModelVersion>,
    context: RequestContext
  ): ModelVersion {
    const chosen = this.strategy.selectVersion(candidates, context);

    this.notifier.notify({
      occurredAt: new Date().toISOString(),
      name: 'ModelVersionSelected',
      payload: {
        chosenVersionId: chosen.id,
        candidateVersionIds: candidates.map((c) => c.id),
        strategy: (this.strategy as any).constructor.name,
        context,
      },
    });

    return chosen;
  }

  /**
   * Observers (dashboards, drift detectors, auditors) can subscribe.
   */
  getNotifier(): ModelSelectionNotifier {
    return this.notifier;
  }
}

/* ------------------------------------------------------------------ */
/*                    Fallback Default Export (Barrel)                */
/* ------------------------------------------------------------------ */

export default {
  ModelVersionSelectionService,
  ABTestStrategy,
  MultiArmedBanditStrategy,
  ChampionChallengerStrategy,
  ModelSelectionStrategyFactory,
  ModelSelectionNotifier,
};
```