```javascript
/**
 * PayPalsphere – Transactions Service
 * Domain :: Events
 *
 * This module centralises definition, validation and (de)serialisation of all
 * Domain Events that can originate from the `transactions-service`.  Each event
 * is immutable, self-describing and enveloped with rich metadata so that it can
 * safely travel across bounded contexts and/or be persisted in the Event Store.
 *
 * Dependencies:
 *   – uuid    : RFC-4122 v4 ID generation for event & correlation identifiers
 *   – ajv     : Runtime JSON-Schema validation
 *
 * NOTE: The Event Bus / Event Store layer is **not** implemented here.  This
 * file is concerned only with *shape* and *safety* of events.
 */

import { v4 as uuidv4 } from 'uuid';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: true });

/* ============================================================================
 * Event Registry
 * ---------------------------------------------------------------------------
 * A process-wide registry so that we can:
 *   1) Serialize events by looking up their schema                 -> safety
 *   2) Hydrate events received over the wire back into class form  -> ergonomics
 * ==========================================================================*/

const _registry = new Map();

/**
 * Registers a DomainEvent class and attaches its schema to the AJV instance.
 *
 * @param {typeof DomainEvent} EventClass – concrete implementation
 */
function register(EventClass) {
  const key = `${EventClass.eventName}@${EventClass.version}`;
  if (_registry.has(key)) {
    // Defensive – we never want to override an existing schema at runtime
    throw new Error(`Event '${key}' already registered`);
  }

  // Attach schema to AJV so that we can validate payloads on the fly
  ajv.addSchema(EventClass.payloadSchema, key);

  _registry.set(key, EventClass);
}

/**
 * Looks up and returns a DomainEvent subclass given the envelope.
 *
 * @param {String} name
 * @param {Number} version
 * @returns {typeof DomainEvent}
 */
function resolve(name, version) {
  const key = `${name}@${version}`;
  const EventClass = _registry.get(key);
  if (!EventClass) {
    throw new Error(
      `Unrecognised domain event '${name}' with version '${version}'. ` +
        `Has the event been registered?`
    );
  }
  return EventClass;
}

/* ============================================================================
 * Base Class
 * ==========================================================================*/

/**
 * DomainEvent
 *
 * Base abstraction for all domain events.  Provides:
 *   – Strict immutability (Object.freeze)
 *   – Common metadata envelope
 *   – JSON serialisation helpers
 *
 * Sub-classes **must** provide a static `payloadSchema` JSON-Schema describing
 * their payload and a unique `eventName` string.
 */
export class DomainEvent {
  static version = 1;

  /**
   * Creates a new domain event.
   *
   * @param {Object} params
   * @param {String} params.aggregateId – ID of root aggregate
   * @param {Object} params.payload     – Event specific data
   * @param {Object} [params.meta]      – Optional overrides for correlation IDs, etc.
   */
  constructor({ aggregateId, payload, meta = {} }) {
    if (!aggregateId) {
      throw new Error('aggregateId must be supplied when constructing a DomainEvent');
    }

    // Validate incoming payload against JSON-Schema
    const key = `${this.constructor.eventName}@${this.constructor.version}`;
    const validate = ajv.getSchema(key);
    if (!validate(payload)) {
      const messages = (validate.errors || [])
        .map(e => `${e.instancePath} ${e.message}`)
        .join(', ');
      throw new Error(
        `Invalid payload for event '${key}'. Validation errors: ${messages}`
      );
    }

    // Envelope ---------------------------------------------------------------
    this.id = meta.id || uuidv4();
    this.name = this.constructor.eventName;
    this.version = this.constructor.version;
    this.timestamp = meta.timestamp || new Date().toISOString();
    this.aggregateId = aggregateId;

    // Causation / Correlation (for tracing Sagas & calls across bounded contexts)
    this.correlationId = meta.correlationId || uuidv4();
    this.causationId = meta.causationId || null;

    // Multi-tenant + auditing support
    this.tenantId = meta.tenantId || 'default';
    this.userId = meta.userId || null;
    this.ipAddress = meta.ipAddress || null;
    this.userAgent = meta.userAgent || null;
    this.source = meta.source || 'transactions-service';

    // Data -------------------------------------------------------------------
    this.payload = Object.freeze({ ...payload });

    // Lock this instance
    Object.freeze(this);
  }

  /* ------------------------------------------------------------------------
   * SERIALISATION
   * ---------------------------------------------------------------------- */

  /**
   * Converts event instance into plain JSON that can be emitted on the bus or
   * persisted to the event store.
   *
   * @returns {Object}
   */
  toJSON() {
    return {
      header: {
        id: this.id,
        name: this.name,
        version: this.version,
        timestamp: this.timestamp,
        aggregateId: this.aggregateId,
        correlationId: this.correlationId,
        causationId: this.causationId,
        tenantId: this.tenantId,
        userId: this.userId,
        ipAddress: this.ipAddress,
        userAgent: this.userAgent,
        source: this.source
      },
      payload: this.payload
    };
  }

  /**
   * Serialises the event into a compact string that can be placed on the
   * message queue (UTF-8).
   *
   * @returns {String}
   */
  toString() {
    return JSON.stringify(this.toJSON());
  }

  /* ------------------------------------------------------------------------
   * DESERIALISATION
   * ---------------------------------------------------------------------- */

  /**
   * Hydrates a DomainEvent instance from a raw JSON object (e.g., retrieved
   * from Kafka / RabbitMQ / EventStoreDB).
   *
   * @param {Object} json
   * @returns {DomainEvent}
   */
  static fromJSON(json) {
    if (!json?.header || !json?.payload) {
      throw new Error('Malformed event—expected {header, payload} keys');
    }
    const { header, payload } = json;
    const EventClass = resolve(header.name, header.version);

    return new EventClass({
      aggregateId: header.aggregateId,
      payload,
      meta: {
        ...header,
        id: header.id,
        timestamp: header.timestamp,
        correlationId: header.correlationId,
        causationId: header.causationId,
        tenantId: header.tenantId,
        userId: header.userId,
        ipAddress: header.ipAddress,
        userAgent: header.userAgent,
        source: header.source
      }
    });
  }

  /**
   * Convenience helper that accepts a raw JSON string.
   *
   * @param {String} str
   * @returns {DomainEvent}
   */
  static parse(str) {
    const json = JSON.parse(str);
    return DomainEvent.fromJSON(json);
  }
}

/* ============================================================================
 * Event Implementations
 * ---------------------------------------------------------------------------
 * ONLY declare events specific to the Transactions bounded context.  Cross-cut
 * events (e.g., KYCPassed) belong to their respective services and should be
 * imported/listened to, not re-defined here.
 * ==========================================================================*/

/**
 * TransactionInitiated
 * Fired when a user attempts to create a brand-new payment / transfer.
 */
export class TransactionInitiated extends DomainEvent {
  static eventName = 'TransactionInitiated';
  static version = 1;
  static payloadSchema = {
    $id: 'TransactionInitiated@1',
    type: 'object',
    additionalProperties: false,
    required: [
      'transactionId',
      'initiatorUserId',
      'amount',
      'currency',
      'circleId',
      'description'
    ],
    properties: {
      transactionId: { type: 'string', minLength: 1 },
      initiatorUserId: { type: 'string', minLength: 1 },
      amount: { type: 'number', exclusiveMinimum: 0 },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      circleId: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1 },
      metadata: { type: 'object' }
    }
  };
}
register(TransactionInitiated);

/**
 * TransactionAuthorised
 * Raised after the payment provider / issuing bank authorises the transaction.
 */
export class TransactionAuthorised extends DomainEvent {
  static eventName = 'TransactionAuthorised';
  static version = 1;
  static payloadSchema = {
    $id: 'TransactionAuthorised@1',
    type: 'object',
    additionalProperties: false,
    required: ['transactionId', 'authorisedAt', 'authorisationCode'],
    properties: {
      transactionId: { type: 'string', minLength: 1 },
      authorisedAt: { type: 'string', format: 'date-time' },
      authorisationCode: { type: 'string', minLength: 1 }
    }
  };
}
register(TransactionAuthorised);

/**
 * TransactionCaptured
 * Funds have been successfully captured/settled from the payer's funding source.
 */
export class TransactionCaptured extends DomainEvent {
  static eventName = 'TransactionCaptured';
  static version = 1;
  static payloadSchema = {
    $id: 'TransactionCaptured@1',
    type: 'object',
    additionalProperties: false,
    required: ['transactionId', 'capturedAt', 'netAmount', 'fees'],
    properties: {
      transactionId: { type: 'string', minLength: 1 },
      capturedAt: { type: 'string', format: 'date-time' },
      netAmount: { type: 'number', minimum: 0 },
      fees: {
        type: 'object',
        additionalProperties: false,
        required: ['processing', 'network'],
        properties: {
          processing: { type: 'number', minimum: 0 },
          network: { type: 'number', minimum: 0 }
        }
      }
    }
  };
}
register(TransactionCaptured);

/**
 * TransactionFailed
 * Any unrecoverable failure (e.g., expired card, fraudulent attempt, etc.).
 */
export class TransactionFailed extends DomainEvent {
  static eventName = 'TransactionFailed';
  static version = 1;
  static payloadSchema = {
    $id: 'TransactionFailed@1',
    type: 'object',
    additionalProperties: false,
    required: ['transactionId', 'failedAt', 'reason', 'failureCode'],
    properties: {
      transactionId: { type: 'string', minLength: 1 },
      failedAt: { type: 'string', format: 'date-time' },
      reason: { type: 'string', minLength: 1 },
      failureCode: { type: 'string', minLength: 1 }
    }
  };
}
register(TransactionFailed);

/**
 * TransactionReversed
 * Raised when a captured transaction is reversed/refunded (partial or full).
 */
export class TransactionReversed extends DomainEvent {
  static eventName = 'TransactionReversed';
  static version = 1;
  static payloadSchema = {
    $id: 'TransactionReversed@1',
    type: 'object',
    additionalProperties: false,
    required: [
      'transactionId',
      'reversalId',
      'reversedAt',
      'amount',
      'currency',
      'initiator'
    ],
    properties: {
      transactionId: { type: 'string', minLength: 1 },
      reversalId: { type: 'string', minLength: 1 },
      reversedAt: { type: 'string', format: 'date-time' },
      amount: { type: 'number', exclusiveMinimum: 0 },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      initiator: { type: 'string', enum: ['user', 'system', 'chargeback'] }
    }
  };
}
register(TransactionReversed);

/* ============================================================================
 * Factory / Exports
 * ==========================================================================*/

/**
 * Factory to raise a new event by name.  Usage:
 *   createEvent('TransactionInitiated@1', {aggregateId, payload, meta})
 *
 * @param {String} descriptor – e.g., 'TransactionInitiated@1'
 * @param {Object} args – constructor arguments required by the event class
 * @returns {DomainEvent}
 */
export function createEvent(descriptor, args) {
  const [name, verStr] = descriptor.split('@');
  const ver = parseInt(verStr || '1', 10);
  const EventClass = resolve(name, ver);
  return new EventClass(args);
}

/**
 * Global hook for unit/integration tests to clear the registry.
 * Never to be used in production!
 */
export function __dangerous__resetRegistry() {
  _registry.clear();
}
```