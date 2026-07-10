```javascript
/**
 * Social-Graph Service — Event Consumer
 * -------------------------------------
 * Listens to the platform event-bus (Kafka) and mutates the Social-Graph
 * read-model (Neo4j) in response to domain events emitted by other bounded
 * contexts (Accounts, Circles, Transactions, etc.).
 *
 * Design notes:
 *   • At-least-once delivery semantics are assumed from Kafka.
 *   • Idempotent writes are delegated to the GraphRepository layer.
 *   • AJV is leveraged for schema validation / defensive programming.
 *   • A small retry strategy w/ exponential back-off shields against transient
 *     DB/network issues without blocking the consumer thread.
 *   • Metrics hooks (Prometheus) are plumbed in but can be wired up later.
 *
 * eslint-disable security/detect-non-literal-require, camelcase
 */

'use strict';

const { Kafka } = require('kafkajs');
const winston = require('winston');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats');
const retry = require('async-retry');

const GraphRepository = require('./repositories/graph-repository');
const NotificationProducer = require('./producers/notification-producer');
const { Counter, Histogram } = require('./observability/metrics'); // Prom-style metrics

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const {
  KAFKA_BROKERS = '',
  KAFKA_GROUP_ID = 'social-graph-consumer',
  GRAPH_DB_URI = '',
  GRAPH_DB_USER = '',
  GRAPH_DB_PASSWORD = '',
  NODE_ENV = 'development',
} = process.env;

if (!KAFKA_BROKERS) {
  throw new Error('KAFKA_BROKERS env var required');
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logger = winston.createLogger({
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// ---------------------------------------------------------------------------
// JSON Schemas
// ---------------------------------------------------------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const schemas = {
  USER_REGISTERED: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'USER_REGISTERED' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['user_id', 'display_name', 'tenant_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
          display_name: { type: 'string', minLength: 1 },
          avatar_url: { type: 'string', format: 'uri', nullable: true },
        },
      },
    },
  },

  CIRCLE_CREATED: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'CIRCLE_CREATED' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['circle_id', 'name', 'owner_id', 'tenant_id'],
        properties: {
          circle_id: { type: 'string', format: 'uuid' },
          owner_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
          name: { type: 'string', minLength: 1 },
          visibility: { type: 'string', enum: ['PRIVATE', 'PUBLIC'] },
        },
      },
    },
  },

  FRIEND_ADDED: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'FRIEND_ADDED' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['user_id', 'friend_id', 'tenant_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          friend_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
          mutual: { type: 'boolean', default: false },
        },
      },
    },
  },

  CIRCLE_MEMBER_ADDED: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'CIRCLE_MEMBER_ADDED' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['circle_id', 'member_id', 'role', 'tenant_id'],
        properties: {
          circle_id: { type: 'string', format: 'uuid' },
          member_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
          role: { type: 'string', enum: ['ADMIN', 'MEMBER'] },
        },
      },
    },
  },

  CIRCLE_MEMBER_LEFT: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'CIRCLE_MEMBER_LEFT' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['circle_id', 'member_id', 'tenant_id'],
        properties: {
          circle_id: { type: 'string', format: 'uuid' },
          member_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  },

  USER_DELETED: {
    type: 'object',
    required: ['event_id', 'event_type', 'payload', 'created_at'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      event_type: { const: 'USER_DELETED' },
      created_at: { type: 'string', format: 'date-time' },
      payload: {
        type: 'object',
        required: ['user_id', 'tenant_id'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          tenant_id: { type: 'string', format: 'uuid' },
        },
      },
    },
  },
};

const validators = Object.entries(schemas).reduce((map, [eventType, schema]) => {
  // Precompile for speed
  map[eventType] = ajv.compile(schema);
  return map;
}, {});

// ---------------------------------------------------------------------------
// Instrumentation helpers
// ---------------------------------------------------------------------------

const metrics = {
  eventsConsumed: new Counter('social_graph_events_consumed_total', 'Events processed by social graph consumer'),
  eventsFailed: new Counter('social_graph_events_failed_total', 'Events that failed during processing'),
  processingTime: new Histogram('social_graph_event_processing_seconds', 'Event processing latency', {
    buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 3, 5],
  }),
};

/**
 * Wraps an async function in a Histogram timer.
 */
function observeLatency(histogram, fn) {
  return async (...args) => {
    const endTimer = histogram.startTimer();
    try {
      return await fn(...args);
    } finally {
      endTimer();
    }
  };
}

// ---------------------------------------------------------------------------
// Consumer Class
// ---------------------------------------------------------------------------

class SocialGraphEventConsumer {
  /**
   * @param {Kafka} kafkaClient
   * @param {GraphRepository} graphRepo
   * @param {NotificationProducer} notificationProducer
   */
  constructor(kafkaClient, graphRepo, notificationProducer) {
    this.kafka = kafkaClient;
    this.consumer = null;
    this.graphRepo = graphRepo;
    this.notificationProducer = notificationProducer;
    this.topics = [
      { topic: 'accounts-stream', fromBeginning: false },
      { topic: 'circles-stream', fromBeginning: false },
      { topic: 'relationships-stream', fromBeginning: false },
    ];
  }

  /**
   * Starts the Kafka consumer loop.
   */
  async start() {
    this.consumer = this.kafka.consumer({ groupId: KAFKA_GROUP_ID });
    await this.consumer.connect();
    for (const t of this.topics) {
      await this.consumer.subscribe(t);
    }
    logger.info('Social-graph consumer subscribed to topics %o', this.topics.map((t) => t.topic));

    await this.consumer.run({
      // concurrency can be tuned according to partition count
      eachMessage: async ({ topic, partition, message }) => {
        await observeLatency(metrics.processingTime, this.#handleMessage.bind(this))(message, topic, partition);
      },
    });
  }

  /**
   * Shuts down the consumer gracefully.
   */
  async shutdown() {
    if (this.consumer) {
      await this.consumer.disconnect();
    }
    await this.graphRepo.close();
  }

  /**
   * Core message handler. Validates, routes, and mutates graph within a
   * transactional retry envelope.
   *
   * @private
   */
  async #handleMessage(message, topic, partition) {
    const raw = message.value.toString();
    let event;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      logger.warn('Skipping malformed message on %s/%d: %o', topic, partition, err);
      metrics.eventsFailed.inc();
      return;
    }

    const { event_type: eventType } = event;

    if (!validators[eventType]) {
      logger.debug('Ignoring unsupported event type "%s"', eventType);
      return; // Just ignore unknown events
    }

    if (!validators[eventType](event)) {
      logger.warn('Event failed schema validation: %o', validators[eventType].errors);
      metrics.eventsFailed.inc();
      return;
    }

    metrics.eventsConsumed.inc();
    try {
      await retry(
        async (bail, attempt) => {
          try {
            await this.#routeEvent(event);
          } catch (err) {
            if (err.transient === false) {
              // Non-retryable error, e.g. schema mismatch -> bail
              bail(err);
              return;
            }
            logger.warn(
              'Transient failure processing event %s (attempt %d/%d): %s',
              event.event_id,
              attempt,
              3,
              err.message
            );
            throw err; // Retry
          }
        },
        { retries: 2, factor: 2, minTimeout: 200, maxTimeout: 2000 }
      );
    } catch (err) {
      logger.error('Unrecoverable failure handling event %s: %s', event.event_id, err.stack || err);
      metrics.eventsFailed.inc();
      // Propagate to dead-letter queue?
      await this.notificationProducer.publishDeadLetter(event, err.message);
    }
  }

  /**
   * Dispatches the event to the concrete handler.
   *
   * @private
   */
  async #routeEvent(event) {
    switch (event.event_type) {
      case 'USER_REGISTERED':
        return this.#onUserRegistered(event);
      case 'USER_DELETED':
        return this.#onUserDeleted(event);
      case 'CIRCLE_CREATED':
        return this.#onCircleCreated(event);
      case 'CIRCLE_MEMBER_ADDED':
        return this.#onCircleMemberAdded(event);
      case 'CIRCLE_MEMBER_LEFT':
        return this.#onCircleMemberLeft(event);
      case 'FRIEND_ADDED':
        return this.#onFriendAdded(event);
      default:
        logger.debug('No handler registered for event %s', event.event_type);
        return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Event Handlers (private)
  // -------------------------------------------------------------------------

  async #onUserRegistered({ payload, created_at: createdAt, event_id: eventId }) {
    await this.graphRepo.createUserNode({
      userId: payload.user_id,
      displayName: payload.display_name,
      avatarUrl: payload.avatar_url || null,
      tenantId: payload.tenant_id,
      createdAt,
    });

    await this.notificationProducer.publish('SOCIAL_GRAPH.USER_ONBOARDED', {
      eventId,
      userId: payload.user_id,
      tenantId: payload.tenant_id,
      timestamp: createdAt,
    });
  }

  async #onUserDeleted({ payload, created_at: createdAt, event_id: eventId }) {
    await this.graphRepo.deleteUserNode({ userId: payload.user_id, tenantId: payload.tenant_id });
    await this.notificationProducer.publish('SOCIAL_GRAPH.USER_REMOVED', {
      eventId,
      userId: payload.user_id,
      tenantId: payload.tenant_id,
      timestamp: createdAt,
    });
  }

  async #onCircleCreated({ payload, created_at: createdAt, event_id: eventId }) {
    await this.graphRepo.createCircleNode({
      circleId: payload.circle_id,
      name: payload.name,
      ownerId: payload.owner_id,
      visibility: payload.visibility || 'PRIVATE',
      tenantId: payload.tenant_id,
      createdAt,
    });

    // Add owner as member (ADMIN)
    await this.graphRepo.addMemberToCircle({
      circleId: payload.circle_id,
      memberId: payload.owner_id,
      role: 'ADMIN',
      joinedAt: createdAt,
      tenantId: payload.tenant_id,
    });

    await this.notificationProducer.publish('SOCIAL_GRAPH.CIRCLE_CREATED', {
      eventId,
      circleId: payload.circle_id,
      tenantId: payload.tenant_id,
      timestamp: createdAt,
    });
  }

  async #onCircleMemberAdded({ payload, created_at: createdAt }) {
    await this.graphRepo.addMemberToCircle({
      circleId: payload.circle_id,
      memberId: payload.member_id,
      role: payload.role || 'MEMBER',
      joinedAt: createdAt,
      tenantId: payload.tenant_id,
    });
  }

  async #onCircleMemberLeft({ payload }) {
    await this.graphRepo.removeMemberFromCircle({
      circleId: payload.circle_id,
      memberId: payload.member_id,
      tenantId: payload.tenant_id,
    });
  }

  async #onFriendAdded({ payload, created_at: createdAt }) {
    await this.graphRepo.addFriendshipEdge({
      userA: payload.user_id,
      userB: payload.friend_id,
      mutual: payload.mutual || false,
      connectedAt: createdAt,
      tenantId: payload.tenant_id,
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

(async () => {
  const kafka = new Kafka({
    clientId: 'social-graph-service',
    brokers: KAFKA_BROKERS.split(',').map((b) => b.trim()),
    connectionTimeout: 3000,
    ssl: NODE_ENV === 'production', // Assumes mTLS offloaded elsewhere
  });

  const graphRepo = new GraphRepository({
    uri: GRAPH_DB_URI,
    user: GRAPH_DB_USER,
    password: GRAPH_DB_PASSWORD,
    logger,
  });

  const notificationProducer = new NotificationProducer(kafka, logger);

  const consumer = new SocialGraphEventConsumer(kafka, graphRepo, notificationProducer);

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down consumer');
    await consumer.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down consumer');
    await consumer.shutdown();
    process.exit(0);
  });

  try {
    await consumer.start();
    logger.info('Social-graph event consumer started');
  } catch (err) {
    logger.error('Fatal error starting consumer: %s', err.stack || err);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
})();
```