```typescript
/* eslint-disable max-classes-per-file */
/* eslint-disable @typescript-eslint/no-non-null-assertion */

/**
 * tests/test_main.ts
 *
 * High-value integration tests that exercise the public API of MediTrade-Pulse’s
 * application layer.  The tests run completely in-memory; no network or
 * database calls cross the process boundary, which keeps feedback loops fast
 * without sacrificing business-logic coverage.
 */

import 'reflect-metadata';

import { v4 as uuid } from 'uuid';
import { addDays, subDays } from 'date-fns';

import { Order, OrderSide, OrderStatus } from '../src/domain/orders/Order';
import { TradeService } from '../src/application/services/TradeService';
import { InMemoryEventStore } from '../src/infrastructure/eventStore/InMemoryEventStore';
import { RiskAssessmentService } from '../src/domain/risk/RiskAssessmentService';
import { ClinicalComplianceError } from '../src/domain/compliance/ClinicalComplianceError';
import { Portfolio } from '../src/domain/portfolio/Portfolio';
import { PortfolioRepository } from '../src/domain/portfolio/PortfolioRepository';
import { Currency } from '../src/domain/currency/Currency';

/**
 * ---------------------------------------------------------------------------
 * Test-scoped fixtures & stubs
 * ---------------------------------------------------------------------------
 */

/**
 * A minimal, in-memory PortfolioRepository that mimics the behaviour of the
 * production adapter while avoiding external dependencies.
 */
class MockPortfolioRepository implements PortfolioRepository {
  private readonly store = new Map<string, Portfolio>();

  async getById(id: string): Promise<Portfolio | undefined> {
    return this.store.get(id);
  }

  async save(portfolio: Portfolio): Promise<void> {
    this.store.set(portfolio.id, portfolio);
  }

  clear(): void {
    this.store.clear();
  }
}

/**
 * Deterministic implementation of RiskAssessmentService so that tests can
 * specify the exact score returned for a given order.
 */
class StubRiskAssessmentService implements RiskAssessmentService {
  constructor(private readonly nextScore = 0.15) {}

  async assess(): Promise<number> {
    return this.nextScore;
  }
}

/**
 * ---------------------------------------------------------------------------
 * Test suite
 * ---------------------------------------------------------------------------
 */

describe('TradeService – functional contract tests', () => {
  let eventStore: InMemoryEventStore;
  let portfolioRepository: MockPortfolioRepository;
  let riskService: StubRiskAssessmentService;
  let tradeService: TradeService;

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    portfolioRepository = new MockPortfolioRepository();
    riskService = new StubRiskAssessmentService();
    tradeService = new TradeService(eventStore, portfolioRepository, riskService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('places a compliant BUY order, persists events, and updates portfolio', async () => {
    // Arrange
    const portfolioId = uuid();
    const currency = Currency.USD;

    await portfolioRepository.save(Portfolio.open(portfolioId, currency));

    const order = Order.place({
      instrumentCode: 'PPE-FUT-JUN24',
      side: OrderSide.Buy,
      quantity: 1_000,
      price: 12.5,
      currency,
      settlementDate: addDays(new Date(), 2),
      clinicalExpiry: addDays(new Date(), 365),
      portfolioId,
    });

    // Act
    await tradeService.execute(order);

    // Assert – Order lifecycle
    expect(order.status).toBe(OrderStatus.Filled);

    // Assert – Event-sourcing contract
    const persistedEvents = eventStore.getEventsForAggregate(order.id);
    expect(persistedEvents.length).toBeGreaterThan(0);
    expect(persistedEvents.some(e => e.type === 'OrderPlaced')).toBe(true);

    // Assert – Portfolio projection
    const updatedPortfolio = await portfolioRepository.getById(portfolioId);
    expect(updatedPortfolio?.positions['PPE-FUT-JUN24']).toEqual(1_000);
  });

  it('rejects an order that violates clinical expiry compliance', async () => {
    // Arrange
    const portfolioId = uuid();
    await portfolioRepository.save(Portfolio.open(portfolioId, Currency.EUR));

    const nonCompliantOrder = Order.place({
      instrumentCode: 'RX-OPT-SEP24',
      side: OrderSide.Sell,
      quantity: 250,
      price: 44.8,
      currency: Currency.EUR,
      settlementDate: addDays(new Date(), 2),
      clinicalExpiry: subDays(new Date(), 1), // Expired!
      portfolioId,
    });

    // Act / Assert
    await expect(tradeService.execute(nonCompliantOrder)).rejects.toThrow(
      ClinicalComplianceError,
    );

    // No events must be stored for a rejected order
    expect(eventStore.getEventsForAggregate(nonCompliantOrder.id)).toHaveLength(0);
  });

  it('records high-risk orders in the event stream, even when accepted', async () => {
    // Arrange – inject a higher risk score just under the maximum threshold
    riskService = new StubRiskAssessmentService(0.79);
    tradeService = new TradeService(eventStore, portfolioRepository, riskService);

    const portfolioId = uuid();
    await portfolioRepository.save(Portfolio.open(portfolioId, Currency.GBP));

    const riskyOrder = Order.place({
      instrumentCode: 'VACC-FWD-NOV24',
      side: OrderSide.Buy,
      quantity: 5,
      price: 21_000,
      currency: Currency.GBP,
      settlementDate: addDays(new Date(), 5),
      clinicalExpiry: addDays(new Date(), 180),
      portfolioId,
    });

    // Act
    await tradeService.execute(riskyOrder);

    // Assert – look for RiskEvaluated event
    const events = eventStore.getEventsForAggregate(riskyOrder.id);
    const riskEvent = events.find(e => e.type === 'RiskEvaluated');
    expect(riskEvent).toBeDefined();
    expect(riskEvent!.payload.score).toBeCloseTo(0.79, 2);
  });

  it('spins up a multi-currency settlement saga for cross-currency orders', async () => {
    // Arrange
    const portfolioId = uuid();
    await portfolioRepository.save(Portfolio.open(portfolioId, Currency.USD));

    const fxOrder = Order.place({
      instrumentCode: 'PPE-FWD-AUD24',
      side: OrderSide.Buy,
      quantity: 500,
      price: 21,
      currency: Currency.AUD, // Cross-currency relative to the USD portfolio
      settlementDate: addDays(new Date(), 3),
      clinicalExpiry: addDays(new Date(), 120),
      portfolioId,
    });

    // Act
    await tradeService.execute(fxOrder);

    // Assert – Settlement saga
    const events = eventStore.getEventsForAggregate(fxOrder.id);
    const sagaEvent = events.find(e => e.type === 'SettlementSagaStarted');
    expect(sagaEvent).toBeDefined();
    expect(sagaEvent!.payload.settlementCurrency).toBe(Currency.AUD);
  });
});
```