```javascript
/**
 * transactions-service :: Transaction Aggregate Root
 *
 * The Aggregate represents the canonical source of truth for a single monetary
 * transaction in the PayPalsphere ecosystem.  It is fully event-sourced: every
 * state transition is captured as an immutable domain event that is persisted
 * by the event-store layer (not implemented here).
 *
 * NOTE: This file is intentionally self-contained so that it can be consumed
 * in isolation during unit tests.  The surrounding infrastructure (command
 * handlers, event store, projections, saga orchestrators, etc.) will import
 * this aggregate and wire it up at runtime.
 */

import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import EventEmitter from 'events';

/* -------------------------------------------------------------------------- */
/* Helpers & Domain Errors                                                    */
/* -------------------------------------------------------------------------- */

class DomainError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = this.constructor.name;
    this.metadata = metadata;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Encrypts sensitive payload fragments. In real life this would be supplied by
 * a crypto service module that rotates keys.  AES-256-GCM is used here for the
 * sake of example only.
 */
function encryptField(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    cipherText: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    algo: 'aes-256-gcm'
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregate Infrastructure                                                   */
/* -------------------------------------------------------------------------- */

class AggregateRoot extends EventEmitter {
  constructor() {
    super();
    this._uncommittedEvents = [];
    this._version = 0;
  }

  get uncommittedEvents() {
    return this._uncommittedEvents;
  }

  markEventsAsCommitted() {
    this._uncommittedEvents.length = 0;
  }

  /**
   * Records and applies an event to the aggregate.
   */
  _raise(event) {
    event.aggregateId = this.id;
    event.version = ++this._version;
    this._apply(event);
    this._uncommittedEvents.push(event);
    this.emit('event', event);
  }

  /**
   * Apply (replay) an event without raising it. Used when rebuilding from
   * history.
   */
  _apply(event) {
    const handler = this[`_on${event.type}`];
    if (typeof handler === 'function') {
      handler.call(this, event);
    }
  }

  /**
   * Rebuild aggregate from event history.
   */
  static rehydrate(eventStream = []) {
    const instance = new this();
    for (const evt of eventStream) {
      instance._apply(evt);
      instance._version = evt.version; // maintain correct revision
    }
    return instance;
  }
}

/* -------------------------------------------------------------------------- */
/* Domain Events                                                              */
/* -------------------------------------------------------------------------- */

const EVENT_TYPES = Object.freeze({
  TransactionInitiated: 'TransactionInitiated',
  TransactionAuthorized: 'TransactionAuthorized',
  TransactionCaptured: 'TransactionCaptured',
  TransactionFailed: 'TransactionFailed',
  TransactionCancelled: 'TransactionCancelled',
  TransactionReversed: 'TransactionReversed'
});

/* -------------------------------------------------------------------------- */
/* Transaction Aggregate                                                      */
/* -------------------------------------------------------------------------- */

export const TRANSACTION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REVERSED: 'REVERSED'
});

export default class TransactionAggregate extends AggregateRoot {
  /* --------------------------------- State -------------------------------- */

  id;
  debitorAccountId;
  creditorAccountId;
  currency;
  amount; // decimal string to avoid JS floating point
  description; // user-supplied
  status = TRANSACTION_STATUS.PENDING;
  createdAt;
  updatedAt;

  /* ---------------------------- Root Constructor -------------------------- */

  constructor() {
    super();
  }

  /* --------------------------- Command Handlers --------------------------- */

  /**
   * Factory method – initiate a transaction
   */
  static initiate({
    debitorAccountId,
    creditorAccountId,
    amount,
    currency = 'USD',
    description = ''
  }) {
    // basic validation
    if (!debitorAccountId || !creditorAccountId) {
      throw new DomainError('Both debitor and creditor account IDs are required');
    }

    if (debitorAccountId === creditorAccountId) {
      throw new DomainError('Debitor and creditor must differ');
    }

    if (!/^\d+(\.\d{1,2})?$/.test(String(amount))) {
      throw new DomainError('Amount must be a decimal string with up to 2 fraction digits');
    }

    const aggregate = new TransactionAggregate();
    aggregate._raise({
      type: EVENT_TYPES.TransactionInitiated,
      payload: {
        id: uuid(),
        debitorAccountId,
        creditorAccountId,
        amount: String(amount),
        currency,
        description,
        createdAt: new Date().toISOString()
      }
    });

    return aggregate;
  }

  /**
   * Authorize a pending transaction after risk / KYC checks
   */
  authorize({ authorizerId, riskScore }) {
    if (this.status !== TRANSACTION_STATUS.PENDING) {
      throw new DomainError('Only PENDING transactions can be authorized', {
        currentStatus: this.status
      });
    }

    if (riskScore > 700) {
      throw new DomainError('High risk score – authorization denied', { riskScore });
    }

    this._raise({
      type: EVENT_TYPES.TransactionAuthorized,
      payload: {
        authorizerId,
        riskScore,
        authorizedAt: new Date().toISOString()
      }
    });
  }

  /**
   * Capture (move) funds after authorization completes
   */
  capture({ settlementId }) {
    if (this.status !== TRANSACTION_STATUS.AUTHORIZED) {
      throw new DomainError('Only AUTHORIZED transactions can be captured', {
        currentStatus: this.status
      });
    }

    this._raise({
      type: EVENT_TYPES.TransactionCaptured,
      payload: {
        settlementId,
        capturedAt: new Date().toISOString()
      }
    });
  }

  /**
   * Fail a transaction (e.g., insufficient funds, compliance block)
   */
  fail({ reason, code }) {
    if (![TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.AUTHORIZED].includes(this.status)) {
      throw new DomainError('Transaction cannot be failed in its current status', {
        currentStatus: this.status
      });
    }

    this._raise({
      type: EVENT_TYPES.TransactionFailed,
      payload: {
        reason,
        code,
        failedAt: new Date().toISOString()
      }
    });
  }

  /**
   * Cancel a transaction by user request before capture
   */
  cancel({ cancelledBy }) {
    if (this.status !== TRANSACTION_STATUS.PENDING) {
      throw new DomainError('Only PENDING transactions can be cancelled', {
        currentStatus: this.status
      });
    }

    this._raise({
      type: EVENT_TYPES.TransactionCancelled,
      payload: {
        cancelledBy,
        cancelledAt: new Date().toISOString()
      }
    });
  }

  /**
   * Reverse a captured transaction (e.g., refund)
   */
  reverse({ reversedBy, reason }) {
    if (this.status !== TRANSACTION_STATUS.CAPTURED) {
      throw new DomainError('Only CAPTURED transactions can be reversed', {
        currentStatus: this.status
      });
    }

    this._raise({
      type: EVENT_TYPES.TransactionReversed,
      payload: {
        reversedBy,
        reason,
        reversedAt: new Date().toISOString()
      }
    });
  }

  /* ------------------------------- Event Appliers ------------------------- */
  /* Each _on<Event> method mutates internal state deterministically.         */

  _onTransactionInitiated(evt) {
    const { id, debitorAccountId, creditorAccountId, amount, currency, description, createdAt } =
      evt.payload;

    // Encrypt sensitive description text (could contain PII).
    const encryptionKey = crypto
      .createHash('sha256')
      .update(process.env.TRANSACTIONS_ENC_KEY || 'dev-key')
      .digest();

    const encryptedDescription = encryptField(description, encryptionKey);

    this.id = id;
    this.debitorAccountId = debitorAccountId;
    this.creditorAccountId = creditorAccountId;
    this.amount = amount;
    this.currency = currency;
    this.description = encryptedDescription; // store encrypted blob
    this.status = TRANSACTION_STATUS.PENDING;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  _onTransactionAuthorized(evt) {
    const { authorizerId, riskScore, authorizedAt } = evt.payload;
    this.status = TRANSACTION_STATUS.AUTHORIZED;
    this.authorizerId = authorizerId;
    this.riskScore = riskScore;
    this.updatedAt = authorizedAt;
  }

  _onTransactionCaptured(evt) {
    const { settlementId, capturedAt } = evt.payload;
    this.status = TRANSACTION_STATUS.CAPTURED;
    this.settlementId = settlementId;
    this.updatedAt = capturedAt;
  }

  _onTransactionFailed(evt) {
    const { reason, code, failedAt } = evt.payload;
    this.status = TRANSACTION_STATUS.FAILED;
    this.failureReason = reason;
    this.failureCode = code;
    this.updatedAt = failedAt;
  }

  _onTransactionCancelled(evt) {
    const { cancelledBy, cancelledAt } = evt.payload;
    this.status = TRANSACTION_STATUS.CANCELLED;
    this.cancelledBy = cancelledBy;
    this.updatedAt = cancelledAt;
  }

  _onTransactionReversed(evt) {
    const { reversedBy, reason, reversedAt } = evt.payload;
    this.status = TRANSACTION_STATUS.REVERSED;
    this.reversedBy = reversedBy;
    this.reversalReason = reason;
    this.updatedAt = reversedAt;
  }

  /* ------------------------------ Serialization --------------------------- */

  /**
   * Returns a plain JSON representation (safe for public APIs – encrypted
   * fields stay encrypted).
   */
  toJSON() {
    return {
      id: this.id,
      debitorAccountId: this.debitorAccountId,
      creditorAccountId: this.creditorAccountId,
      amount: this.amount,
      currency: this.currency,
      description: this.description, // encrypted object
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      version: this._version
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Module Exports                                                             */
/* -------------------------------------------------------------------------- */

export { DomainError, EVENT_TYPES };
```