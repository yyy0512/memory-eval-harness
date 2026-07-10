import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import Decimal from 'decimal.js-light';

/**
 * MediTrade Pulse – Risk-Assessment Module
 * ---------------------------------------
 * Hexagonal domain service that evaluates financial and
 * clinical-compliance risk for an incoming Order.
 */

/* ────────────────────────────
   Domain primitives & types
   ──────────────────────────── */

export enum CurrencyCode {
  USD = 'USD',
  EUR = 'EUR',
  GBP = 'GBP',
  CHF = 'CHF',
  JPY = 'JPY',
}

export enum CommodityType {
  PPE_FUTURE = 'PPE_FUTURE',
  VACCINE_BATCH = 'VACCINE_BATCH',
  PHARMA_OPTION = 'PHARMA_OPTION',
}

type ISODateString = string; // e.g. "2024-08-01"

export interface Order {
  readonly id: string;
  readonly commodity: CommodityType;
  readonly quantity: Decimal;
  readonly currency: CurrencyCode;
  readonly pricePerUnit: Decimal; // denominated in `currency`
  readonly deliveryDate: ISODateString;
  readonly metadata?: Record<string, unknown>;
}

export enum ClinicalComplianceFlag {
  BATCH_RECALL = 'BATCH_RECALL',
  EXPIRY_NEAR = 'EXPIRY_NEAR',
  TEMPERATURE_EXCURSION = 'TEMPERATURE_EXCURSION',
  UNKNOWN_SUPPLIER = 'UNKNOWN_SUPPLIER',
  PATIENT_SAFETY_ALERT = 'PATIENT_SAFETY_ALERT',
}

export interface RiskScore {
  readonly score: number; // 0 (safe) … 100 (halt)
  readonly reasons: string[];
}

export interface DomainEvent {
  readonly id: string;
  readonly occurredAt: Date;
  readonly type: string;
  readonly payload: unknown;
}

export interface RiskAssessmentResult {
  readonly orderId: string;
  readonly riskScore: RiskScore;
  readonly complianceFlags: ReadonlyArray<ClinicalComplianceFlag>;
}

/* ────────────────────────────
   Hexagonal Ports (interfaces)
   ──────────────────────────── */

export interface PricingFeedPort {
  getFxRate(from: CurrencyCode, to: CurrencyCode): Promise<Decimal>;
  getLatestCommodityPrice(
    commodity: CommodityType,
    inCurrency: CurrencyCode,
  ): Promise<Decimal>;
}

export interface ComplianceRepositoryPort {
  getFlagsForCommodity(
    commodity: CommodityType,
    deliveryDate: ISODateString,
  ): Promise<ClinicalComplianceFlag[]>;
}

export interface EventPublisherPort {
  publish(event: DomainEvent): Promise<void>;
}

export interface LoggerPort {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string | Error, meta?: unknown): void;
}

/* ────────────────────────────
   Domain Service
   ──────────────────────────── */

export class RiskAssessmentService {
  private static readonly MAX_ACCEPTABLE_RISK = 60; // policy threshold

  constructor(
    private readonly pricingFeed: PricingFeedPort,
    private readonly complianceRepo: ComplianceRepositoryPort,
    private readonly eventPublisher: EventPublisherPort,
    private readonly logger: LoggerPort,
  ) {}

  /**
   * Perform risk & compliance assessment for the supplied Order.
   * Publishes a `RiskAssessmentCompleted` event irrespective of outcome.
   */
  public async assess(order: Order): Promise<RiskAssessmentResult> {
    this.logger.debug('Starting risk assessment', { orderId: order.id });

    /* 1. Clinical compliance flags */
    const complianceFlags = await this.safeFetchCompliance(order);

    /* 2. Market-risk calculation */
    const marketRiskScore = await this.calculateMarketRisk(order);

    /* 3. Clinical-compliance risk */
    const complianceRiskScore = complianceFlags.length > 0 ? 40 : 0;

    /* 4. Aggregate */
    const totalScore = Math.min(100, marketRiskScore + complianceRiskScore);
    const riskScore: RiskScore = {
      score: totalScore,
      reasons: this.deriveReasons(
        marketRiskScore,
        complianceRiskScore,
        complianceFlags,
      ),
    };

    const result: RiskAssessmentResult = {
      orderId: order.id,
      riskScore,
      complianceFlags,
    };

    /* 5. Publish domain event */
    await this.publishEvent({
      id: uuid(),
      occurredAt: new Date(),
      type: 'RiskAssessmentCompleted',
      payload: result,
    });

    /* 6. Log outcome */
    if (riskScore.score >= RiskAssessmentService.MAX_ACCEPTABLE_RISK) {
      this.logger.warn('High risk score detected', {
        orderId: order.id,
        risk: riskScore.score,
      });
    } else {
      this.logger.info('Risk assessment completed', {
        orderId: order.id,
        risk: riskScore.score,
      });
    }

    return result;
  }

