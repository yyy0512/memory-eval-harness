```typescript
/******************************************************************************************
 * InsightHexaAI: Strategic ML Inference Suite for Enterprise KPIs
 * ----------------------------------------------------------------------------------------
 * File:        src/module_39.ts
 * Description: KPI-centric inference orchestrator that wires together the Strategy-,
 *              Factory-, and Observer-patterns.  This orchestrator is 100 % domain-driven
 *              (inside the “hexagon”) and therefore technology-agnostic.  External
 *              adapters (Kafka, S3, TF-Serving, etc.) must implement the ports declared
 *              below.
 ******************************************************************************************/

import { EventEmitter } from 'events';
import crypto from 'crypto';

/* -------------------------------------------------------------------------- */
/*                                  Types                                     */
/* -------------------------------------------------------------------------- */

/**
 * Lightweight KPI identifier—kept as branded type to avoid accidental mix-ups.
 */
export type KPI = string & { readonly __brand: unique symbol };

/**
 * Free-form JSON that enters the hexagon for prediction.
 * In practice, callers should define stronger typing in their own bounded
 * contexts and cast accordingly.
 */
export type FeatureVector = Record<string, unknown>;

/**
 * Generic model output.  As with FeatureVector, callers are encouraged
 * to refine this via generics or type narrowing.
 */
export type Prediction<T = unknown> = T;

/* -------------------------------------------------------------------------- */
/*                                   Ports                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read-only port allowing the domain to discover ML models.
 */
export interface ModelRegistryPort {
  /**
   * Returns every model that claims to serve the given KPI.
   */
  fetchCandidates(kpi: KPI): Promise<ModelMetadata[]>;
}

/**
 * Side-effecting port that performs the actual model inference.
 */
export interface ModelPredictionPort {
  /**
   * Executes a prediction for the given model.
   */
  predict<TOutput = Prediction>(
    modelId: string,
    input: FeatureVector,
  ): Promise<TOutput>;
}

/* -------------------------------------------------------------------------- */
/*                                 Entities                                   */
/* -------------------------------------------------------------------------- */

/**
 * Minimum metadata required for a strategy to make an informed decision.
 * Adapter implementations are free to add extra fields.
 */
export interface ModelMetadata {
  readonly id: string;
  readonly version: string;
  readonly kpi: KPI;
  /**
   * Rolling window performance metric such as accuracy, RMSE, etc.
   * Keys are metric names, values are scalar numbers.
   */
  readonly performance: Record<string, number>;
  readonly latencyMs: number; // P99 latency
  readonly createdAt: Date;
}

/**
 * Domain context that strategies may leverage to choose a model.
 */
export interface InferenceContext {
  readonly userId?: string;
  readonly timestamp: Date;
  readonly extra?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*                             Strategy Pattern                               */
/* -------------------------------------------------------------------------- */

export interface InferenceStrategy {
  /**
   * Elects a single model from a list of candidates.
   */
  selectModel(
    candidates: ReadonlyArray<ModelMetadata>,
    ctx: InferenceContext,
  ): Promise<ModelMetadata>;
}

/**
 * Simplest possible “always pick the freshest model” strategy.
 */
class LatestVersionStrategy implements InferenceStrategy {
  async selectModel(
    candidates: readonly ModelMetadata[],
  ): Promise<ModelMetadata> {
    if (candidates.length === 0) {
      throw new InferenceError('No models available for KPI');
    }
    return [...candidates].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  }
}

/**
 * Deterministic A/B splitter.  Users always hit the same variant
 * (sticky behavior) by hashing userId.
 */
class AbTestingStrategy implements InferenceStrategy {
  constructor(private readonly trafficSplit: number = 0.5) {}

  async selectModel(
    candidates: readonly ModelMetadata[],
    ctx: InferenceContext,
  ): Promise<ModelMetadata> {
    if (candidates.length < 2) {
      // Fallback to naive strategy
      return new LatestVersionStrategy().selectModel(candidates, ctx);
    }

    const uid = ctx.userId ?? crypto.randomUUID();
    const hash = crypto.createHash('sha256').update(uid).digest('hex');
    const bucket = parseInt(hash.slice(0, 8), 16) / 0xffffffff;

    // Sort consistently so A → first, B → second
    const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
    return bucket < this.trafficSplit ? sorted[0] : sorted[1];
  }
}

/**
 * Simple epsilon-greedy multi-armed bandit.
 */
class EpsilonGreedyBanditStrategy implements InferenceStrategy {
  constructor(private readonly epsilon: number = 0.1) {}

  async selectModel(
    candidates: readonly ModelMetadata[],
  ): Promise<ModelMetadata> {
    if (candidates.length === 0) {
      throw new InferenceError('No models available for KPI');
    }
    if (Math.random() < this.epsilon) {
      // Exploration: random pick
      return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // Exploitation: best recent performance (higher is better)
    return [...candidates].sort(
      (a, b) =>
        (b.performance['accuracy'] ?? 0) - (a.performance['accuracy'] ?? 0),
    )[0];
  }
}

/* -------------------------------------------------------------------------- */
/*                              Factory Pattern                               */
/* -------------------------------------------------------------------------- */

/**
 * Well-known strategy aliases—kept as string literal union for config files.
 */
export type StrategyKind = 'LATEST' | 'AB_TEST' | 'BANDIT';

/**
 * Run-time factory that materialises strategies from configuration.
 */
export class StrategyFactory {
  constructor(private readonly config: Partial<Record<KPI, StrategyKind>>) {}

  /**
   * Returns a strategy tuned for the requested KPI.
   */
  buildFor(kpi: KPI): InferenceStrategy {
    const kind: StrategyKind = this.config[kpi] ?? 'LATEST';

    switch (kind) {
      case 'AB_TEST':
        return new AbTestingStrategy();
      case 'BANDIT':
        return new EpsilonGreedyBanditStrategy();
      case 'LATEST':
      default:
        return new LatestVersionStrategy();
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                            Observer Pattern                                */
/* -------------------------------------------------------------------------- */

/**
 * Discriminated union of domain-level inference events.
 */
export type InferenceEvent =
  | {
      type: 'model.selected';
      kpi: KPI;
      modelId: string;
      context: InferenceContext;
    }
  | {
      type: 'prediction.completed';
      kpi: KPI;
      modelId: string;
      latencyMs: number;
      context: InferenceContext;
    }
  | {
      type: 'prediction.failed';
      kpi: KPI;
      context: InferenceContext;
      error: Error;
    };

/**
 * Strongly-typed event emitter.
 */
export class InferenceEventEmitter extends EventEmitter {
  emit(event: InferenceEvent): boolean {
    return super.emit(event.type, event);
  }

  on<T extends InferenceEvent['type']>(
    type: T,
    listener: (event: Extract<InferenceEvent, { type: T }>) => void,
  ): this {
    return super.on(type, listener);
  }
}

/* -------------------------------------------------------------------------- */
/*                           Domain-level Errors                              */
/* -------------------------------------------------------------------------- */

export class InferenceError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'InferenceError';
    Error.captureStackTrace?.(this, InferenceError);
  }
}

/* -------------------------------------------------------------------------- */
/*                          Orchestrator (Hexagon)                            */
/* -------------------------------------------------------------------------- */

/**
 * Core domain service that:
 *   1. Locates candidate models via the ModelRegistryPort.
 *   2. Selects the most appropriate model via Strategy Pattern.
 *   3. Delegates execution via ModelPredictionPort.
 *   4. Emits observability events for monitoring dashboards.
 */
export class KPIInferenceOrchestrator {
  constructor(
    private readonly registry: ModelRegistryPort,
    private readonly predictor: ModelPredictionPort,
    private readonly strategyFactory: StrategyFactory,
    private readonly events: InferenceEventEmitter = new InferenceEventEmitter(),
  ) {}

  /**
   * High-level business use-case: “make me a prediction for this KPI”.
   *
   * @throws InferenceError (wraps underlying exceptions)
   */
  async predict<TOutput = Prediction>(
    kpi: KPI,
    input: FeatureVector,
    ctx: InferenceContext = { timestamp: new Date() },
  ): Promise<TOutput> {
    try {
      const candidates = await this.registry.fetchCandidates(kpi);
      const strategy = this.strategyFactory.buildFor(kpi);
      const chosen = await strategy.selectModel(candidates, ctx);

      this.events.emit({
        type: 'model.selected',
        kpi,
        modelId: chosen.id,
        context: ctx,
      });

      const start = Date.now();
      const output = await this.predictor.predict<TOutput>(chosen.id, input);
      const latency = Date.now() - start;

      this.events.emit({
        type: 'prediction.completed',
        kpi,
        modelId: chosen.id,
        latencyMs: latency,
        context: ctx,
      });

      return output;
    } catch (err) {
      const error =
        err instanceof InferenceError ? err : new InferenceError('Inference failed', err as Error);

      this.events.emit({
        type: 'prediction.failed',
        kpi,
        context: ctx,
        error,
      });

      throw error;
    }
  }

  /**
   * Exposes the event channel so that external observers (e.g., Prometheus
   * exporters, Slack bots, audit loggers) can subscribe without breaking
   * the hexagon boundary.  Only domain events are leaked, never adapters.
   */
  get eventBus(): InferenceEventEmitter {
    return this.events;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Usage Example                                 */
/* -------------------------------------------------------------------------- */
/*
import { S3ModelRegistryAdapter } from '../adapters/aws/S3ModelRegistryAdapter';
import { TfServingPredictionAdapter } from '../adapters/tf/TfServingPredictionAdapter';

const registry = new S3ModelRegistryAdapter();
const predictor = new TfServingPredictionAdapter();
const factory   = new StrategyFactory({ 'revenue_kpi' as KPI: 'BANDIT' });

const orchestrator = new KPIInferenceOrchestrator(registry, predictor, factory);

orchestrator.eventBus.on('prediction.failed', evt => console.error(evt));

async function main() {
  const output = await orchestrator.predict('revenue_kpi' as KPI, { feature_1: 42 }, { userId: 'u123', timestamp: new Date() });
  console.log(output);
}

main();
*/

/******************************************************************************************
 * End of file: src/module_39.ts
 ******************************************************************************************/
```