```typescript
/****************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * File:        src/module_58.ts
 * Module:      Model Selection (Strategy & Observer Patterns)
 * Description: Provides pluggable model-selection strategies (A/B, Multi-Armed Bandit)
 *              and a small observer implementation to propagate selection events to
 *              monitoring dashboards, audit logs, etc. 100 % side-effect free—adapters
 *              must implement the respective ports.
 ****************************************************************************************/

// External -----------------------------------------------------------------------------------------------------------
import { v4 as uuid } from 'uuid';

// Domain Types --------------------------------------------------------------------------------------------------------
/**
 * Immutable snapshot of a model’s real-time or offline performance.
 * Adapters (e.g., Kafka consumer) map raw messages into this DTO before
 * it reaches the hexagon.
 */
export interface CandidateModelPerformance {
  readonly modelId: string;
  /** Business KPI—we allow arbitrary metric buckets to keep core generic. */
  readonly metrics: Record<string, number>;
  /** Inference cost in cents; used for cost-aware strategies. */
  readonly costPerPrediction: number;
  /** Timestamp (ms) when the snapshot was generated. */
  readonly capturedAt: number;
}

/**
 * Raised whenever the selector chooses a new primary model.
 * You may feed this into the Observer_Pattern’s domain event bus.
 */
export interface ModelSelectedEvent {
  readonly eventId: string;
  readonly modelId: string;
  readonly strategyName: string;
  readonly decidedAt: number;
}

// Ports (Hexagonal) ---------------------------------------------------------------------------------------------------
/**
 * Outbound port—persists the selector’s decisions for
 * reproducibility and audit trails.
 */
export interface ModelSelectionRepositoryPort {
  saveSelection(event: ModelSelectedEvent): Promise<void>;
}

/**
 * Outbound port—publishes events so subscribers (dashboards, alerting, etc.)
 * receive real-time updates without coupling to business logic.
 */
export interface DomainEventBusPort {
  publish<T extends object>(event: T): Promise<void>;
}

// Strategy Pattern Interfaces ----------------------------------------------------------------------------------------
/**
 * All model-selection strategies must implement this interface.
 */
export interface ModelSelectionStrategy {
  readonly name: string;
  /**
   * @throws Error when candidates array is empty or invalid
   */
  selectModel(candidates: readonly CandidateModelPerformance[]): string;
}

/**
 * Simple traffic split strategy—selects the model with the highest conversion
 * (or any arbitrary metric) after a cool-off period.
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
  public readonly name = 'AB_TESTING';

  constructor(private readonly metricKey: string) {}

  public selectModel(
    candidates: readonly CandidateModelPerformance[]
  ): string {
    if (!candidates.length) {
      throw new Error(
        `[${this.name}] Cannot select model. Candidate list is empty.`
      );
    }

    const sorted = [...candidates]
      .filter(c => c.metrics[this.metricKey] !== undefined)
      .sort(
        (a, b) =>
          (b.metrics[this.metricKey] ?? Number.NEGATIVE_INFINITY) -
          (a.metrics[this.metricKey] ?? Number.NEGATIVE_INFINITY)
      );

    if (!sorted.length) {
      throw new Error(
        `[${this.name}] None of the candidates contain metric '${this.metricKey}'.`
      );
    }

    return sorted[0].modelId;
  }
}

/**
 * Classic Thompson Sampling Multi-Armed Bandit implementation.
 * Assumes binary reward (success/failure) stored under metricKey_successes
 * and metricKey_failures for each candidate.
 */
export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  public readonly name = 'THOMPSON_SAMPLING';
  constructor(private readonly metricKey: string) {}

  public selectModel(
    candidates: readonly CandidateModelPerformance[]
  ): string {
    if (!candidates.length) {
      throw new Error(
        `[${this.name}] Cannot select model. Candidate list is empty.`
      );
    }

    const betaSamples = candidates.map(candidate => {
      const success =
        candidate.metrics[`${this.metricKey}_successes`] ?? 1; // pseudo-count
      const failure =
        candidate.metrics[`${this.metricKey}_failures`] ?? 1; // pseudo-count

      // Draw from Beta(success+1, failure+1) using simple approximation.
      const sample =
        this.sampleGamma(success + 1) /
        (this.sampleGamma(success + 1) + this.sampleGamma(failure + 1));

      return { modelId: candidate.modelId, sample };
    });

    const chosen = betaSamples.reduce((prev, curr) =>
      curr.sample > prev.sample ? curr : prev
    );

    return chosen.modelId;
  }

  // ---------------------------------------------------------------------------
  // PRIVATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Samples from a Gamma(shape, 1) distribution using Marsaglia & Tsang method.
   * Note: For production you may prefer libraries like `random-js`.
   */
  /* eslint-disable @typescript-eslint/no-magic-numbers */
  private sampleGamma(shape: number): number {
    const d = shape < 1 ? shape + (1 / 3) : shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    // Rejection sampling loop
    while (true) {
      let x: number, v: number;
      do {
        x = this.boxMullerRandom();
        v = 1 + c * x;
      } while (v <= 0);
      v = v ** 3;
      const u = Math.random();
      if (
        u < 1 - 0.331 * x ** 4 ||
        Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))
      ) {
        if (shape < 1) {
          const u2 = Math.random();
          return d * v * u2 ** (1 / shape);
        }
        return d * v;
      }
    }
  }

  /**
   * Generates a standard normal using Box-Muller transform.
   */
  private boxMullerRandom(): number {
    const u = Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /* eslint-enable @typescript-eslint/no-magic-numbers */
}

// Factory Pattern -----------------------------------------------------------------------------------------------------
export enum StrategyType {
  AB_TESTING = 'AB_TESTING',
  THOMPSON_SAMPLING = 'THOMPSON_SAMPLING',
}

export interface StrategyFactoryOptions {
  type: StrategyType;
  metricKey: string;
}

export class ModelSelectionStrategyFactory {
  public static create(
    opts: StrategyFactoryOptions
  ): ModelSelectionStrategy {
    switch (opts.type) {
      case StrategyType.AB_TESTING:
        return new ABTestingStrategy(opts.metricKey);
      case StrategyType.THOMPSON_SAMPLING:
        return new MultiArmedBanditStrategy(opts.metricKey);
      default:
        /* istanbul ignore next */
        throw new Error(`Unknown strategy type: ${opts.type as string}`);
    }
  }
}

// Observer Pattern Implementation -------------------------------------------------------------------------------------
export interface ModelSelectionObserver {
  onModelSelected(event: ModelSelectedEvent): void | Promise<void>;
}

export class ObservableModelSelector {
  private readonly observers = new Set<ModelSelectionObserver>();

  public subscribe(observer: ModelSelectionObserver): void {
    this.observers.add(observer);
  }

  public unsubscribe(observer: ModelSelectionObserver): void {
    this.observers.delete(observer);
  }

  public async notify(event: ModelSelectedEvent): Promise<void> {
    for (const observer of this.observers) {
      try {
        await observer.onModelSelected(event);
      } catch (err) {
        // Fail-fast is not desirable here; isolate faulty observers.
        /* eslint-disable no-console */
        console.error(
          `[ObservableModelSelector] Observer error: ${(err as Error).message}`,
          err
        );
        /* eslint-enable no-console */
      }
    }
  }
}

// Domain Service ------------------------------------------------------------------------------------------------------
export interface ModelSelectorServiceDependencies {
  repository: ModelSelectionRepositoryPort;
  eventBus: DomainEventBusPort;
  strategy: ModelSelectionStrategy;
  observable: ObservableModelSelector;
}

export class ModelSelectorService {
  private readonly deps: ModelSelectorServiceDependencies;

  constructor(deps: ModelSelectorServiceDependencies) {
    this.deps = deps;
  }

  /**
   * Primary entry point. Chooses the winning model, persists the decision,
   * publishes an event, and notifies in-memory observers.
   */
  public async decide(
    candidates: readonly CandidateModelPerformance[]
  ): Promise<ModelSelectedEvent> {
    const modelId = this.deps.strategy.selectModel(candidates);

    const event: ModelSelectedEvent = {
      eventId: uuid(),
      modelId,
      strategyName: this.deps.strategy.name,
      decidedAt: Date.now(),
    };

    // Persistence and event propagation happens in parallel.
    await Promise.all([
      this.deps.repository.saveSelection(event),
      this.deps.eventBus.publish(event),
      this.deps.observable.notify(event),
    ]);

    return event;
  }
}

// ----- Example Observer ---------------------------------------------------------
/**
 * Simple in-memory observer for demonstration. In real deployments, adapt to
 * send Slack messages, trigger PagerDuty incidents, or update Grafana dashboards.
 */
export class ConsoleLoggingObserver implements ModelSelectionObserver {
  public onModelSelected(event: ModelSelectedEvent): void {
    /* eslint-disable no-console */
    console.info(
      `[ConsoleLoggingObserver] Selected model '${event.modelId}' ` +
        `using strategy '${event.strategyName}' at ${new Date(
          event.decidedAt
        ).toISOString()}`
    );
    /* eslint-enable no-console */
  }
}
```