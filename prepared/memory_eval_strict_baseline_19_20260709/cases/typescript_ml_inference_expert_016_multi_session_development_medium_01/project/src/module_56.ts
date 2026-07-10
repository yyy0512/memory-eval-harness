```typescript
/***************************************************************************************************
 * File:        src/module_56.ts
 * Project:     InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 * Description: Service responsible for selecting the most appropriate model version for a given
 *              inference request. The class acts as the primary port into the hexagon for
 *              model-versioning concerns and delegates the selection logic to a pluggable
 *              IModelSelectionStrategy (Strategy Pattern).  After every successful selection the
 *              service publishes a ModelVersionSelectedDomainEvent to the system-wide EventBus
 *              (Observer Pattern) so that external dashboards, billing and monitoring adapters
 *              can react to the outcome.
 *
 *              Although this file lives inside the core domain (hexagon), all infrastructure
 *              concerns (model registry, event bus, etc.) are injected through ports to keep the
 *              domain model free of framework and IO dependencies.
 ***************************************************************************************************/

import { v4 as uuidV4 } from 'uuid';

import { IModelSelectionStrategy } from './core/ports/strategy/IModelSelectionStrategy';
import { ModelRegistryPort }       from './core/ports/outbound/ModelRegistryPort';
import { EventBusPort }            from './core/ports/outbound/EventBusPort';

import {
    InferenceContext,
    ModelMetadata,
    ModelVersionSelectedDomainEvent,
} from './core/domain/model-versioning';

// -------------------------------------------------------------------------------------------------
// Error types
// -------------------------------------------------------------------------------------------------

/**
 * Thrown when the service fails to find a model that satisfies the incoming inference context.
 */
export class NoSatisfactoryModelFoundError extends Error {
    constructor(readonly context: InferenceContext) {
        super(
            `No satisfactory model version found for business unit ` +
            `"${context.businessUnit}" with KPI target "${context.targetKpi}".`,
        );
        this.name = NoSatisfactoryModelFoundError.name;
    }
}

/**
 * Thrown when the configured strategy fails in an unrecoverable way.
 */
export class ModelSelectionStrategyError extends Error {
    constructor(readonly strategyName: string, original: Error) {
        super(
            `Model selection strategy "${strategyName}" failed: ${original.message}`,
        );
        this.name  = ModelSelectionStrategyError.name;
        this.stack = original.stack;
    }
}

// -------------------------------------------------------------------------------------------------
// Service implementation
// -------------------------------------------------------------------------------------------------

/**
 * Core domain service that chooses the best model version for a given inference request.
 * Concrete selection logic is delegated to the injected IModelSelectionStrategy so that new
 * strategies (e.g., Thompson Sampling, UCB, Epsilon-Greedy) can be introduced without touching
 * this class.
 */
export class ModelSelectorService {
    private readonly serviceId = uuidV4();

    constructor(
        private readonly registryPort: ModelRegistryPort,
        private readonly strategy: IModelSelectionStrategy,
        private readonly eventBus: EventBusPort,
    ) {}

    /**
     * Selects the model according to the injected strategy and publishes a domain event
     * afterwards. Throws descriptive domain errors on failure.
     *
     * @param context - The contextual metadata of the incoming inference request.
     * @returns The ModelMetadata of the selected model version.
     */
    async selectModel(context: InferenceContext): Promise<ModelMetadata> {
        // 1. Retrieve candidate model versions from the model registry.
        const candidates = await this.registryPort.findModels({
            businessUnit: context.businessUnit,
            targetKpi: context.targetKpi,
            maxLatencyMs: context.sla.maxLatencyMs,
        });

        if (candidates.length === 0) {
            throw new NoSatisfactoryModelFoundError(context);
        }

        // 2. Delegate the selection logic to the injected strategy.
        let chosen: ModelMetadata;
        try {
            chosen = await this.strategy.pick(candidates, context);
        } catch (err) {
            // Wrap low-level errors into a domain-specific error.
            throw new ModelSelectionStrategyError(this.strategy.name, err as Error);
        }

        if (!chosen) {
            throw new NoSatisfactoryModelFoundError(context);
        }

        // 3. Publish the selection as a domain event.
        const event: ModelVersionSelectedDomainEvent = {
            eventId:     uuidV4(),
            occurredAt:  new Date(),
            correlation: context.correlationId,
            payload: {
                modelId:          chosen.id,
                modelVersion:     chosen.version,
                strategyUsed:     this.strategy.name,
                businessUnit:     context.businessUnit,
                targetKpi:        context.targetKpi,
                requestedLatency: context.sla.maxLatencyMs,
            },
        };

        // Fire-and-forget: if the bus is down, we log the incident but do not break the request.
        this.eventBus
            .publish(event)
            .catch((err) => {
                /* eslint-disable no-console */
                console.error(
                    `[ModelSelectorService] Failed to publish ModelVersionSelectedDomainEvent (id = ${event.eventId}).`,
                    err,
                );
                /* eslint-enable no-console */
            });

        // 4. Return the chosen model to the caller (typically the inference orchestrator).
        return chosen;
    }

    /**
     * For debugging/introspection purposes it is often useful to know which concrete strategy and
     * registry implementation are injected at runtime (DI container).
     */
    public getDebugInfo(): Record<string, unknown> {
        return {
            instanceId:      this.serviceId,
            strategy:        this.strategy.name,
            registryAdapter: this.registryPort.constructor.name,
            eventBusAdapter: this.eventBus.constructor.name,
        };
    }
}

// -------------------------------------------------------------------------------------------------
// Factory helper (optional)
// -------------------------------------------------------------------------------------------------

/**
 * Helper for constructing the service when manual wiring is preferred over a full DI framework.
 * Note: When using InversifyJS or NestJS you can drop this and leverage their providers/modules.
 */
export namespace ModelSelectorServiceFactory {
    export type Dependencies = {
        registryPort: ModelRegistryPort;
        strategy: IModelSelectionStrategy;
        eventBus: EventBusPort;
    };

    /**
     * Creates an instance of ModelSelectorService with runtime-level null/undefined safety checks.
     */
    export function create(deps: Dependencies): ModelSelectorService {
        if (!deps.registryPort) {
            throw new Error('ModelSelectorServiceFactory received an undefined registryPort.');
        }
        if (!deps.strategy) {
            throw new Error('ModelSelectorServiceFactory received an undefined strategy.');
        }
        if (!deps.eventBus) {
            throw new Error('ModelSelectorServiceFactory received an undefined eventBus.');
        }

        return new ModelSelectorService(deps.registryPort, deps.strategy, deps.eventBus);
    }
}
```