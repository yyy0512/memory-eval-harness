```typescript
/********************************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs (ml_inference)
 *  ---------------------------------------------------------------------------------------------------------------
 *  File:        src/module_24.ts
 *  Purpose:     Core-domain module implementing “model-selection” inside the hexagon.
 *               Combines Strategy, Factory and Observer patterns to decide which model
 *               version should serve predictions at any point in time, based on KPI data
 *               streaming in from external adapters (model monitoring, experiment tracking, etc.).
 *
 *  IMPORTANT:   This file belongs to the Core domain layer—no framework, database or HTTP code here!
 *******************************************************************************************************************/

///////////////////////////////////////
// SECTION 1: Domain-level exceptions //
///////////////////////////////////////

/**
 * DomainError is the generic base class for all errors that can occur in the core domain.
 * Extending the built-in Error keeps stack traces intact while enabling rich semantic types.
 */
export abstract class DomainError extends Error {
  public readonly name: string = this.constructor.name;

  constructor(message: string, public readonly cause?: Error) {
    super(message);
    if (cause) {
      this.stack += `\nCaused by: ${cause.stack}`;
    }
    Object.setPrototypeOf(this, new.target.prototype); // restore prototype chain
  }
}

/**
 * Thrown when no viable model can be chosen by a Strategy.
 */
export class NoModelCandidateError extends DomainError {
  constructor(public readonly contextId: string) {
    super(`No model candidate could be selected for context: ${contextId}`);
  }
}

///////////////////////////////////////
// SECTION 2: Value Objects & Types  //
///////////////////////////////////////

/**
 * Immutable representation of a KPI value at a given time.
 */
export interface KPI {
  readonly name: string;
  readonly value: number; // assume normalized 0..1 for simplicity
}

/**
 * ModelPerformance captures periodic performance metrics for a deployed model version.
 */
export interface ModelPerformance {
  readonly modelVersion: string;
  readonly kpis: Readonly<Record<string, KPI>>;
  readonly lastUpdated: Date;
}

/**
 * Context given to the Strategy for a model-selection decision.
 */
export interface SelectionContext {
  readonly contextId: string; // e.g. “churn-prediction-prod”
  readonly performances: ReadonlyArray<ModelPerformance>;
  readonly targetKPI: string; // KPI to optimize for (e.g. ‘f1_score’)
  readonly explorationRate?: number; // 0…1, only used by strategies needing exploration
}

///////////////////////////////////////
// SECTION 3: Strategy Pattern       //
///////////////////////////////////////

/**
 * Strategy interface: All model-selection strategies must comply.
 * Returning the chosen modelVersion (string).
 */
export interface ModelSelectionStrategy {
  readonly name: string;
  selectModel(context: SelectionContext): string;
}

/**
 * Simple A/B test strategy. Chooses model with strictly highest KPI, no exploration.
 * If multiple versions share the same best KPI, round-robin between them to avoid starvation.
 */
export class ABTestStrategy implements ModelSelectionStrategy {
  public readonly name = 'AB_TEST';

  private roundRobinIdx: number = 0;

  selectModel(context: SelectionContext): string {
    const { performances, targetKPI } = context;

    if (performances.length === 0) {
      throw new NoModelCandidateError(context.contextId);
    }

    // Determine the current best KPI value.
    const bestValue = Math.max(
      ...performances.map((p) => p.kpis[targetKPI]?.value ?? Number.NEGATIVE_INFINITY)
    );

    // Filter candidates that hit the best KPI.
    const bestCandidates = performances.filter(
      (p) => (p.kpis[targetKPI]?.value ?? Number.NEGATIVE_INFINITY) === bestValue
    );

    if (bestCandidates.length === 0) {
      throw new NoModelCandidateError(context.contextId);
    }

    // Pick next candidate in round-robin manner to distribute traffic.
    const chosen = bestCandidates[this.roundRobinIdx % bestCandidates.length].modelVersion;
    this.roundRobinIdx++;

    return chosen;
  }
}

/**
 * Epsilon-greedy Multi-Armed Bandit strategy.
 * Explores (random) with probability epsilon, exploits otherwise.
 */
export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  public readonly name = 'EPSILON_GREEDY_BANDIT';

  constructor(private readonly defaultEpsilon = 0.1, private readonly rng = Math.random) {}

  selectModel(context: SelectionContext): string {
    const { performances, targetKPI, explorationRate } = context;

    if (performances.length === 0) {
      throw new NoModelCandidateError(context.contextId);
    }

    const epsilon = explorationRate ?? this.defaultEpsilon;

    // Decide whether to explore or exploit.
    if (this.rng() < epsilon) {
      // Explore: uniformly random pick among all versions.
      const randomIdx = Math.floor(this.rng() * performances.length);
      return performances[randomIdx].modelVersion;
    }

    // Exploit: Use version with highest KPI.
    const bestValue = Math.max(
      ...performances.map((p) => p.kpis[targetKPI]?.value ?? Number.NEGATIVE_INFINITY)
    );

    const bestCandidates = performances.filter(
      (p) => (p.kpis[targetKPI]?.value ?? Number.NEGATIVE_INFINITY) === bestValue
    );

    // Break ties randomly to avoid positional bias
    const randomIdx = Math.floor(this.rng() * bestCandidates.length);
    return bestCandidates[randomIdx].modelVersion;
  }
}

///////////////////////////////////////
// SECTION 4: Strategy Factory       //
///////////////////////////////////////

/**
 * Registry-based factory, lets product managers wire strategies via config without code change.
 */
export class ModelSelectionStrategyFactory {
  private static readonly registry: Map<string, ModelSelectionStrategy> = new Map([
    ['AB_TEST', new ABTestStrategy()],
    ['EPSILON_GREEDY_BANDIT', new MultiArmedBanditStrategy()],
  ]);

  static getStrategy(name: string): ModelSelectionStrategy {
    const strategy = this.registry.get(name);
    if (!strategy) {
      throw new DomainError(`ModelSelectionStrategy '${name}' is not registered.`);
    }
    return strategy;
  }

  /**
   * Allows dynamic registration at runtime, e.g. from a feature flag service.
   */
  static register(name: string, strategy: ModelSelectionStrategy): void {
    this.registry.set(name, strategy);
  }
}

///////////////////////////////////////
// SECTION 5: Observer Pattern       //
///////////////////////////////////////

/**
 * Domain event emitted whenever a model selection decision has been made.
 */
export interface ModelSelectedEvent {
  readonly contextId: string;
  readonly strategyName: string;
  readonly chosenModelVersion: string;
  readonly timestamp: Date;
}

/**
 * Observer/Listener of model-selection events.
 */
export interface ModelSelectionObserver {
  onModelSelected(event: ModelSelectedEvent): void;
}

/**
 * Simple in-memory multicast observable.
 * In production, an adapter would translate this to e.g. Kafka or SNS.
 */
export class ModelSelectionEventBus {
  private observers: Set<ModelSelectionObserver> = new Set();

  register(observer: ModelSelectionObserver): void {
    this.observers.add(observer);
  }

  unregister(observer: ModelSelectionObserver): void {
    this.observers.delete(observer);
  }

  emit(event: ModelSelectedEvent): void {
    for (const observer of this.observers) {
      try {
        observer.onModelSelected(event);
      } catch (err) {
        // Guarantee all observers get a chance; log and continue.
        // (A real implementation would delegate logging to a port.)
        // eslint-disable-next-line no-console
        console.error('Observer failed to handle ModelSelectedEvent', err);
      }
    }
  }
}

///////////////////////////////////////
// SECTION 6: Application-service    //
///////////////////////////////////////

/**
 * Core application service: decides which model to serve and notifies observers.
 * This class is PURE domain logic—no frameworks or IO.
 */
export class ModelSelectorService {
  constructor(
    private readonly strategyFactory: typeof ModelSelectionStrategyFactory,
    private readonly eventBus: ModelSelectionEventBus
  ) {}

  /**
   * Selects a model using the requested strategy and fires an event.
   */
  selectModel(
    strategyName: string,
    context: SelectionContext
  ): { chosenModelVersion: string; event: ModelSelectedEvent } {
    const strategy = this.strategyFactory.getStrategy(strategyName);

    const chosenModelVersion = strategy.selectModel(context);

    const event: ModelSelectedEvent = {
      contextId: context.contextId,
      strategyName,
      chosenModelVersion,
      timestamp: new Date(),
    };

    // Notify observers synchronously; adapters can spawn async if desired.
    this.eventBus.emit(event);

    return { chosenModelVersion, event };
  }
}

///////////////////////////////////////
// SECTION 7: Example Observers      //
///////////////////////////////////////

/**
 * Observer capturing audit trail for compliance reporting.
 */
export class AuditTrailObserver implements ModelSelectionObserver {
  constructor(private readonly persist: (event: ModelSelectedEvent) => Promise<void>) {}

  async onModelSelected(event: ModelSelectedEvent): Promise<void> {
    // Delegate persistence to injected port (DB, ledger, etc.)
    await this.persist(event);
  }
}

/**
 * Observer pushing metrics to in-memory feature store for quick dashboard refresh.
 */
export class MetricsObserver implements ModelSelectionObserver {
  private readonly counts: Map<string, number> = new Map();

  onModelSelected(event: ModelSelectedEvent): void {
    const key = `${event.contextId}|${event.chosenModelVersion}`;
    const prev = this.counts.get(key) ?? 0;
    this.counts.set(key, prev + 1);
  }

  dumpCounts(): ReadonlyMap<string, number> {
    return this.counts;
  }
}
```