  /* ────────────── Private helpers ────────────── */

  private async safeFetchCompliance(
    order: Order,
  ): Promise<ClinicalComplianceFlag[]> {
    try {
      return await this.complianceRepo.getFlagsForCommodity(
        order.commodity,
        order.deliveryDate,
      );
    } catch (error) {
      this.logger.error('Compliance repository error', error);
      // If compliance cannot be verified, conservatively assume risk.
      return [ClinicalComplianceFlag.PATIENT_SAFETY_ALERT];
    }
  }

  /**
   * Considers price deviation vs. latest market price as a proxy for volatility.
   * More sophisticated VaR models could be plugged-in here.
   */
  private async calculateMarketRisk(order: Order): Promise<number> {
    let currentPrice: Decimal;

    try {
      currentPrice = await this.pricingFeed.getLatestCommodityPrice(
        order.commodity,
        order.currency,
      );
    } catch (error) {
      this.logger.error('Pricing feed unavailable', error);
      // Lack of data ⇒ conservative assumption.
      return 60;
    }

    if (currentPrice.equals(0)) {
      this.logger.warn('Current price is zero; cannot compute risk', {
        commodity: order.commodity,
      });
      return 50;
    }

    const deviation = order.pricePerUnit
      .minus(currentPrice)
      .abs()
      .div(currentPrice)
      .mul(100); // percentage

    const riskScore = deviation.lessThan(50)
      ? deviation.mul(0.8) // 0–50 % ⇒ 0–40 pts
      : deviation.mul(0.6).plus(10); // >50 % ⇒ 40–70 pts

    return Math.min(70, Math.max(0, riskScore.toNumber()));
  }

  private deriveReasons(
    marketRisk: number,
    complianceRisk: number,
    flags: ClinicalComplianceFlag[],
  ): string[] {
    const reasons: string[] = [];

    if (marketRisk >= 50) reasons.push('High price volatility');
    else if (marketRisk >= 30) reasons.push('Moderate price deviation');

    if (complianceRisk > 0) reasons.push('Clinical compliance flags present');

    for (const flag of flags) reasons.push(`Flag: ${flag}`);

    return reasons;
  }

  private async publishEvent(event: DomainEvent): Promise<void> {
    try {
      await this.eventPublisher.publish(event);
    } catch (error) {
      // Publishing failures must never block trade processing.
      this.logger.error('Failed to publish domain event', {
        eventType: event.type,
        error,
      });
    }
  }
}

/* ────────────────────────────
   In-memory fallback adapters
   (used for tests / local dev only)
   ──────────────────────────── */

class InMemoryEventPublisher implements EventPublisherPort {
  private readonly emitter = new EventEmitter();

  async publish(event: DomainEvent): Promise<void> {
    this.emitter.emit(event.type, event);
  }

  on(eventType: string, listener: (e: DomainEvent) => void): void {
    this.emitter.on(eventType, listener);
  }
}

class ConsoleLogger implements LoggerPort {
  debug(msg: string, meta?: unknown): void {
    // eslint-disable-next-line no-console
    console.debug('[DEBUG]', msg, meta ?? '');
  }
  info(msg: string, meta?: unknown): void {
    // eslint-disable-next-line no-console
    console.info('[INFO] ', msg, meta ?? '');
  }
  warn(msg: string, meta?: unknown): void {
    // eslint-disable-next-line no-console
    console.warn('[WARN] ', msg, meta ?? '');
  }
  error(msg: string | Error, meta?: unknown): void {
    // eslint-disable-next-line no-console
    console.error('[ERROR]', msg instanceof Error ? msg.message : msg, meta ?? '');
  }
}

/* ────────────────────────────
   Example bootstrap (CLI demo)
   ──────────────────────────── */

if (require.main === module) {
  (async () => {
    const pricingFeed: PricingFeedPort = {
      async getFxRate() {
        return new Decimal(1); // stub
      },
      async getLatestCommodityPrice() {
        return new Decimal(100); // stub
      },
    };

    const complianceRepo: ComplianceRepositoryPort = {
      async getFlagsForCommodity() {
        return []; // stub
      },
    };

    const service = new RiskAssessmentService(
      pricingFeed,
      complianceRepo,
      new InMemoryEventPublisher(),
      new ConsoleLogger(),
    );

    const order: Order = {
      id: uuid(),
      commodity: CommodityType.PPE_FUTURE,
      quantity: new Decimal(1_000),
      currency: CurrencyCode.USD,
      pricePerUnit: new Decimal(110),
      deliveryDate: new Date(Date.now() + 2.592e9).toISOString().slice(0, 10), // +30d
      metadata: { unit: 'box' },
    };

    await service.assess(order);
  })();
}