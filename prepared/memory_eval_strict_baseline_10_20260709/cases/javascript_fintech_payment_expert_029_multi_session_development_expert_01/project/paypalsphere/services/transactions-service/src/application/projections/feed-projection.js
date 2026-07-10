```javascript
/**
 * PayPalsphere – Transactions Service
 * -----------------------------------
 * Feed Projection
 *
 * This projection listens to domain events published by the Transactions–,
 * SocialGraph– and Circle–bounded contexts and translates them into a
 * read-optimised “social feed” collection that can be queried by the
 * mobile- and web-clients in O(1) time.
 *
 *   – CQRS Read-Side Projection
 *   – MongoDB persistence (single collection, denormalised)
 *   – Idempotent & resilient (handles at-least-once delivery)
 *
 * NOTE: The eventBus used here must adhere to Node.js EventEmitter semantics.
 */

'use strict';

const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const { MongoClient } = require('mongodb');

/**
 * Valid domain-level event names that this projection cares about.
 * (Add more as the domain evolves).
 */
const EVENTS = Object.freeze({
  TRANSACTION_INITIATED: 'TransactionInitiated',
  TRANSACTION_SETTLED: 'TransactionSettled',
  COMMENT_ADDED: 'CommentAdded',
  REACTION_ADDED: 'ReactionAdded',
});

/**
 * MongoDB collection where the read-model is stored.
 */
const FEED_COLLECTION = 'circle_feed_items';

/**
 * A tiny wrapper around MongoDB that shields the projection from
 * infrastructural details and provides a small set of atomic operations.
 */
class FeedRepository {
  /**
   * @param {import('mongodb').Collection} collection
   */
  constructor(collection) {
    this._collection = collection;
  }

  /**
   * Inserts a brand-new feed item (idempotent on `eventId`).
   * If another worker already processed the same event, the unique index
   * on `eventId` guarantees deduplication.
   *
   * @param {Object} payload
   * @param {string} payload.eventId        – Domain event ID (for idempotency)
   * @param {string} payload.circleId
   * @param {string} payload.transactionId
   * @param {string} payload.actorId
   * @param {string} payload.type           – PAY | SETTLE | COMMENT | REACT
   * @param {Object} payload.content        – The “social” content of the post
   * @param {Date}   payload.occurredAt
   * @param {'PUBLIC'|'PRIVATE'} payload.privacy
   */
  async insertFeedItem(payload) {
    const doc = {
      _id: uuid(), // internal primary key
      ...payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this._collection.insertOne(doc, { writeConcern: { w: 'majority' } });
  }

  /**
   * Updates an existing feed item in an idempotent fashion by
   * appending to its timeline (e.g., settlement).
   *
   * @param {string} transactionId
   * @param {Object} patch
   */
  async updateFeedItem(transactionId, patch) {
    await this._collection.updateOne(
      { transactionId },
      {
        $set: {
          ...patch,
          updatedAt: new Date(),
        },
      },
      { upsert: false, writeConcern: { w: 'majority' } }
    );
  }

  /**
   * Ensure the collection has the proper indexes.
   */
  static async ensureIndexes(collection) {
    await collection.createIndex(
      { eventId: 1 },
      { unique: true, background: true, name: 'uq_event_id' }
    );
    await collection.createIndex(
      { circleId: 1, occurredAt: -1 },
      { background: true, name: 'idx_circle_timeline' }
    );
  }
}

/**
 * FeedProjection coordinates the subscription to the domain
 * event-bus and delegates persistence to FeedRepository.
 */
class FeedProjection {
  /**
   * @param {Object} deps
   * @param {EventEmitter} deps.eventBus
   * @param {MongoClient} deps.mongoClient
   * @param {import('pino').Logger} deps.logger
   */
  constructor({ eventBus, mongoClient, logger }) {
    if (!(eventBus instanceof EventEmitter))
      throw new TypeError('eventBus must be an EventEmitter');
    this._eventBus = eventBus;
    this._mongoClient = mongoClient;
    this._logger = logger.child({ context: 'FeedProjection' });
    this._handlers = new Map();
    this._isSubscribed = false;

    // Lazy-initialised in start()
    this._repository = null;
  }

  /**
   * Connect to MongoDB, prepare indexes and wire event handlers.
   */
  async start() {
    const db = this._mongoClient.db(); // default database
    const collection = db.collection(FEED_COLLECTION);

    // Create indexes (no-op if they already exist)
    await FeedRepository.ensureIndexes(collection);

    this._repository = new FeedRepository(collection);
    this._wireHandlers();
    this._logger.info('FeedProjection started and listening to events.');
  }

  /**
   * Unsubscribes all listeners – useful for graceful shutdown.
   */
  async stop() {
    if (!this._isSubscribed) return;

    for (const [evt, handler] of this._handlers.entries()) {
      this._eventBus.removeListener(evt, handler);
    }
    this._isSubscribed = false;
    this._logger.info('FeedProjection stopped.');
  }

  /**
   * Internal: registers listeners for every relevant domain event.
   */
  _wireHandlers() {
    this._attach(EVENTS.TRANSACTION_INITIATED, this._onTransactionInitiated.bind(this));
    this._attach(EVENTS.TRANSACTION_SETTLED, this._onTransactionSettled.bind(this));
    this._attach(EVENTS.COMMENT_ADDED, this._onCommentAdded.bind(this));
    this._attach(EVENTS.REACTION_ADDED, this._onReactionAdded.bind(this));

    this._isSubscribed = true;
  }

  /**
   * DRY utility to attach an event handler and remember it for later unsubscription.
   *
   * @param {string} eventName
   * @param {Function} handler
   */
  _attach(eventName, handler) {
    this._eventBus.on(eventName, handler);
    this._handlers.set(eventName, handler);
  }

  // ──────────────── Domain-event handlers ────────────────

  /**
   * Handler for “TransactionInitiated” – creates a brand-new feed item.
   *
   * @param {Object} evt
   * @param {string} evt.id
   * @param {string} evt.circleId
   * @param {string} evt.transactionId
   * @param {string} evt.payerId
   * @param {number} evt.amount
   * @param {string} evt.currency
   * @param {'PUBLIC'|'PRIVATE'} evt.privacy
   * @param {Date}   evt.occurredAt
   */
  async _onTransactionInitiated(evt) {
    try {
      await this._repository.insertFeedItem({
        eventId: evt.id,
        circleId: evt.circleId,
        transactionId: evt.transactionId,
        actorId: evt.payerId,
        type: 'PAYMENT',
        content: {
          amount: evt.amount,
          currency: evt.currency,
          status: 'PENDING',
        },
        occurredAt: evt.occurredAt,
        privacy: evt.privacy,
      });

      this._logger.debug(
        { txn: evt.transactionId, circle: evt.circleId, event: evt.id },
        'TransactionInitiated projected to feed.'
      );
    } catch (err) {
      // Ignore duplicate key errors (already processed)
      if (err.code === 11000) {
        this._logger.debug({ event: evt.id }, 'Duplicate TransactionInitiated ignored.');
        return;
      }
      this._logger.error({ err, event: evt.id }, 'Failed projecting TransactionInitiated.');
    }
  }

  /**
   * Handler for “TransactionSettled” – updates the existing feed item.
   *
   * @param {Object} evt
   * @param {string} evt.id
   * @param {string} evt.transactionId
   * @param {string} evt.settledBy
   * @param {Date}   evt.occurredAt
   */
  async _onTransactionSettled(evt) {
    try {
      await this._repository.updateFeedItem(evt.transactionId, {
        content: { status: 'SETTLED', settledBy: evt.settledBy },
        settledAt: evt.occurredAt,
      });
      this._logger.debug(
        { txn: evt.transactionId, event: evt.id },
        'TransactionSettled projected to feed.'
      );
    } catch (err) {
      this._logger.error({ err, event: evt.id }, 'Failed projecting TransactionSettled.');
    }
  }

  /**
   * Handler for “CommentAdded” – creates a commentary feed item.
   *
   * @param {Object} evt
   * @param {string} evt.id
   * @param {string} evt.commentId
   * @param {string} evt.transactionId
   * @param {string} evt.authorId
   * @param {string} evt.circleId
   * @param {string} evt.text
   * @param {Date}   evt.occurredAt
   * @param {'PUBLIC'|'PRIVATE'} evt.privacy
   */
  async _onCommentAdded(evt) {
    try {
      await this._repository.insertFeedItem({
        eventId: evt.id,
        circleId: evt.circleId,
        transactionId: evt.transactionId,
        actorId: evt.authorId,
        type: 'COMMENT',
        content: {
          commentId: evt.commentId,
          text: evt.text,
        },
        occurredAt: evt.occurredAt,
        privacy: evt.privacy,
      });
      this._logger.debug(
        { comment: evt.commentId, event: evt.id },
        'CommentAdded projected to feed.'
      );
    } catch (err) {
      if (err.code === 11000) {
        this._logger.debug({ event: evt.id }, 'Duplicate CommentAdded ignored.');
        return;
      }
      this._logger.error({ err, event: evt.id }, 'Failed projecting CommentAdded.');
    }
  }

  /**
   * Handler for “ReactionAdded” – creates a reactionary feed item.
   *
   * @param {Object} evt
   * @param {string} evt.id
   * @param {string} evt.reactionId
   * @param {string} evt.transactionId
   * @param {string} evt.reactorId
   * @param {string} evt.circleId
   * @param {string} evt.emoji
   * @param {Date}   evt.occurredAt
   * @param {'PUBLIC'|'PRIVATE'} evt.privacy
   */
  async _onReactionAdded(evt) {
    try {
      await this._repository.insertFeedItem({
        eventId: evt.id,
        circleId: evt.circleId,
        transactionId: evt.transactionId,
        actorId: evt.reactorId,
        type: 'REACTION',
        content: {
          reactionId: evt.reactionId,
          emoji: evt.emoji,
        },
        occurredAt: evt.occurredAt,
        privacy: evt.privacy,
      });
      this._logger.debug(
        { reaction: evt.reactionId, event: evt.id },
        'ReactionAdded projected to feed.'
      );
    } catch (err) {
      if (err.code === 11000) {
        this._logger.debug({ event: evt.id }, 'Duplicate ReactionAdded ignored.');
        return;
      }
      this._logger.error({ err, event: evt.id }, 'Failed projecting ReactionAdded.');
    }
  }
}

module.exports = {
  FeedProjection,
  FeedRepository, // Exported for integration tests
  EVENTS,
};
```