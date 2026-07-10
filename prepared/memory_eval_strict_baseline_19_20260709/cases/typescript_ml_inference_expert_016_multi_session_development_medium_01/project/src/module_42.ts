```typescript
/**
 * src/module_42.ts
 *
 * Real-time inference orchestrator that lives inside the “hexagon”.
 * Combines Strategy + Factory patterns to:
 *   • Select the most appropriate model version for a given KPI
 *   • Calculate SLA-aware, revenue-impacting pricing for the request
 *   • Capture experiment metadata and emit observer events
 *
 * The service is intentionally side-effect-free with all IO abstracted
 * behind ports so that adapters (Kafka, REST, gRPC, etc.) can call it.
 */

import { v4 as uuid } from 'uuid';

import {
  FeatureStorePort,
  ModelRegistryPort,
  ModelRunnerPort,
  ExperimentTrackerPort,
  ObserverPort,
  ClockPort,
  PricingStrategy,
  PricingStrategyFactory,
  ModelSelectionContext,
  ModelSelectionStrategy,
} from '@core/ports';

import {
  DomainError,
  InvalidRequestError,
  ModelNotFoundError,
  FeatureRetrievalError,
  InferenceExecutionError,
  PricingComputationError,
} from '@core/errors';

import { logDebug, logError } from '@adapters/logger';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Payload received from an outside adapter (REST, gRPC, Kafka, …).
 */
export interface InferenceRequest<FeatureVector = unknown> {
  modelKey: string;                // Domain name of the model (e.g. "churn-risk")
  tenantId: string;                // Enterprise customer
  userId: string;                  // End user calling the prediction
  rawPayload: unknown;             // Unprocessed input (gets featurized)
  features?: FeatureVector;        // Optional features (skip feature store)
  forceModelVersion?: string;      // Optional override (e.g. “experiment A”)
  correlationId?: string;          // Traceability across systems
  requestedAt?: Date;              // For offline / backfill scenarios
}

/**
 * Response returned to the outside world.
 */
export interface InferenceResponse<P = unknown> {
  correlationId: string;
  prediction: P;
  modelVersion: string;
  computedPriceInCents: number;
  inferenceLatencyMs: number;
  billedAt: Date;
}

/* -------------------------------------------------------------------------- */
/*                                 Service                                    */
/* -------------------------------------------------------------------------- */

export class RealTimeInferenceService {
  private readonly featureStore: FeatureStorePort;
  private readonly modelRegistry: ModelRegistryPort;
  private readonly modelRunner: ModelRunnerPort;
  private readonly experimentTracker: ExperimentTrackerPort;
  private readonly observer: ObserverPort;
  private readonly clock: ClockPort;

  // Strategies
  private readonly modelSelector: ModelSelectionStrategy;
  private readonly pricingFactory: PricingStrategyFactory;

  constructor(deps: {
    featureStore: FeatureStorePort;
    modelRegistry: ModelRegistryPort;
    modelRunner: ModelRunnerPort;
    experimentTracker: ExperimentTrackerPort;
    observer: ObserverPort;
    modelSelector: ModelSelectionStrategy;
    pricingFactory: PricingStrategyFactory;
    clock: ClockPort;
  }) {
    this.featureStore = deps.featureStore;
    this.modelRegistry = deps.modelRegistry;
    this.modelRunner = deps.modelRunner;
    this.experimentTracker = deps.experimentTracker;
    this.observer = deps.observer;
    this.modelSelector = deps.modelSelector;
    this.pricingFactory = deps.pricingFactory;
    this.clock = deps.clock;
  }

  /**
   * Public entry-point for inference calls.
   * All errors are re-thrown as DomainError subclasses so that adapters
   * can translate them into HTTP/gRPC/Kafka codes consistently.
   */
  async infer<P = unknown>(
    request: InferenceRequest,
  ): Promise<InferenceResponse<P>> {
    const startedAt = this.clock.now();

    // 1. Validate request early
    this.validateRequest(request);

    const correlationId = request.correlationId ?? uuid();
    const timing = { startedAt, correlationId };

    try {
      // 2. Prepare features
      const features =
        request.features ??
        (await this.fetchFeatures(request).catch((err) => {
          throw new FeatureRetrievalError(
            `Failed to retrieve features: ${(err as Error).message}`,
          );
        }));

      // 3. Select model version
      const modelVersion = await this.selectModelVersion(request);

      // 4. Execute inference
      const prediction = await this.executeInference<P>(
        request,
        modelVersion,
        features,
      );

      // 5. Compute pricing
      const price = await this.computePricing(request, modelVersion);

      // 6. Track experiment + notify observer
      await Promise.all([
        this.recordExperiment(request, modelVersion, prediction, timing),
        this.publishObserverEvent(request, prediction, price, timing),
      ]);

      const latencyMs = this.clock.elapsedSince(startedAt);

      return {
        correlationId,
        prediction,
        modelVersion,
        computedPriceInCents: price,
        inferenceLatencyMs: latencyMs,
        billedAt: startedAt,
      };
    } catch (err) {
      logError(err as Error, { correlationId });
      // Re-throw to adapter
      if (err instanceof DomainError) throw err;
      throw new DomainError((err as Error).message);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                              Internals                                 */
  /* ---------------------------------------------------------------------- */

  private validateRequest(request: InferenceRequest): void {
    if (!request.modelKey) {
      throw new InvalidRequestError('modelKey must be provided');
    }
    if (!request.tenantId) {
      throw new InvalidRequestError('tenantId must be provided');
    }
    if (!request.userId) {
      throw new InvalidRequestError('userId must be provided');
    }
  }

  private async fetchFeatures(
    request: InferenceRequest,
  ): Promise<Record<string, unknown>> {
    logDebug('Fetching feature vector', {
      modelKey: request.modelKey,
      tenantId: request.tenantId,
    });
    return this.featureStore.getFeatures({
      tenantId: request.tenantId,
      modelKey: request.modelKey,
      rawPayload: request.rawPayload,
    });
  }

  private async selectModelVersion(
    request: InferenceRequest,
  ): Promise<string> {
    if (request.forceModelVersion) {
      logDebug('Using client-forced model version', {
        forced: request.forceModelVersion,
      });
      return request.forceModelVersion;
    }

    const context: ModelSelectionContext = {
      modelKey: request.modelKey,
      tenantId: request.tenantId,
      userId: request.userId,
      now: this.clock.now(),
    };

    const version = await this.modelSelector.selectModelVersion(context);

    if (!version) {
      throw new ModelNotFoundError(
        `No model version found for key=${request.modelKey}`,
      );
    }
    return version;
  }

  private async executeInference<P>(
    request: InferenceRequest,
    modelVersion: string,
    features: Record<string, unknown>,
  ): Promise<P> {
    try {
      return await this.modelRunner.run<P>({
        modelVersion,
        features,
        correlationId: request.correlationId,
        tenantId: request.tenantId,
      });
    } catch (err) {
      throw new InferenceExecutionError(
        `Inference failed for modelVersion=${modelVersion}: ${
          (err as Error).message
        }`,
      );
    }
  }

  private async computePricing(
    request: InferenceRequest,
    modelVersion: string,
  ): Promise<number> {
    const strategy: PricingStrategy = await this.pricingFactory.forTenant(
      request.tenantId,
    );

    try {
      return strategy.computePrice({
        tenantId: request.tenantId,
        userId: request.userId,
        modelKey: request.modelKey,
        modelVersion,
      });
    } catch (err) {
      throw new PricingComputationError(
        `Pricing failed: ${(err as Error).message}`,
      );
    }
  }

  private async recordExperiment(
    request: InferenceRequest,
    modelVersion: string,
    prediction: unknown,
    timing: { startedAt: Date; correlationId: string },
  ): Promise<void> {
    try {
      await this.experimentTracker.record({
        ...request,
        modelVersion,
        prediction,
        correlationId: timing.correlationId,
        occurredAt: timing.startedAt,
      });
    } catch (err) {
      // Recording failures should not break SLA; just log
      logError(err as Error, {
        scope: 'experiment-tracker',
        correlationId: timing.correlationId,
      });
    }
  }

  private async publishObserverEvent(
    request: InferenceRequest,
    prediction: unknown,
    price: number,
    timing: { startedAt: Date; correlationId: string },
  ): Promise<void> {
    try {
      await this.observer.publish('inference.completed', {
        modelKey: request.modelKey,
        tenantId: request.tenantId,
        userId: request.userId,
        prediction,
        priceInCents: price,
        occurredAt: timing.startedAt,
        correlationId: timing.correlationId,
      });
    } catch (err) {
      logError(err as Error, {
        scope: 'observer',
        correlationId: timing.correlationId,
      });
    }
  }
}
```
