```javascript
/**
 * PayPalsphere - Social Graph Service
 * Domain Model: Reaction
 *
 * A Reaction is a lightweight domain object that represents a user's emotional
 * response to a timeline entry (a transaction, settlement request, etc.).
 * All mutations on a Reaction create immutable domain events that are later
 * persisted by the Event Store.  No I/O happens in this module—this is pure
 * domain logic.
 */

import { v4 as uuidv4 } from 'uuid';
import deepFreeze from 'deep-freeze'; // small utility to deep-freeze objects at runtime

// -----------------------------------------------------------------------------
// Constants & Enumerations
// -----------------------------------------------------------------------------

export const ReactionTypes = Object.freeze({
  LIKE:        'like',
  CELEBRATE:   'celebrate',
  LAUGH:       'laugh',
  THINKING:    'thinking',
  PRAYING:     'praying',
  ANGRY:       'angry',
  CONFETTI:    'confetti',
});

export const ReactionStatus = Object.freeze({
  ACTIVE:   'active',
  REMOVED:  'removed',
});

// -----------------------------------------------------------------------------
// Domain Events
// -----------------------------------------------------------------------------

/**
 * Base class for Domain Events.  Every event produced by the Reaction aggregate
 * should inherit from this class so it can be serialized/deserialized uniformly
 * by the Event Store.
 */
export class DomainEvent {
  constructor({ aggregateId, type, payload }) {
    /** @type {string} */
    this.eventId     = uuidv4();
    /** @type {string} */
    this.aggregateId = aggregateId;
    /** @type {string} */
    this.type        = type;          // e.g., 'ReactionCreated'
    /** @type {any} */
    this.payload     = payload;
    /** @type {string} ISO-8601 */
    this.occurredAt  = new Date().toISOString();
    deepFreeze(this);
  }
}

export class ReactionCreatedEvent extends DomainEvent {
  constructor({ aggregateId, payload }) {
    super({ aggregateId, type: 'ReactionCreated', payload });
  }
}

export class ReactionRemovedEvent extends DomainEvent {
  constructor({ aggregateId, payload }) {
    super({ aggregateId, type: 'ReactionRemoved', payload });
  }
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function assert(condition, message, { code } = {}) {
  if (!condition) {
    const err = new Error(message);
    err.code = code || 'DOMAIN_VALIDATION_ERROR';
    throw err;
  }
}

function validateReactionType(reactionType) {
  assert(
    Object.values(ReactionTypes).includes(reactionType),
    `Invalid reaction type "${reactionType}"`,
    { code: 'INVALID_REACTION_TYPE' }
  );
}

// -----------------------------------------------------------------------------
// Reaction Aggregate Root
// -----------------------------------------------------------------------------

/**
 * @typedef {Object} ReactionProps
 * @property {string} postId   - Timeline entry ID the reaction belongs to
 * @property {string} userId   - User who authored the reaction
 * @property {string} type     - One of ReactionTypes
 * @property {string} [id]     - Optional. If omitted, a new UUID will be generated
 * @property {string} [status] - 'active' or 'removed'
 * @property {string} [createdAt] - ISO-8601 timestamp
 */

/**
 * Aggregate Root: Reaction
 */
export class Reaction {
  /**
   * Factory method used for creating a brand-new Reaction from intent.
   * Will emit a ReactionCreated domain event.
   *
   * @param {ReactionProps} props
   * @returns {Reaction}
   */
  static create(props) {
    const instance = new Reaction({
      ...props,
      id: props.id || uuidv4(),
      status: ReactionStatus.ACTIVE,
      createdAt: props.createdAt || new Date().toISOString(),
    });

    instance.#addEvent(
      new ReactionCreatedEvent({
        aggregateId: instance.id,
        payload: instance.toJSON(),
      })
    );

    return instance;
  }

  /**
   * Re-hydrates a Reaction from a persisted snapshot—no domain events are
   * emitted because the aggregate is being reconstructed.
   *
   * @param {ReactionProps} snapshot
   * @returns {Reaction}
   */
  static rehydrate(snapshot) {
    return new Reaction(snapshot);
  }

  /** @type {string} */
  id;
  /** @type {string} */
  postId;
  /** @type {string} */
  userId;
  /** @type {string} */
  type;
  /** @type {string} */
  status;
  /** @type {string} ISO-8601 */
  createdAt;

  /** @type {DomainEvent[]} */
  #pendingEvents = [];

  /**
   * Direct constructor is private—use create() or rehydrate()
   * @param {ReactionProps} props
   * @private
   */
  constructor(props) {
    validateReactionType(props.type);
    assert(!!props.postId, 'postId is required', { code: 'MISSING_POST_ID' });
    assert(!!props.userId, 'userId is required', { code: 'MISSING_USER_ID' });

    this.id        = props.id;
    this.postId    = props.postId;
    this.userId    = props.userId;
    this.type      = props.type;
    this.status    = props.status;
    this.createdAt = props.createdAt;

    // Invariant: once constructed, the aggregate is immutable to caller.
    deepFreeze(this);
  }

  // ---------------------------------------------------------------------------
  // Domain Behavior
  // ---------------------------------------------------------------------------

  /**
   * Removes (soft-deletes) the reaction from the timeline.
   * Emits a ReactionRemoved domain event.
   */
  remove() {
    assert(
      this.status === ReactionStatus.ACTIVE,
      'Only active reactions can be removed',
      { code: 'INVALID_REACTION_STATE' }
    );

    // We can't mutate the current instance because it's frozen.
    const removedReaction = Reaction.rehydrate({
      ...this.toJSON(),
      status: ReactionStatus.REMOVED,
    });

    removedReaction.#addEvent(
      new ReactionRemovedEvent({
        aggregateId: removedReaction.id,
        payload: removedReaction.toJSON(),
      })
    );

    return removedReaction;
  }

  // ---------------------------------------------------------------------------
  // Event Utilities
  // ---------------------------------------------------------------------------

  /**
   * Returns pending domain events that have been raised since this aggregate
   * was created or re-hydrated.  Once pulled, the repository should clear them.
   */
  pullDomainEvents() {
    const events = [...this.#pendingEvents];
    this.#pendingEvents = [];
    return events;
  }

  /**
   * @param {DomainEvent} event
   * @private
   */
  #addEvent(event) {
    this.#pendingEvents.push(event);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Converts the aggregate into a plain JSON object suitable for snapshots
   * or API responses (no domain methods or event state).
   */
  toJSON() {
    return {
      id:        this.id,
      postId:    this.postId,
      userId:    this.userId,
      type:      this.type,
      status:    this.status,
      createdAt: this.createdAt,
    };
  }
}

// -----------------------------------------------------------------------------
// Module-level utils
// -----------------------------------------------------------------------------

/**
 * Convenience method used by application services for quickly validating
 * that a candidate reaction object conforms to the schema without creating
 * a full aggregate.
 *
 * @param {ReactionProps} props
 * @returns {boolean}
 */
export function isReactionPropsValid(props) {
  try {
    validateReactionType(props.type);
    assert(!!props.postId, 'postId missing');
    assert(!!props.userId, 'userId missing');
    return true;
  } catch {
    return false;
  }
}
```