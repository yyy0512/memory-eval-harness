```javascript
/**
 * PayPalsphere – Accounts Service
 * Domain Aggregate: Circle
 *
 * A Circle represents a social group of accounts that can share
 * expenses and track financial commitments together.
 *
 * The aggregate is implemented using Event-Sourcing semantics:
 *  – Every state transition is represented as an immutable Event.
 *  – Events are stored by the persistence layer (left to an adapter).
 *  – The aggregate keeps an in-memory list of uncommitted events
 *    that an application service can persist and publish.
 *
 * NOTE: This module purposefully contains no IO concerns.
 *       Persistence, message-bus publishing, and saga orchestration
 *       live in separate layers by design (hexagonal architecture).
 */

import { v4 as uuidv4 } from 'uuid';
import EventEmitter from 'events';

/* ------------------------------------------------------------------ */
/* Utility & Error Types                                              */
/* ------------------------------------------------------------------ */

/**
 * DomainError
 * Thrown when a business invariant is violated.
 */
export class DomainError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.name     = 'DomainError';
    this.data     = data;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * @enum {string}
 * Circle status lifecycle
 */
export const CircleStatus = Object.freeze({
  ACTIVE : 'ACTIVE',
  CLOSED : 'CLOSED',
});

/* ------------------------------------------------------------------ */
/* Domain Events                                                      */
/* ------------------------------------------------------------------ */

/**
 * Base class to provide structural consistency for domain events.
 */
class DomainEvent {
  constructor(type, payload) {
    this.eventId   = uuidv4();
    this.type      = type;
    this.occurredAt = new Date().toISOString();
    this.payload   = payload;
  }
}

export const Events = Object.freeze({
  CircleCreated   : 'accounts.circle.created',
  MemberAdded     : 'accounts.circle.member_added',
  MemberRemoved   : 'accounts.circle.member_removed',
  CircleRenamed   : 'accounts.circle.renamed',
  CircleClosed    : 'accounts.circle.closed',
  ExpenseRecorded : 'accounts.circle.expense_recorded',
});

/* ------------------------------------------------------------------ */
/* Aggregate: Circle                                                  */
/* ------------------------------------------------------------------ */

export default class Circle extends EventEmitter {

  /**
   * Rehydrates a Circle aggregate by replaying historic events.
   * @param {Array<Object>} events – raw event objects from store.
   * @returns {Circle}
   */
  static rehydrate(events = []) {
    if (!Array.isArray(events) || events.length === 0) {
      throw new DomainError('Cannot rehydrate Circle: events array empty');
    }

    const [first] = events;
    const circle = new Circle(first.payload.circleId, /* reconstruction */ true);

    events.forEach(evt => circle._apply(evt, /* isReplaying= */ true));
    circle._uncommittedEvents = []; // Ensure fresh state
    return circle;
  }

  /**
   * Factory method to create a brand-new Circle.
   * @param {Object}   attributes
   * @param {string}   attributes.name      – Human friendly label.
   * @param {string}   attributes.ownerId   – The creating account UUID.
   * @param {string[]} [attributes.members] – Optional initial members.
   */
  static create({ name, ownerId, members = [] }) {
    if (!name || !ownerId) {
      throw new DomainError('Both name and ownerId must be provided');
    }

    const circle = new Circle(uuidv4(), /* reconstruction */ false);
    const uniqueMembers = Array.from(new Set([ownerId, ...members]));

    circle._record(new DomainEvent(Events.CircleCreated, {
      circleId : circle.id,
      name,
      ownerId,
      members   : uniqueMembers,
    }));

    return circle;
  }

  /* --------------------
   * Constructor (private)
   * -------------------- */
  constructor(id, reconstruction = false) {
    super();
    this.id        = id;
    this.name      = null;
    this.ownerId   = null;
    this.members   = new Set();   // contains account UUIDs
    this.status    = CircleStatus.ACTIVE;
    this.expenses  = [];          // simplistic placeholder
    this.version   = 0;           // incremented per event
    this._uncommittedEvents = [];

    // When replaying history, we do not emit events.
    this._isRebuilding = reconstruction;
  }

  /* ---------------------------------------------------------------- */
  /* Public Domain Behaviour                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Add a new member to the circle.
   * @param {string} accountId
   */
  addMember(accountId) {
    this._ensureActive();
    if (this.members.has(accountId)) {
      throw new DomainError('Member already part of the circle', { accountId });
    }

    this._record(new DomainEvent(Events.MemberAdded, {
      circleId : this.id,
      accountId,
    }));
  }

  /**
   * Remove an existing member from the circle.
   * @param {string} accountId
   */
  removeMember(accountId) {
    this._ensureActive();
    if (!this.members.has(accountId)) {
      throw new DomainError('Member not found in the circle', { accountId });
    }
    if (accountId === this.ownerId) {
      throw new DomainError('Cannot remove circle owner', { accountId });
    }

    this._record(new DomainEvent(Events.MemberRemoved, {
      circleId : this.id,
      accountId,
    }));
  }

  /**
   * Rename the circle.
   * @param {string} newName
   */
  rename(newName) {
    this._ensureActive();
    if (!newName || newName.trim() === '') {
      throw new DomainError('Circle name cannot be empty');
    }
    if (newName === this.name) { return; }

    this._record(new DomainEvent(Events.CircleRenamed, {
      circleId : this.id,
      newName  : newName.trim(),
    }));
  }

  /**
   * Close the circle – no further member or expense changes allowed.
   * Idempotent operation.
   */
  close() {
    if (this.status === CircleStatus.CLOSED) { return; }

    this._record(new DomainEvent(Events.CircleClosed, {
      circleId : this.id,
    }));
  }

  /**
   * Record a new expense within the circle.  Real implementation lives
   * in Transactions BC – here we store only the reference for timeline.
   * @param {Object} expense
   * @param {string} expense.expenseId    – UUID from Transactions service
   * @param {string} expense.initiatorId  – Account ID creating the expense
   * @param {number} expense.amount       – Monetary value in minor units
   * @param {string} expense.currency     – ISO-4217 currency
   * @param {string} expense.description
   */
  recordExpense({ expenseId, initiatorId, amount, currency, description }) {
    this._ensureActive();

    // Basic schema validation (real service would do more thorough checks)
    if (!expenseId || !initiatorId || !amount || !currency) {
      throw new DomainError('Invalid expense payload');
    }
    if (!this.members.has(initiatorId)) {
      throw new DomainError('Initiator must be a circle member');
    }

    this._record(new DomainEvent(Events.ExpenseRecorded, {
      circleId   : this.id,
      expenseId,
      initiatorId,
      amount,
      currency,
      description,
    }));
  }

  /**
   * Return and optionally clear uncommitted domain events.
   * Application service should call after persisting them.
   * @param {boolean} [shouldClear=true]
   * @returns {Array<Object>}
   */
  pullUncommittedEvents(shouldClear = true) {
    const events = [...this._uncommittedEvents];
    if (shouldClear) this._uncommittedEvents = [];
    return events;
  }

  /* ---------------------------------------------------------------- */
  /* Private Helpers                                                  */
  /* ---------------------------------------------------------------- */

  _ensureActive() {
    if (this.status !== CircleStatus.ACTIVE) {
      throw new DomainError('Circle is closed');
    }
  }

  /**
   * Registers (and emits) a new domain event, then mutates state.
   * @param {DomainEvent} event
   * @private
   */
  _record(event) {
    this._apply(event, /* isReplaying= */ false);
    this._uncommittedEvents.push(event);

    // Notify subscribers only when not rebuilding
    if (!this._isRebuilding) {
      this.emit('domainEvent', event);
    }
  }

  /**
   * Mutates aggregate state based on an event. Internal use only.
   * @param {DomainEvent} event
   * @param {boolean} isReplaying
   * @private
   */
  _apply(event, isReplaying) {
    const { type, payload } = event;

    // State transition handlers
    switch (type) {
      case Events.CircleCreated: {
        this.name     = payload.name;
        this.ownerId  = payload.ownerId;
        payload.members.forEach(m => this.members.add(m));
        break;
      }

      case Events.MemberAdded:
        this.members.add(payload.accountId);
        break;

      case Events.MemberRemoved:
        this.members.delete(payload.accountId);
        break;

      case Events.CircleRenamed:
        this.name = payload.newName;
        break;

      case Events.CircleClosed:
        this.status = CircleStatus.CLOSED;
        break;

      case Events.ExpenseRecorded:
        this.expenses.push({
          expenseId   : payload.expenseId,
          initiatorId : payload.initiatorId,
          amount      : payload.amount,
          currency    : payload.currency,
          description : payload.description,
        });
        break;

      // In production, default should never occur due to exhaustive mapping
      default:
        throw new DomainError(`Unhandled event type: ${type}`);
    }

    // Version increments for both replaying and runtime events
    if (!isReplaying) {
      this.version += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* EventEmitter Typings                                               */
/* ------------------------------------------------------------------ */

/**
 * @typedef {Object} Circle#domainEvent
 * @property {DomainEvent} event – Emitted whenever a new domain event occurs.
 *
 * Example:
 *   circle.on('domainEvent', evt => bus.publish(evt.type, evt));
 */
```