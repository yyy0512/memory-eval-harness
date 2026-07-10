```typescript
/**************************************************************************************************
 *  InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 *  -----------------------------------------------------------------------------------------------
 *  File:        src/module_2.ts
 *  Description: Core hexagon “Model Selection” domain module. Implements Strategy Pattern for
 *               choosing an ML model variant (A/B-testing, Multi-Armed Bandit, …) during real-time
 *               inference. Emits Observer Pattern domain events to downstream adapters
 *               (dashboards, alerts). Pure domain logic: no external IO concerns here.
 **************************************************************************************************/

/* =================================================================================================
 *  SECTION 1 ─ Domain Types & Contracts
 * =============================================================================================== */

export type KPI = 'ctr' | 'conversion_rate' | 'revenue';

/**
 * Contextual information available during an online inference request.
 * NOTE: Only immutable, business-level data live here—no HTTP, gRPC, or DB specifics.
 */
export interface InferenceContext {
  readonly userId: string;
  readonly timestamp: number;             // epoch millis
  readonly kpi: KPI;                      // Primary KPI the caller cares about
  readonly attributes?: Record<string, unknown>; // Auxiliary segment data (region, cohort, etc.)
}

/**
 * Lightweight representation of a candidate model ready to serve traffic.
 * The fully-hydrated weights or runtime container are loaded by adapters *after* the ID is selected.
 */
export interface ModelCandidate {
  readonly id: string;                    // e.g. “churn-xgb/v13”
  readonly performance: Record<KPI, number>; // KPI-specific historical performance metric (0.0-1.0)
  readonly explorationWeight?: number;    // Bandit exploration hyper-parameter (0-1; default 0.1)
  readonly lastUpdated: number;           // epoch millis
}

/**
 * Port that provides read-only access to model metadata.
 * Implemented by adapters that talk to Model Registry, Feature Store, etc.
 */
export interface ModelRepositoryPort {
  /**
   * Return all models eligible for the given KPI (and likely business constraints like SLA tier).
   */
  fetchCandidates(kpi: KPI): Promise<ModelCandidate[]>;
}

/**
 * Event Bus (Observer Pattern) for broadcasting domain events to other hexagon services
 * (dashboard updaters, audit loggers, SLA watchdogs, …).
 */
export interface EventBusPort {
  publish<T extends DomainEvent>(event: T): Promise<void>;
}

/** Generic domain event marker. */
export abstract class DomainEvent {
  readonly occurredOn = Date.now();
  abstract readonly name: string;
}

/**
 * A model selection decision has been made for an inference request.
 */
export class ModelChosenEvent extends DomainEvent {
  readonly name = 'ModelChosenEvent';
  constructor(
    public readonly context: InferenceContext,
    public readonly chosenModel: ModelCandidate,
  ) {
    super();
  }
}

/**
 * Exception thrown when model selection cannot be performed.
 */
export class ModelSelectionError extends Error {
  constructor(message: string, public readonly context?: InferenceContext) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/* =================================================================================================
 *  SECTION 2 ─ Strategy Pattern – Domain Algorithms
 * =============================================================================================== */

/**
 * Strategy interface for model selection algorithms.
 */
export interface ModelSelectionStrategy {
  chooseModel(
    context: InferenceContext,
    candidates: ModelCandidate[],
  ): ModelCandidate;
}

/**
 * A/B testing strategy that deterministically buckets users into models
 * based on a modulus hash of `userId`. Ensures sticky assignment.
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
  chooseModel(
    context: InferenceContext,
    candidates: ModelCandidate[],
  ): ModelCandidate {
    if (candidates.length === 0) {
      throw new ModelSelectionError('No candidates provided to ABTestingStrategy', context);
    }

    const idx =
      this.simpleHash(context.userId) %
      candidates.length;

    return candidates[idx];
  }

  /** Very simple non-crypto hash for sticky bucketing; acceptable for domain logic. */
  private simpleHash(input: string): number {
    let hash = 0;
    /* eslint-disable no-bitwise */
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0; // Convert to 32bit int
    }
    /* eslint-enable no-bitwise */
    return Math.abs(hash);
  }
}

/**
 * ε-greedy Multi-Armed Bandit selection strategy.
 * Explores randomly with probability ε else exploits best performing model.
 */
export class MultiArmedBanditStrategy implements ModelSelectionStrategy {
  constructor(private readonly epsilon: number = 0.1) {
    if (epsilon < 0 || epsilon > 1) {
      throw new Error('ε must be in [0,1]');
    }
  }

  chooseModel(
    context: InferenceContext,
    candidates: ModelCandidate[],
  ): ModelCandidate {
    if (candidates.length === 0) {
      throw new ModelSelectionError('No candidates provided to MultiArmedBanditStrategy', context);
    }

    const explore = Math.random() < this.epsilon;
    if (explore) {
      // Weighted random exploration based on optional explorationWeight
      return this.weightedRandomChoice(candidates);
    }

    // Exploit: choose model with best historical KPI performance
    const sorted = [...candidates].sort(
      (a, b) => (b.performance[context.kpi] ?? 0) - (a.performance[context.kpi] ?? 0),
    );
    return sorted[0];
  }

  private weightedRandomChoice(models: ModelCandidate[]): ModelCandidate {
    const totalWeight = models.reduce(
      (sum, m) => sum + (m.explorationWeight ?? 1 / models.length),
      0,
    );
    let threshold = Math.random() * totalWeight;

    /* eslint-disable no-restricted-syntax */
    for (const m of models) {
      threshold -= m.explorationWeight ?? 1 / models.length;
      if (threshold <= 0) {
        return m;
      }
    }
    /* eslint-enable no-restricted-syntax */

    // Fallback (should not reach here)
    return models[models.length - 1];
  }
}

/* =================================================================================================
 *  SECTION 3 ─ Factory Pattern – Create Strategy from config
 * =============================================================================================== */

/**
 * Allowed strategy identifiers for external configuration files, env vars, etc.
 */
export type StrategyKey = 'ab_testing' | 'multi_armed_bandit';

export class ModelSelectionStrategyFactory {
  static create(key: StrategyKey, options?: { epsilon?: number }): ModelSelectionStrategy {
    switch (key) {
      case 'ab_testing':
        return new ABTestingStrategy();
      case 'multi_armed_bandit':
        return new MultiArmedBanditStrategy(options?.epsilon ?? 0.1);
      default:
        // Exhaustive check in TypeScript (should never compile with unknown key)
        /* eslint-disable-next-line @typescript-eslint/no-unused-vars */
        const _exhaustive: never = key;
        throw new Error(`Unsupported strategy: ${key}`);
    }
  }
}

/* =================================================================================================
 *  SECTION 4 ─ Domain Service – Model Selector
 * =============================================================================================== */

/**
 * Stateless domain service responsible for orchestrating:
 *   1. Loading candidate models via the ModelRepositoryPort (left side of hexagon),
 *   2. Delegating decision logic to a ModelSelectionStrategy,
 *   3. Emitting a ModelChosenEvent via EventBusPort (right side of hexagon).
 */
export class ModelSelectorService {
  constructor(
    private readonly repository: ModelRepositoryPort,
    private readonly eventBus: EventBusPort,
    private readonly strategy: ModelSelectionStrategy,
  ) {}

  /**
   * Pick a model for inference according to current strategy.
   */
  async select(context: InferenceContext): Promise<ModelCandidate> {
    const candidates = await this.repository.fetchCandidates(context.kpi);

    if (candidates.length === 0) {
      throw new ModelSelectionError(
        `No candidate models available for KPI=${context.kpi}`,
        context,
      );
    }

    const chosen = this.strategy.chooseModel(context, candidates);

    // Business invariant: selected model must come from provided candidates
    if (!candidates.some((c) => c.id === chosen.id)) {
      /* c8 ignore next */
      throw new ModelSelectionError(
        `Strategy returned model=${chosen.id} not in repository list`,
        context,
      );
    }

    // Notify observers (dashboards, audit logs, SLA monitors…)
    await this.eventBus.publish(new ModelChosenEvent(context, chosen));

    return chosen;
  }
}

/* =================================================================================================
 *  SECTION 5 ─ Example Adapter Stubs (for compile-time completeness only)
 * =============================================================================================== */

/**
 * Very lightweight, in-memory model repository adapter.
 * NOT for production—only useful for unit tests and local development.
 */
export class InMemoryModelRepository implements ModelRepositoryPort {
  private readonly storage: Record<KPI, ModelCandidate[]> = {
    ctr: [],
    conversion_rate: [],
    revenue: [],
  };

  constructor(initialModels: ModelCandidate[] = []) {
    for (const model of initialModels) {
      this.add(model);
    }
  }

  async fetchCandidates(kpi: KPI): Promise<ModelCandidate[]> {
    return this.storage[kpi] ?? [];
  }

  /** Non-port helper for tests */
  add(model: ModelCandidate): void {
    for (const kpi of Object.keys(this.storage) as KPI[]) {
      if (!this.storage[kpi]) this.storage[kpi] = [];
    }
    this.storage[model.performance ? (Object.keys(model.performance)[0] as KPI) : 'ctr'].push(model);
  }
}

/**
 * Simple synchronous EventBus adapter that just logs events.
 * Replace with Kafka, SNS, Postgres… in real adapters.
 */
export class ConsoleEventBus implements EventBusPort {
  /* eslint-disable @typescript-eslint/require-await */
  async publish<T extends DomainEvent>(event: T): Promise<void> {
    // In a real adapter, events would be serialized + persisted
    // Here we just log for observability in local dev
    /* eslint-disable no-console */
    console.info(`[EVENT] ${event.name}`, JSON.stringify(event, null, 2));
  }
  /* eslint-enable @typescript-eslint/require-await */
}

/* =================================================================================================
 *  SECTION 6 ─ Usage Example (can be removed in production bundle)
 * =============================================================================================== */

// The following block demonstrates DI wiring inside the hexagon. It will not run in Jest test
// environments unless manually invoked. Comment out in serverless or worker contexts.

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    const repo = new InMemoryModelRepository([
      {
        id: 'modelA',
        performance: { ctr: 0.12 },
        explorationWeight: 0.5,
        lastUpdated: Date.now(),
      },
      {
        id: 'modelB',
        performance: { ctr: 0.18 },
        explorationWeight: 0.5,
        lastUpdated: Date.now(),
      },
    ]);

    const bus = new ConsoleEventBus();
    const strategy = ModelSelectionStrategyFactory.create('multi_armed_bandit', { epsilon: 0.2 });
    const selector = new ModelSelectorService(repo, bus, strategy);

    const ctx: InferenceContext = {
      userId: 'user-123',
      timestamp: Date.now(),
      kpi: 'ctr',
      attributes: { region: 'EMEA' },
    };

    /* eslint-disable no-console */
    try {
      const model = await selector.select(ctx);
      console.log(`Chosen model for user=${ctx.userId}: ${model.id}`);
    } catch (err) {
      console.error('[ModelSelectorService] Error:', err);
    }
  })();
}
```