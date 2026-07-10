```javascript
/**************************************************************************************************
 * @file   create-transaction.handler.js
 * @brief  Command-side handler responsible for orchestrating the creation of a Transaction
 *         aggregate root inside the Transactions bounded-context.
 *
 *         The handler embraces CQRS & Event-Sourcing principles; it validates intent, calls out
 *         to dependent domain services (KYC, Risk, Accounts), spins up the aggregate, persists
 *         it via the repository (backed by an event-store), and finally makes sure resulting
 *         domain events are published on the global Event Bus for downstream projections, sagas
 *         and micro-frontends to consume.
 *
 * @author PayPalsphere
 **************************************************************************************************/

/* ──────────────────────────────────────────────────────────────────────────  External Imports ─┐ */
import crypto            from 'crypto';
import { v4 as uuid }    from 'uuid';
import boom              from '@hapi/boom';             // Lightweight HTTP-friendly errors
import Joi               from 'joi';                    // Runtime payload validation
/* ───────────────────────────────────────────────────────────────────────────────────────────────┘ */

/* ────────────────────────────────────────────────────────────────────────────  Internal Imports ─┐ */
import { logger }                       from '../../infrastructure/logger.js';
import { EventBus }                     from '../../infrastructure/event-bus/event-bus.js';
import { TransactionRepository }        from '../../infrastructure/repositories/transaction.repository.js';
import { AccountsServiceProxy }         from '../../infrastructure/proxies/accounts-service.proxy.js';
import { KycServiceProxy }             from '../../infrastructure/proxies/kyc-service.proxy.js';
import { RiskServiceProxy }            from '../../infrastructure/proxies/risk-service.proxy.js';
import { TransactionAggregate }         from '../../domain/aggregates/transaction.aggregate.js';
import { Masker }                       from '../../shared/utils/masker.js';        // PII masking
/* ───────────────────────────────────────────────────────────────────────────────────────────────┘ */

/**
 * Joi schema that *minimally* validates the command shape.
 * (Domain-level invariants live inside the aggregate itself.)
 */
const createTransactionCommandSchema = Joi.object({
  payerId      : Joi.string().uuid().required(),
  payeeId      : Joi.string().uuid().required(),
  currency     : Joi.string().length(3).uppercase().required(),
  amount       : Joi.number().precision(2).positive().required(),
  memo         : Joi.string().allow('').max(250),
  ipAddress    : Joi.string().ip({ version: [ 'ipv4', 'ipv6' ] }).required(),
  deviceId     : Joi.string().max(128).required(),
  circleId     : Joi.string().uuid().optional(), // social context
  metadata     : Joi.object().unknown(true).default({}),
}).required().unknown(false);

/**
 * A Production-grade Command Handler that complies with:
 *   - Explicit dependency injection (no hidden globals)
 *   - Fail-fast validation
 *   - Detailed, contextual logging with correlation ids
 *   - Security-by-Design (PII masking, encryption at rest, etc.)
 *   - Graceful error bubbling (Boom errors for HTTP, Error subclasses for queue / RPC)
 */
export class CreateTransactionHandler {

  /**
   * @param {Object} deps – Dependencies supplied by the application container.
   * @param {TransactionRepository} deps.transactionRepository
   * @param {EventBus}              deps.eventBus
   * @param {AccountsServiceProxy}  deps.accountsService
   * @param {KycServiceProxy}       deps.kycService
   * @param {RiskServiceProxy}      deps.riskService
   */
  constructor ({
    transactionRepository,
    eventBus,
    accountsService,
    kycService,
    riskService,
  }) {
    /* ── Basic DI sanity checks to avoid hidden run-time NullReference surprises ── */
    if (!transactionRepository || !eventBus || !accountsService || !kycService || !riskService) {
      throw new Error('[CreateTransactionHandler] Missing mandatory dependency');
    }

    /* eslint-disable no-underscore-dangle */
    this._repo          = transactionRepository;
    this._bus           = eventBus;
    this._accounts      = accountsService;
    this._kyc           = kycService;
    this._risk          = riskService;
    /* eslint-enable  no-underscore-dangle */
  }

  /**
   * Core entrypoint executed by the application layer.
   *
   * @param {Object}  command – The incoming intent from the client / message bus.
   * @param {Object}  meta    – Transport-level metadata.
   * @param {string}  meta.correlationId – Unique id propagated across services for observability.
   * @param {Object}  meta.actor         – Authenticated identity triggering the command.
   *
   * @returns {Promise<{ transactionId: string, status: string, riskScore: number }>}
   */
  async execute (command, { correlationId = uuid(), actor } = {}) {

    const timer = process.hrtime.bigint(); // High-res timer for latency metrics

    /* ───────────────────────────── 1. Payload Validation (Fail Fast) ────────────────────────── */
    const { error: validationError, value: dto } = createTransactionCommandSchema
      .prefs({ abortEarly: false, stripUnknown: true })
      .validate(command);

    if (validationError) {
      logger.warn(
        { correlationId, validationError, command: Masker.mask(command) },
        '📨  Rejecting CreateTransaction command – payload validation failed',
      );
      throw boom.badRequest('Invalid Transaction payload', validationError.details);
    }

    /* ─────────────────────────── 2. Retrieve Domain Resources in Parallel ───────────────────── */
    const [
      payerAccount,
      payeeAccount,
      payerKycStatus,
    ] = await Promise.all([
      this._accounts.getAccountById(dto.payerId),
      this._accounts.getAccountById(dto.payeeId),
      this._kyc.getKycStatus(dto.payerId),
    ]);

    if (!payerAccount) { throw boom.notFound(`Payer account ${dto.payerId} not found`); }
    if (!payeeAccount) { throw boom.notFound(`Payee account ${dto.payeeId} not found`); }

    /* ────────────────────────────── 3. KYC / Compliance Enforcement ─────────────────────────── */
    if (payerKycStatus !== 'APPROVED') {
      throw boom.forbidden(`Payer account ${dto.payerId} has not passed KYC verification`);
    }

    /* ─────────────────────────── 4. Risk Scoring & Early Fraud Detection ───────────────────── */
    const riskAssessment = await this._risk.scoreTransaction({
      payerId  : dto.payerId,
      payeeId  : dto.payeeId,
      amount   : dto.amount,
      currency : dto.currency,
      ip       : dto.ipAddress,
      deviceId : dto.deviceId,
      metadata : dto.metadata,
    });

    if (riskAssessment.flag === 'BLOCK') {
      throw boom.forbidden('Transaction denied – high risk profile');
    }

    /* ────────────────────── 5. Create and Persist Transaction Aggregate ─────────────────────── */
    const aggregate = TransactionAggregate.create({
      id           : uuid(),
      payerId      : dto.payerId,
      payeeId      : dto.payeeId,
      amount       : dto.amount,
      currency     : dto.currency,
      memo         : dto.memo,
      circleId     : dto.circleId || null,
      riskScore    : riskAssessment.score,
      createdBy    : actor?.id || 'system',
      metadata     : dto.metadata,
      ipAddress    : dto.ipAddress,
      deviceId     : dto.deviceId,
      createdAt    : new Date().toISOString(),
    });

    /* Persist the aggregate’s uncommitted events to the event-store/repository */
    await this._repo.save(aggregate, { correlationId });

    /* ────────────────────────────── 6. Publish Domain Events ────────────────────────────────── */
    const domainEvents = aggregate.pullUncommittedEvents();
    await Promise.all(
      domainEvents.map(evt => this._bus.publish(evt, { correlationId })),
    );

    logger.info(
      { correlationId, transactionId: aggregate.id, risk: riskAssessment },
      '✅  Transaction aggregate created & events published',
    );

    /* ─────────────────────────────── 7. Latency Metrics & Return ────────────────────────────── */
    const elapsedMs = Number(process.hrtime.bigint() - timer) / 1e6;
    logger.debug({ correlationId, elapsedMs }, '🕒  create-transaction handler latency');

    return {
      transactionId : aggregate.id,
      status        : aggregate.status,
      riskScore     : aggregate.riskScore,
    };
  }
}

/* ────────────────────────────────────────────  Factory Helper ───────────────────────────────── */
/**
 * Optional helper so tests / DI container can build a fully-wired handler with sane defaults.
 */
export const buildCreateTransactionHandler = ({ overrides = {} } = {}) => new CreateTransactionHandler({
  transactionRepository : overrides.transactionRepository || new TransactionRepository(),
  eventBus              : overrides.eventBus              || new EventBus(),
  accountsService       : overrides.accountsService       || new AccountsServiceProxy(),
  kycService            : overrides.kycService            || new KycServiceProxy(),
  riskService           : overrides.riskService           || new RiskServiceProxy(),
});
```