```typescript
/**
 * src/module_4.ts
 *
 * Model-selection orchestration that lives inside the hexagon (pure domain code).
 * Implements:
 *   • Strategy Pattern  – easily plug different model-selection algorithms
 *   • Factory Pattern   – runtime resolution of the strategy implementation
 *   • Observer Pattern  – publish selection decisions to analytics, alerting, etc.
 *
 * The module knows NOTHING about IO (databases, HTTP, Kafka, …).
 * Adapters living outside the hexagon will import the exposed ports below.
 */

import { randomUUID } from 'crypto';

/* ------------------------------------------------------------------ */
/*                             Domain Types                            */
/* ------------------------------------------------------------------ */

/** A semantic alias for a model identifier stored in the Model Registry. */
export type ModelVersionId = string;

/** A runtime snapshot of how a single model version is performing. */
export interface ModelMetricSnapshot {
  readonly modelVersionId: ModelVersionId;
  /** Average reward (e.g., revenue, accuracy, CLV uplift) over the evaluation window. */
  readonly rewardMean: number;
  /** Number of inference events routed to this model in the evaluation window. */
  readonly observationCount: number;
  /** Timestamp of the snapshot creation in ISO 8601. */
  readonly timestamp: string;
}

/** Metadata payload sent to observers after a model is selected. */
export interface ModelSelectionEvent {
  readonly requestId: string;
  readonly selectedModelVersionId: ModelVersionId;
  readonly strategyUsed: StrategyType;
  /** Human-friendly trace to help explain WHY a model was chosen. */
  readonly rationale: string;
  /** The metrics consumed by the strategy (raw, unaltered). */
  readonly contextMetrics: ReadonlyArray<ModelMetricSnapshot>;
}

/** Supported strategy names (persisted in config tables, feature flags, etc.). */
export enum StrategyType {
  AB_TEST = 'AB_TEST',
  UCB1_BANDIT = 'UCB1_BANDIT',
}

/**
 * Input passed to the strategy for decision making.
 * Kept deliberately narrow: core domain must not depend on transport-layer details.
 */
export interface ModelSelectionContext {
  readonly requestId: string;
  readonly candidateModels: ReadonlyArray<ModelMetricSnapshot>;
  readonly additionalPayload?: Record<string, unknown>; // extensibility hook
}

/* ------------------------------------------------------------------ */
/*                       Strategy Pattern (Port)                       */
/* ------------------------------------------------------------------ */

/** The algorithm contract that concrete strategies must implement. */
export interface ModelSelectionStrategy {
  readonly type: StrategyType;
  /**
   * @throws ModelSelectionError if something goes wrong (e.g., no eligible models)
   */
  selectModel(context: ModelSelectionContext): ModelVersionId;
  /**
   * A machine-explainable reason of why the last selection has been made.
   * DOES NOT mutate internal state – safe to call multiple times.
   */
  getLastRationale(): string;
}

/* ------------------------------------------------------------------ */
/*                        Custom Domain Exceptions                     */
/* ------------------------------------------------------------------ */

/** Marker interface so callers can catch all domain errors in one shot. */
export interface DomainError extends Error {
  readonly isDomainError: true;
}

export class ModelSelectionError extends Error implements DomainError {
  readonly isDomainError = true;
  constructor(msg: string, public readonly cause?: unknown) {
    super(msg);
    this.name = 'ModelSelectionError';
  }
}

/* ------------------------------------------------------------------ */
/*                Concrete Strategy Implementations                    */
/* ------------------------------------------------------------------ */

/**
 * Classic A/B test – return the model with the highest rewardMean.
 * In production you might add significance testing, min sample size, etc.
 */
class ABTestingStrategy implements ModelSelectionStrategy {
  readonly type = StrategyType.AB_TEST;
  private _lastRationale = 'No selection yet';

  selectModel(context: ModelSelectionContext): ModelVersionId {
    if (context.candidateModels.length === 0) {
      throw new ModelSelectionError('[ABTesting] No candidate models provided');
    }

    const sorted = [...context.candidateModels].sort(
      (a, b) => b.rewardMean - a.rewardMean,
    );
    const winner = sorted[0];
    this._lastRationale = `Winner chosen by highest rewardMean (${winner.rewardMean.toFixed(
      4,
    )}) among ${context.candidateModels.length} candidates.`;

    return winner.modelVersionId;
  }

  getLastRationale(): string {
    return this._lastRationale;
  }
}

/**
 * Upper-Confidence-Bound (UCB1) multi-armed bandit.
 * Balances exploration vs exploitation mathematically.
 */
class UCB1BanditStrategy implements ModelSelectionStrategy {
  readonly type = StrategyType.UCB1_BANDIT;
  private _lastRationale = 'No selection yet';
  /** Avoid divide-by-zero for brand-new models. */
  private static readonly EPSILON = 1e-12;

  selectModel(context: ModelSelectionContext): ModelVersionId {
    const { candidateModels } = context;

    if (candidateModels.length === 0) {
      throw new ModelSelectionError('[UCB1] No candidate models provided');
    }

    const totalPlays = candidateModels.reduce(
      (acc, m) => acc + m.observationCount,
      0,
    );

    if (totalPlays === 0) {
      // Cold-start: route uniformly at random.
      const randomChoice =
        candidateModels[Math.floor(Math.random() * candidateModels.length)];
      this._lastRationale =
        'All models cold-start; selected uniformly at random.';
      return randomChoice.modelVersionId;
    }

    let bestScore = -Infinity;
    let best: ModelMetricSnapshot | null = null;
    const explorationConstant = 2; // tune per business requirement

    for (const m of candidateModels) {
      const meanReward = m.rewardMean;
      const explorationTerm = Math.sqrt(
        (explorationConstant *
          Math.log(totalPlays + UCB1BanditStrategy.EPSILON)) /
          (m.observationCount + UCB1BanditStrategy.EPSILON),
      );
      const ucbScore = meanReward + explorationTerm;

      if (ucbScore > bestScore) {
        bestScore = ucbScore;
        best = m;
      }
    }

    if (!best) {
      throw new ModelSelectionError('[UCB1] Internal algorithm failure');
    }

    this._lastRationale = `Selected via UCB1: ucbScore=${bestScore.toFixed(
      4,
    )}, rewardMean=${best.rewardMean.toFixed(
      4,
    )}, observations=${best.observationCount}.`;

    return best.modelVersionId;
  }

  getLastRationale(): string {
    return this._lastRationale;
  }
}

/* ------------------------------------------------------------------ */
/*                    Factory Pattern (Domain Service)                 */
/* ------------------------------------------------------------------ */

/** Configuration object that can be injected by an adapter (feature flag, DB row, …). */
export interface StrategyConfiguration {
  readonly type: StrategyType;
}

/**
 * Resolves a concrete strategy implementation based on configuration.
 * Pure function, convenient for DI / unit testing.
 */
function strategyFactory(config: StrategyConfiguration): ModelSelectionStrategy {
  switch (config.type) {
    case StrategyType.AB_TEST:
      return new ABTestingStrategy();
    case StrategyType.UCB1_BANDIT:
      return new UCB1BanditStrategy();
    default: {
      // Exhaustiveness guard
      const _exhaustiveCheck: never = config.type;
      throw new ModelSelectionError(
        `Unknown strategy type: ${(config as StrategyConfiguration).type}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/*                    Observer Pattern (Domain Event)                  */
