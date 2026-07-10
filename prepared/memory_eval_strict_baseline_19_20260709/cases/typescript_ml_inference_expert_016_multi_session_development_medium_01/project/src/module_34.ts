```typescript
/***************************************************************************************************
 * InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * File:        src/module_34.ts
 * Responsibility:
 *   Hexagonal-core orchestration of a single online-inference request. Coordinates:
 *     • Feature retrieval (Feature Store Port)
 *     • Model selection (Strategy Pattern via ModelSelectionStrategy)
 *     • Model execution (Model Runner Port)
 *     • Experiment tracking / usage accounting
 *     • Domain-event publication for downstream observers (Observer Pattern)
 *
 *   NOTE: Adapters—S3FeatureStoreAdapter, TensorFlowModelRunnerAdapter, KafkaEventBusAdapter,
 *   etc.—live outside the core and implement the “*_Port” interfaces defined here.
 *
 * Author: InsightHexaAI Engineering
 ***************************************************************************************************/

//////////////////////////////////////////////
// Domain primitives
//////////////////////////////////////////////

/**
 * Immutable, typed-safe user identifier (value object)
 */
export type UserId = string & { readonly brand: unique symbol };

/**
 * Raw features passed to the model.
 * (We use any here because feature types are model-specific, but it is strongly recommended to
 *  encapsulate them in versioned interfaces in production.)
 */
export type FeatureVector = Readonly<Record<string, unknown>>;

/**
 * Prediction result including metadata required for billing / analytics
 */
export interface PredictionResult<T = unknown> {
  readonly userId: UserId;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly payload: T;
  readonly latencyMs: number;
  readonly timestamp: number; // epoch ms
}

//////////////////////////////////////////////
// Ports (Hexagon outbound interfaces)
//////////////////////////////////////////////

/**
 * Feature Store Port – retrieves the latest feature vector for a given user
 */
export interface FeatureStorePort {
  fetchFeatureVector(userId: UserId): Promise<FeatureVector>;
}

/**
 * Model Registry Port – locates model artifacts & metadata
 */
export interface ModelRegistryPort {
  /**
   * Returns latest metadata of a model requested by symbolic name.
   * Implementations may perform network IO, hence async.
   */
  getModelMetadata(modelName: string): Promise<ModelMetadata>;
}

/**
 * Experiment Tracker Port – records inference events for analytics & A/B
 */
export interface ExperimentTrackerPort {
  recordInference(result: PredictionResult): Promise<void>;
}

/**
 * Model Runner Port – abstracts the execution of the ML model
 */
export interface ModelRunnerPort {
  runModel(
    artifactUri: string,
    input: FeatureVector,
    options?: ModelRunOptions
  ): Promise<unknown>;
}

export interface MonitoringPort {
  publishEvent(event: DomainEvent): Promise<void>;
}

//////////////////////////////////////////////
// Value Objects / Data Transfer Objects
//////////////////////////////////////////////

export interface ModelMetadata {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly artifactUri: string;
  readonly createdAt: number;
  readonly tags: string[];
}

export interface ModelRunOptions {
  readonly timeoutMs?: number;
  readonly parameters?: Record<string, unknown>;
}

//////////////////////////////////////////////
// Domain Events (Observer Pattern)
//////////////////////////////////////////////

export type DomainEvent =
  | InferenceCompletedEvent
  | InferenceFailedEvent
  | ModelSelectedEvent;

export interface BaseDomainEvent {
  readonly eventId: string;
  readonly occurredAt: number;
}

export interface InferenceCompletedEvent extends BaseDomainEvent {
  readonly type: "InferenceCompleted";
  readonly payload: PredictionResult;
}
export interface InferenceFailedEvent extends BaseDomainEvent {
  readonly type: "InferenceFailed";
  readonly payload: {
    readonly userId: UserId;
    readonly errorMessage: string;
    readonly modelName: string;
  };
}
export interface ModelSelectedEvent extends BaseDomainEvent {
  readonly type: "ModelSelected";
  readonly payload: ModelMetadata;
}

//////////////////////////////////////////////
// Strategy Pattern – model selection
//////////////////////////////////////////////

export interface ModelSelectionStrategy {
  selectModel(
    modelName: string,
    registry: ModelRegistryPort,
    context?: SelectionContext
  ): Promise<ModelMetadata>;
}

export interface SelectionContext {
  readonly userId: UserId;
  readonly experimentId?: string;
  // additional context (geo, subscription tier …)
}

/**
 * Strategy #1: Always use latest production model
 */
export class LatestProductionStrategy implements ModelSelectionStrategy {
  async selectModel(
    modelName: string,
    registry: ModelRegistryPort
  ): Promise<ModelMetadata> {
    const metadata = await registry.getModelMetadata(modelName);
    if (!metadata) {
      throw new Error(`Model "${modelName}" not found in registry.`);
    }
    return metadata;
  }
}

/**
 * Strategy #2: A/B testing based on user hash
 */
export class ABTestingStrategy implements ModelSelectionStrategy {
  constructor(
    private readonly variantAName: string,
    private readonly variantBName: string,
    private readonly trafficAllocation = 0.5 // 50/50 by default
  ) {}

  async selectModel(
    modelName: string,
    registry: ModelRegistryPort,
    context?: SelectionContext
  ): Promise<ModelMetadata> {
    if (!context?.userId) {
      throw new Error("ABTestingStrategy requires userId in context.");
    }
    // Simple deterministic hash based on userId
    const hash = this.hashString(context.userId);
    const selectedModelName =
      hash < this.trafficAllocation ? this.variantAName : this.variantBName;

    const metadata = await registry.getModelMetadata(selectedModelName);
    if (!metadata) {
      throw new Error(
        `Model "${selectedModelName}" not found for AB test (${modelName}).`
      );
    }
    return metadata;
  }

  /** djb2 hash algorithm (deterministic) */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 33) ^ str.charCodeAt(i);
    }
    // Convert to [0,1] range
    return (hash >>> 0) / 2 ** 32;
  }
}

//////////////////////////////////////////////
// Core Service – Inference Orchestrator
//////////////////////////////////////////////

export interface InferenceOrchestratorConfig {
  readonly defaultTimeoutMs: number;
  readonly strategy: ModelSelectionStrategy;
}

export class InferenceOrchestrator {
  constructor(
    private readonly featureStore: FeatureStorePort,
    private readonly registry: ModelRegistryPort,
    private readonly tracker: ExperimentTrackerPort,
    private readonly modelRunner: ModelRunnerPort,
    private readonly monitoring: MonitoringPort,
    private readonly config: InferenceOrchestratorConfig
  ) {}

  /**
   * Public API – executes one inference request.
   * Throws typed errors so that controller/adapters can map to HTTP/gRPC/etc codes.
   */
  async predict<TPayload = unknown>(
    userId: UserId,
    modelName: string
  ): Promise<PredictionResult<TPayload>> {
    const startedAt = Date.now();
    try {
      // 1. Retrieve features
      const features = await this.featureStore.fetchFeatureVector(userId);

      // 2. Select model according to strategy
      const modelMetadata = await this.config.strategy.selectModel(
        modelName,
        this.registry,
        { userId }
      );
      await this.publishEvent({
        type: "ModelSelected",
        eventId: this.generateUuid(),
        occurredAt: startedAt,
        payload: modelMetadata
      });

      // 3. Execute model
      const rawPrediction = await this.modelRunner.runModel(
        modelMetadata.artifactUri,
        features,
        { timeoutMs: this.config.defaultTimeoutMs }
      );
      const result: PredictionResult<TPayload> = Object.freeze({
        userId,
        modelId: modelMetadata.id,
        modelVersion: modelMetadata.version,
        payload: rawPrediction as TPayload,
        latencyMs: Date.now() - startedAt,
        timestamp: Date.now()
      });

      // 4. Record experiment
      await this.tracker.recordInference(result);

      // 5. Publish completion event
      await this.publishEvent({
        type: "InferenceCompleted",
        eventId: this.generateUuid(),
        occurredAt: Date.now(),
        payload: result
      });

      return result;
    } catch (err) {
      // Publish failure event
      await this.publishEvent({
        type: "InferenceFailed",
        eventId: this.generateUuid(),
        occurredAt: Date.now(),
        payload: {
          userId,
          errorMessage:
            err instanceof Error ? err.message : "Unknown inference error",
          modelName
        }
      });
      // Rethrow for adapter to handle
      throw err;
    }
  }

  //////////////////////////////////////////////
  // Helpers
  //////////////////////////////////////////////

  private async publishEvent(event: DomainEvent): Promise<void> {
    try {
      await this.monitoring.publishEvent(event);
    } catch (err) {
      // Non-critical – log and continue
      /* eslint-disable no-console */
      console.error("Failed to publish domain event", err, event);
    }
  }

  // Extremely small, non-crypto UUID v4 approximation (for brevity)
  private generateUuid(): string {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      /* eslint-disable no-bitwise */
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

//////////////////////////////////////////////
// Example Factory for orchestration creation
//////////////////////////////////////////////

export function createDefaultOrchestrator(
  deps: {
    featureStore: FeatureStorePort;
    registry: ModelRegistryPort;
    tracker: ExperimentTrackerPort;
    modelRunner: ModelRunnerPort;
    monitoring: MonitoringPort;
  },
  overrides?: Partial<InferenceOrchestratorConfig>
): InferenceOrchestrator {
  const defaultConfig: InferenceOrchestratorConfig = {
    defaultTimeoutMs: 2_000,
    strategy: new LatestProductionStrategy()
  };
  return new InferenceOrchestrator(
    deps.featureStore,
    deps.registry,
    deps.tracker,
    deps.modelRunner,
    deps.monitoring,
    { ...defaultConfig, ...overrides }
  );
}
```