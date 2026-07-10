```typescript
/***************************************************************************************************
 * File: tests/test_utils.ts
 * Project: MediTrade Pulse (fintech_trading)
 *
 * A collection of reusable utilities that make writing unit- and integration-tests concise
 * and repeatable across MediTrade Pulse’s code-base.  The helpers intentionally avoid touching
 * real infrastructure; instead, they rely on lightweight in-memory fakes and Jest mocks so that
 * tests remain deterministic and fast.
 ***************************************************************************************************/

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import deepMerge from 'ts-deepmerge';

import {
  Order,
  OrderSide,
  OrderStatus,
} from '../src/domain/order/Order';
import { Portfolio } from '../src/domain/portfolio/Portfolio';
import { Currency } from '../src/domain/shared/Currency';
import { RiskScore } from '../src/domain/risk/RiskScore';
import { ClinicalComplianceFlag } from '../src/domain/clinical/ClinicalComplianceFlag';
import {
  DomainEvent,
  EventStore,
  InMemoryEventStore,
} from '../src/infrastructure/event-sourcing';
import {
  SagaCoordinator,
  InMemorySagaCoordinator,
} from '../src/infrastructure/saga';

/* -------------------------------------------------------------------------------------------------
 * Random / Fake Data Factories
 * -----------------------------------------------------------------------------------------------*/

/**
 * Generates a fully-populated Order aggregate that is valid by default.
 * Callers can override any field by passing a partial “Order” object.
 */
export function givenOrder(overrides: Partial<Order> = {}): Order {
  const base: Order = {
    id: uuidv4(),
    instrument: 'PPE_FUTURES_AUG24',
    side: OrderSide.BUY,
    quantity: 10_000,
    price: 12.45,
    currency: Currency.USD,
    counterparty: 'Hospital-Group-A',
    placedAt: new Date(),
    status: OrderStatus.PENDING,
    riskScore: {
      value: 16,
      grade: 'LOW',
      generatedAt: new Date(),
    } as RiskScore,
    complianceFlags: [],
  };

  // Deep-merge to allow nested overrides without mutating the original “base”.
  return deepMerge.withOptions({ mergeArrays: false }, base, overrides) as Order;
}

/**
 * Generates an in-memory Portfolio aggregate with sensible defaults.
 */
export function givenPortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  const base: Portfolio = {
    id: uuidv4(),
    owner: 'Hospital-Group-A',
    baseCurrency: Currency.USD,
    positions: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  return deepMerge(base, overrides) as Portfolio;
}

/**
 * Generates a RiskScore entity with adjustable parameters.
 */
export function givenRiskScore(
  value = 5,
  grade: RiskScore['grade'] = 'LOW',
): RiskScore {
  return {
    value,
    grade,
    generatedAt: new Date(),
  };
}

/**
 * Convenient helper that returns a “batch recall” clinical compliance flag for tests.
 */
export function givenBatchRecallFlag(details = 'Recall batch #123456'): ClinicalComplianceFlag {
  return {
    id: uuidv4(),
    type: 'BATCH_RECALL',
    details,
    raisedAt: new Date(),
  };
}

/* -------------------------------------------------------------------------------------------------
 * In-Memory Test Harness
 * -----------------------------------------------------------------------------------------------*/

/**
 * A minimal yet powerful test-harness that wires-up an EventStore and a SagaCoordinator.
 * This prevents duplication when bootstrapping integration tests.
 */
export class TestHarness {
  readonly eventStore: EventStore;
  readonly sagaCoordinator: SagaCoordinator;
  readonly bus: EventEmitter;

  constructor(seedEvents: DomainEvent[] = []) {
    this.bus = new EventEmitter();
    this.eventStore = new InMemoryEventStore(seedEvents, this.bus);
    this.sagaCoordinator = new InMemorySagaCoordinator(this.bus);
  }

  /**
   * Replay all events currently in the event-store to the saga coordinator.
   * Useful when tests mutate the event-store directly.
   */
  async replayEvents(): Promise<void> {
    for (const evt of await this.eventStore.all()) {
      this.bus.emit(evt.type, evt);
    }
  }

  /**
   * Registers a mocked saga (listener) for a particular domain event type.
   * The callback is wrapped with “jest.fn” so tests can assert invocations.
   */
  on<T extends DomainEvent = DomainEvent>(
    eventType: T['type'],
    handler: (event: T) => unknown | Promise<unknown>,
  ) {
    const jestHandler = jest.fn(handler);
    this.bus.on(eventType, jestHandler);
    return jestHandler;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Jest Convenience Helpers
 * -----------------------------------------------------------------------------------------------*/

/**
 * Freezes time for the duration of a single test block.
 *
 * NOTE: test authors must call “restoreDate()” in an “afterEach” or “finally” block
 *       to guarantee global Date is restored even if the test fails.
 */
export function freezeDate(date: Date | string | number): void {
  const ts = new Date(date).getTime();
  if (Number.isNaN(ts)) {
    throw new Error(`freezeDate received invalid date: ${date}`);
  }

  jest.useFakeTimers({ now: ts, legacyFakeTimers: true });
}

/**
 * Restores normal Date behaviour after “freezeDate” was used.
 */
export function restoreDate(): void {
  jest.useRealTimers();
}

/* -------------------------------------------------------------------------------------------------
 * Transactional Helper
 * -----------------------------------------------------------------------------------------------*/

/**
 * Wraps the execution of an async test callback in a pseudo-database
 * transaction.  In production we use PostgreSQL transactions; here we use
 * a simple try/finally so that test resources are always cleaned up.
 *
 * Typical usage:
 *   await withTestTransaction(async () => {
 *     // 1️⃣ Arrange
 *     // 2️⃣ Act
 *     // 3️⃣ Assert
 *   });
 */
export async function withTestTransaction(
  runInTransaction: () => Promise<unknown>,
): Promise<void> {
  /* eslint-disable no-console */
  console.info('⏳  BEGIN TEST TRANSACTION');
  try {
    await runInTransaction();
  } finally {
    // In unit-tests we simply “rollback” by clearing all mocks and event-stores
    // instead of touching a real DB.
    jest.clearAllMocks();
    console.info('✅  ROLLBACK TEST TRANSACTION');
  }
}

/* -------------------------------------------------------------------------------------------------
 * Environment Safety Checks
 * -----------------------------------------------------------------------------------------------*/

// Hard fail if someone attempts to run tests against a non-test environment.
if (process.env.NODE_ENV && !['test', 'ci', 'localtest'].includes(process.env.NODE_ENV)) {
  // eslint-disable-next-line no-console
  console.error(
    `❌ Refusing to run tests—NODE_ENV="${process.env.NODE_ENV}" looks unsafe ` +
      'for destructive operations.',
  );
  // eslint-disable-next-line n/no-process-exit
  process.exit(1);
}
```