/* ------------------------------------------------------------------ */

export interface SelectionObserver {
  onModelSelected(event: ModelSelectionEvent): void | Promise<void>;
}

/** Trivial implementation – real adapters could write to Kafka, Slack, etc. */
export class ConsoleLoggingObserver implements SelectionObserver {
  onModelSelected(event: ModelSelectionEvent): void {
    // eslint-disable-next-line no-console
    console.info(
      `[InsightHexaAI] Model selected: ${JSON.stringify(event, null, 2)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/*                    High-level Selection Orchestrator                */
/* ------------------------------------------------------------------ */

/**
 * Core domain service: given a list of candidate models and a configured strategy,
 * decide which model version an inference request should hit.
 *
 * Purely synchronous API – adapters may wrap it in async if they wish.
 */
export class ModelSelectionService {
  private readonly observers = new Set<SelectionObserver>();
  private readonly strategy: ModelSelectionStrategy;

  constructor(config: StrategyConfiguration) {
    this.strategy = strategyFactory(config);
  }

  /**
   * Register an observer (idempotent).
   * @param observer – implementation must be side-effect free from domain POV
   */
  public registerObserver(observer: SelectionObserver): void {
    this.observers.add(observer);
  }

  /**
   * Remove an observer.
   */
  public unregisterObserver(observer: SelectionObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Select the best model for a given context, notify observers, and return the winner.
   */
  public select(
    candidateModels: ReadonlyArray<ModelMetricSnapshot>,
    requestId: string = randomUUID(),
  ): ModelVersionId {
    const context: ModelSelectionContext = { requestId, candidateModels };

    const selectedModelVersionId = this.strategy.selectModel(context);

    const event: ModelSelectionEvent = {
      requestId,
      selectedModelVersionId,
      strategyUsed: this.strategy.type,
      rationale: this.strategy.getLastRationale(),
      contextMetrics: candidateModels,
    };

    this.notifyObservers(event).catch((err) => {
      // Fail-open: selection should not error because of observer issues.
      // eslint-disable-next-line no-console
      console.error(
        `[InsightHexaAI] Observer(s) failed for event ${requestId}:`,
        err,
      );
    });

    return selectedModelVersionId;
  }

  /* ------------------------------------------------------------------ */
  /*                        Private Helper Methods                      */
  /* ------------------------------------------------------------------ */

  private async notifyObservers(event: ModelSelectionEvent): Promise<void> {
    const promises: Array<Promise<void>> = [];

    for (const obs of this.observers) {
      try {
        const maybePromise = obs.onModelSelected(event);
        if (maybePromise instanceof Promise) promises.push(maybePromise);
      } catch (err) {
        // Convert sync throw into rejected promise so Promise.all handles it.
        promises.push(Promise.reject(err));
      }
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }
}

/* ------------------------------------------------------------------ */
/*                        Default Service Export                       */
/* ------------------------------------------------------------------ */

/**
 * Convenience factory so adapters can do:
 *     const service = createDefaultModelSelectionService();
 */
export function createDefaultModelSelectionService(
  overrides?: Partial<StrategyConfiguration>,
): ModelSelectionService {
  const defaultConfig: StrategyConfiguration = {
    type: StrategyType.UCB1_BANDIT,
  };
  return new ModelSelectionService({ ...defaultConfig, ...overrides });
}
```