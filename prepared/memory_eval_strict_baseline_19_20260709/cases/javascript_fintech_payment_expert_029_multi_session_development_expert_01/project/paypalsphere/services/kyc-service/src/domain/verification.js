```javascript
/**
 * File: paypalsphere/services/kyc-service/src/domain/verification.js
 *
 * Domain layer aggregate for KYC verification.
 * Implements event-sourced state transitions and produces domain events
 * that are later persisted by the infrastructure layer.
 *
 * NOTE: This file purposefully contains no persistence logic. Instead,
 * events are emitted to be stored by the event-store adapter.
 */

'use strict';

/* ── Dependencies ────────────────────────────────────────────────────────── */
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const EventEmitter = require('events');

/* ── Constants & Enums ───────────────────────────────────────────────────── */
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256bit key for AES
const IV_LENGTH = 16;  // 128bit IV for AES

const VerificationStatus = Object.freeze({
  PENDING:        'PENDING',
  IN_PROGRESS:    'IN_PROGRESS',
  PASSED:         'PASSED',
  FAILED:         'FAILED',
  MANUAL_REVIEW:  'MANUAL_REVIEW',
  REJECTED:       'REJECTED',
});

/**
 * Domain event names.  These events flow through the CQRS/Event-Sourcing
 * pipeline and can be subscribed to by other bounded contexts.
 */
const VerificationEventTypes = Object.freeze({
  VERIFICATION_REQUESTED:  'verification.requested',
  VERIFICATION_STARTED:    'verification.started',
  VERIFICATION_PASSED:     'verification.passed',
  VERIFICATION_FAILED:     'verification.failed',
  VERIFICATION_ESCALATED:  'verification.escalated',
  VERIFICATION_REJECTED:   'verification.rejected',
});

/* ── Util: (De)Encryption helpers ────────────────────────────────────────── */
const generateKey = () => crypto.randomBytes(KEY_LENGTH);

const encrypt = (plaintext, key) => {
  if (!plaintext) return '';
  const iv   = crypto.randomBytes(IV_LENGTH);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
};

const decrypt = (ciphertext, key) => {
  if (!ciphertext) return '';
  const data = Buffer.from(ciphertext, 'base64');
  const iv   = data.slice(0, IV_LENGTH);
  const tag  = data.slice(IV_LENGTH, IV_LENGTH + 16);
  const text = data.slice(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(text), decipher.final()]);
  return dec.toString('utf8');
};

/* ── Value Objects ───────────────────────────────────────────────────────── */
/**
 * Represents a government-issued document that is stored in encrypted form.
 */
class EncryptedDocument {
  #key;                 // Buffer (not persisted)
  #numberEncrypted;     // string (ciphertext)

  constructor({ type, number, country, expiresAt }) {
    if (!type || !number || !country) {
      throw new TypeError('Document requires type, number and country');
    }
    this.id         = uuid();
    this.type       = type;     // e.g., "PASSPORT", "NATIONAL_ID"
    this.country    = country;  // ISO-3166 alpha-2
    this.expiresAt  = expiresAt ? new Date(expiresAt) : null;
    this.issuedAt   = new Date();
    this.#key       = generateKey();
    this.#numberEncrypted = encrypt(number, this.#key);
  }

  getMaskedNumber(lastDigits = 4) {
    const decrypted = decrypt(this.#numberEncrypted, this.#key);
    return decrypted.slice(-lastDigits).padStart(decrypted.length, '*');
  }

  /**
   * Serialize object without leaking key or raw number.
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      country: this.country,
      expiresAt: this.expiresAt,
      issuedAt: this.issuedAt,
      maskedNumber: this.getMaskedNumber(),
    };
  }
}

/* ── Domain Aggregate: Verification ──────────────────────────────────────── */
class Verification extends EventEmitter {
  /* eslint-disable max-params */
  constructor({ verificationId, accountId, documents = [], createdAt, status }) {
    super();
    this.verificationId = verificationId ?? uuid();
    this.accountId      = accountId;                 // Customer/Wallet owner
    this.documents      = documents;                 // Array<EncryptedDocument>
    this.createdAt      = createdAt ?? new Date();
    this.status         = status ?? VerificationStatus.PENDING;
    this.failedReason   = null;
    this._uncommitted   = [];  // Event staging buffer for Event-Store
  }
  /* eslint-enable max-params */

  /* ── Factory ──────────────────────────────────────────────────────────── */
  static request({ accountId, documents }) {
    const verification = new Verification({ accountId, documents });
    verification.#recordEvent(VerificationEventTypes.VERIFICATION_REQUESTED, {
      accountId,
      documents: documents.map(d => d.toJSON()),
    });
    return verification;
  }

  /* ── Command Methods (generate events) ────────────────────────────────── */
  start() {
    this.#assertState([VerificationStatus.PENDING]);
    this.#recordEvent(VerificationEventTypes.VERIFICATION_STARTED);
  }

  pass() {
    this.#assertState([VerificationStatus.IN_PROGRESS, VerificationStatus.MANUAL_REVIEW]);
    this.#recordEvent(VerificationEventTypes.VERIFICATION_PASSED);
  }

  fail(reason) {
    this.#assertState([VerificationStatus.IN_PROGRESS, VerificationStatus.MANUAL_REVIEW]);
    if (!reason) throw new Error('Failure reason is required');
    this.#recordEvent(VerificationEventTypes.VERIFICATION_FAILED, { reason });
  }

  escalate(reason) {
    this.#assertState([VerificationStatus.IN_PROGRESS]);
    this.#recordEvent(VerificationEventTypes.VERIFICATION_ESCALATED, { reason });
  }

  reject(reason) {
    this.#assertState([VerificationStatus.PENDING, VerificationStatus.IN_PROGRESS]);
    if (!reason) throw new Error('Rejection reason required');
    this.#recordEvent(VerificationEventTypes.VERIFICATION_REJECTED, { reason });
  }

  /* ── Event Applier ────────────────────────────────────────────────────── */
  apply(event) {
    const { type, data, timestamp } = event;
    switch (type) {
      case VerificationEventTypes.VERIFICATION_REQUESTED:
        this.createdAt = timestamp;
        this.status    = VerificationStatus.PENDING;
        break;

      case VerificationEventTypes.VERIFICATION_STARTED:
        this.status = VerificationStatus.IN_PROGRESS;
        break;

      case VerificationEventTypes.VERIFICATION_PASSED:
        this.status = VerificationStatus.PASSED;
        break;

      case VerificationEventTypes.VERIFICATION_FAILED:
        this.status       = VerificationStatus.FAILED;
        this.failedReason = data.reason;
        break;

      case VerificationEventTypes.VERIFICATION_ESCALATED:
        this.status = VerificationStatus.MANUAL_REVIEW;
        break;

      case VerificationEventTypes.VERIFICATION_REJECTED:
        this.status       = VerificationStatus.REJECTED;
        this.failedReason = data.reason;
        break;

      default:
        // Unknown events are ignored but logged for auditing
        // eslint-disable-next-line no-console
        console.warn(`Unknown event type: ${type}`);
    }
  }

  /**
   * Rehydrates aggregate from an event stream.
   *
   * @param {Array<{type: string, data: Object, timestamp: Date}>} events
   * @returns {Verification}
   */
  static rebuild(events = []) {
    if (!events.length) throw new Error('Event stream cannot be empty');

    const first = events[0];
    if (first.type !== VerificationEventTypes.VERIFICATION_REQUESTED) {
      throw new Error('Invalid event stream: first event must be VERIFICATION_REQUESTED');
    }

    const aggregate = new Verification({
      verificationId: first.aggregateId,
      accountId: first.data.accountId,
    });

    events.forEach(evt => aggregate.apply(evt));
    aggregate.markCommitted();
    return aggregate;
  }

  /* ── Public helpers ───────────────────────────────────────────────────── */
  /**
   * Returns uncommitted events and empties the buffer.
   * The application layer will persist these and then call markCommitted().
   */
  pullUncommittedEvents() {
    return [...this._uncommitted];
  }

  markCommitted() {
    this._uncommitted.length = 0;
  }

  /* ── Private helpers ──────────────────────────────────────────────────── */
  #recordEvent(type, data = {}) {
    const event = {
      id: uuid(),
      aggregateId: this.verificationId,
      type,
      data,
      timestamp: new Date(),
    };
    this._uncommitted.push(event);
    // mutating internal state for immediate consistency
    this.apply(event);
    // Emit in-memory for local handlers (e.g., risk scoring saga)
    this.emit('domain_event', event);
  }

  #assertState(allowedStates) {
    if (!allowedStates.includes(this.status)) {
      throw new Error(
        `Invalid state transition. Current state: ${this.status}. Expected: ${allowedStates.join(', ')}`
      );
    }
  }
}

/* ── Module Exports ─────────────────────────────────────────────────────── */
module.exports = {
  Verification,
  VerificationStatus,
  VerificationEventTypes,
  EncryptedDocument,
};
```