```typescript
/* ============================================================================
 * File: tests/test_main.ts
 * Project: InsightHexaAI – Strategic ML Inference Suite for Enterprise KPIs
 *
 * Purpose:
 * Jest / ts-jest test-harness that validates critical hexagonal-architecture
 * behaviours across Strategy, Factory and Observer patterns.  These tests are
 * intentionally black-box: they exercise only public ports and high-level
 * use-cases, never concrete adapter internals, thereby protecting the
 * independence of the domain core.
 * ========================================================================== */

import { jest } from '@jest/globals';
import { nanoid } from 'nanoid/non-secure';

import { InferenceEngine } from '../src/core/inference/InferenceEngine';
import {
  ModelSelectionStrategy,
  Prediction,
} from '../src/core/inference/ports/ModelSelectionPort';
import { FeatureStorePort } from '../src/core/feature-store/ports/FeatureStorePort';
import {
  MonitoringEvent,
  ObserverPort,
} from '../src/core/monitoring/ports/ObserverPort';
import { BillingStrategyFactory } from '../src/core/billing/BillingStrategyFactory';
import {
  UsageBasedBillingStrategy,
  SubscriptionBillingStrategy,
} from '../src/core/billing/strategies';
import { PricingContext } from '../src/core/billing/types';

/* ---------------------------------------------------------------------------
 * Test Fixtures (synthetic implementations of ports inside the hexagon)
 * ------------------------------------------------------------------------- */

/** Simple deterministic feature store for unit-tests. */
class InMemFeatureStore implements FeatureStorePort {
  private readonly table: Record<string, Record<string, unknown>>;

  constructor(table: Record<string, Record<string, unknown>>) {
    this.table = table;
  }

  getFeatures = async (
    entityId: string,
  ): Promise<Record<string, unknown>> => {
    if (!this.table[entityId]) {
      throw new Error(`Entity ${entityId} not found in Feature Store`);
    }
    return this.table[entityId];
  };
}

/** Captures events emitted by the Observer pattern. */
class SpyObserver implements ObserverPort {
  events: MonitoringEvent[] = [];

  publish = (event: MonitoringEvent): void => {
    this.events.push(event);
  };
}

/* ---------------------------------------------------------------------------
 * Jest Mocks / Factories
 * ------------------------------------------------------------------------- */

/**
 * Generates a mock ModelSelectionStrategy whose `predict` function simply
 * returns the supplied constant `value` after an artificial latency.
 */
const mockModelStrategy = (value: number): ModelSelectionStrategy => ({
  id: `mock-strategy-${value}`,
  predict: jest.fn(
    async (_features: Record<string, unknown>): Promise<Prediction> => ({
      value,
      modelId: `model-${value}`,
      latencyMs: 5,
    }),
  ),
});

/* ---------------------------------------------------------------------------
 * Unit Test Suites
 * ------------------------------------------------------------------------- */

describe('InferenceEngine', () => {
  const userId = nanoid(6);
  const featureVector = { clicks: 10, revenue: 77.13 };

  const featureStore = new InMemFeatureStore({ [userId]: featureVector });
  const observer = new SpyObserver();

  it('routes predictions through the configured model-selection strategy', async () => {
    const strategy = mockModelStrategy(0.87);
    const engine = new InferenceEngine({
      strategy,
      featureStore,
      observers: [observer],
    });

    const { value, modelId, latencyMs } = await engine.predict({ userId });

    // Validate prediction correctness
    expect(value).toBeCloseTo(0.87, 5);
    expect(modelId).toBe('model-0.87');
    expect(latencyMs).toBeGreaterThan(0);

    // Ensure model strategy call surface
    expect(strategy.predict).toHaveBeenCalledTimes(1);
    expect(strategy.predict).toHaveBeenCalledWith(featureVector);

    // Observer should receive a PREDICTION event
    const predictionEvents = observer.events.filter(
      (e) => e.type === 'PREDICTION',
    );
    expect(predictionEvents.length).toBe(1);
    expect(predictionEvents[0].payload).toMatchObject({ modelId });
  });

  it('surfaces KPI drift events when error rate exceeds threshold', async () => {
    const failingStrategy: ModelSelectionStrategy = {
      id: 'always-fail',
      predict: jest.fn(async () => {
        throw new Error('Model exploded 🧨');
      }),
    };

    const engine = new InferenceEngine({
      strategy: failingStrategy,
      featureStore,
      observers: [observer],
      driftConfig: { errorRateThreshold: 0.5, windowSize: 2 },
    });

    // Execute two failing predictions → errorRate = 1.0
    await Promise.allSettled([engine.predict({ userId }), engine.predict({ userId })]);

    const driftEvents = observer.events.filter(
      (e) => e.type === 'KPI_DRIFT',
    );
    expect(driftEvents.length).toBeGreaterThanOrEqual(1);
    expect(driftEvents[0].payload).toMatchObject({
      errorRate: 1,
      threshold: 0.5,
    });
  });
});

describe('BillingStrategyFactory', () => {
  const prediction: Prediction = {
    value: 0.42,
    modelId: 'test-model',
    latencyMs: 50,
  };

  it('creates a Usage-Based billing strategy with correct pricing math', () => {
    const factory = new BillingStrategyFactory();
    const strategy = factory.create('USAGE') as UsageBasedBillingStrategy;

    const context: PricingContext = {
      prediction,
      metadata: { enterpriseTenant: 'acme-corp' },
    };

    const price = strategy.calculate(context);

    // $0.0002 * latencyMs + $0.01 base
    expect(price).toBeCloseTo(0.020, 3);
  });

  it('creates a Subscription billing strategy that returns flat zero cost', () => {
    const factory = new BillingStrategyFactory();
    const strategy = factory.create(
      'SUBSCRIPTION',
    ) as SubscriptionBillingStrategy;

    const price = strategy.calculate({
      prediction,
      metadata: { plan: 'platinum' },
    });

    expect(price).toBe(0);
  });

  it('throws informative error for unknown billing strategy key', () => {
    const factory = new BillingStrategyFactory();
    expect(() => factory.create('CRYPTO' as never)).toThrow(
      /Unsupported billing strategy.+CRYPTO/,
    );
  });
});
```