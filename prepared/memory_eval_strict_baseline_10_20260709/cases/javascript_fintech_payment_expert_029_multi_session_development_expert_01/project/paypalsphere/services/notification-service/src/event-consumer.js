```javascript
/**
 * PayPalsphere – Notification Service
 * -----------------------------------
 * event-consumer.js
 *
 * Consumes domain events published to Kafka and dispatches user–facing
 * notifications through the NotificationDispatcher. Implements exactly–
 * once processing semantics backed by Redis for idempotency guarantees
 * and exposes Prometheus metrics for observability.
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────── */
/* External Dependencies                                                      */
/* ────────────────────────────────────────────────────────────────────────── */
const { Kafka } = require('kafkajs');
const Redis = require('ioredis');
const winston = require('winston');
const { v4: uuid } = require('uuid');
const promClient = require('prom-client');
const config = require('config');

/* ────────────────────────────────────────────────────────────────────────── */
/* Internal Dependencies                                                      */
/* ────────────────────────────────────────────────────────────────────────── */
const NotificationDispatcher = require('./notification-dispatcher'); // Local module

/* ────────────────────────────────────────────────────────────────────────── */
/* Configuration                                                              */
/* ────────────────────────────────────────────────────────────────────────── */
const kafkaCfg = config.get('kafka');
const redisCfg = config.get('redis');
const consumerCfg = config.get('notificationConsumer');
const METRICS_PREFIX = 'notification_service_';

/* ────────────────────────────────────────────────────────────────────────── */
/* Logging                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Metrics                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */
const registry = new promClient.Registry();
registry.setDefaultLabels({ app: 'notification-service' });

const processedEventsCounter = new promClient.Counter({
  name: `${METRICS_PREFIX}processed_events_total`,
  help: 'Total number of successfully processed events',
  registers: [registry],
});

const processingErrorsCounter = new promClient.Counter({
  name: `${METRICS_PREFIX}processing_errors_total`,
  help: 'Total number of event processing errors',
  registers: [registry],
});

const processingLatencyHistogram = new promClient.Histogram({
  name: `${METRICS_PREFIX}processing_latency_seconds`,
  help: 'Event processing latency in seconds',
  buckets: [0.05, 0.1, 0.5, 1, 5, 10],
  registers: [registry],
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Event Consumer                                                             */
/* ────────────────────────────────────────────────────────────────────────── */
class EventConsumer {
  /**
   * @param {Object} options
   * @param {Kafka}  options.kafkaClient
   * @param {Redis}  options.redis
   * @param {NotificationDispatcher} options.dispatcher
   */
  constructor({ kafkaClient, redis, dispatcher }) {
    this.kafka = kafkaClient;
    this.consumer = this.kafka.consumer({
      groupId: consumerCfg.groupId || 'notification-svc',
    });
    this.redis = redis;
    this.dispatcher = dispatcher;
    this.running = false;

    // Map event types to concrete handler methods
    this.eventHandlers = new Map([
      ['PaymentInitiated', this.handlePaymentInitiated.bind(this)],
      ['SettlementRequested', this.handleSettlementRequested.bind(this)],
      ['KycVerificationPassed', this.handleKycVerificationPassed.bind(this)],
      // Extend as new domain events arise
    ]);
  }

  /**
   * Initialize and start consuming events.
   */
  async start() {
    logger.info('Starting Notification EventConsumer…');
    await this.consumer.connect();

    await this.consumer.subscribe({ topic: kafkaCfg.topics.payments, fromBeginning: false });
    await this.consumer.subscribe({ topic: kafkaCfg.topics.settlements, fromBeginning: false });
    await this.consumer.subscribe({ topic: kafkaCfg.topics.kyc, fromBeginning: false });

    this.running = true;

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        if (!this.running) return; // Graceful drain

        const endTimer = processingLatencyHistogram.startTimer();
        try {
          await this._processMessage(message);
          processedEventsCounter.inc();
        } catch (err) {
          processingErrorsCounter.inc();
          logger.error(
            'Failed to process message %s on %s:%s – %o',
            message.key,
            topic,
            partition,
            err
          );
        } finally {
          endTimer();
        }
      },
    });

    logger.info('Notification EventConsumer started.');
  }

  /**
   * Stop consuming events gracefully.
   */
  async stop() {
    this.running = false;
    logger.info('Stopping Notification EventConsumer…');
    try {
      await this.consumer.disconnect();
      await this.redis.quit();
    } catch (err) {
      logger.warn('Error during shutdown: %o', err);
    }
    logger.info('Notification EventConsumer stopped.');
  }

  /**
   * Process individual Kafka message.
   *
   * @param {import('kafkajs').KafkaMessage} message
   * @private
   */
  async _processMessage(message) {
    let envelope;
    try {
      envelope = JSON.parse(message.value.toString('utf8'));
    } catch (err) {
      throw new Error(`Malformed JSON in message: ${err.message}`);
    }

    const { eventId, type } = envelope;
    if (!eventId || !type) {
      throw new Error('Event envelope missing required fields (eventId/type).');
    }

    // Idempotency check – Set with TTL avoids unbounded growth
    const redisKey = `notifications:events:${eventId}`;
    const isDuplicate = !(await this.redis.set(redisKey, '1', 'NX', 'EX', redisCfg.idempotencyTtl));
    if (isDuplicate) {
      logger.debug('Skipping duplicate event %s (%s)', eventId, type);
      return;
    }

    const handler = this.eventHandlers.get(type);
    if (!handler) {
      logger.warn('No handler registered for event type "%s".', type);
      return;
    }

    await handler(envelope);
  }

  /* ─────────────────────────────────────────────────────────────────────── */
  /* Event Handlers                                                          */
  /* ─────────────────────────────────────────────────────────────────────── */

  /**
   * Handle PaymentInitiated domain event.
   *
   * @param {Object} envelope
   */
  async handlePaymentInitiated(envelope) {
    const { aggregateId, data, metadata } = envelope;
    const { payerId, payeeId, amount, currency } = data;

    const notification = {
      id: uuid(),
      type: 'PAYMENT_INITIATED',
      recipients: [payeeId],
      payload: {
        payerId,
        amount,
        currency,
        transactionId: aggregateId,
      },
      metadata,
    };

    await this.dispatcher.send(notification);
    logger.info('PaymentInitiated notification dispatched for txn %s.', aggregateId);
  }

  /**
   * Handle SettlementRequested domain event.
   *
   * @param {Object} envelope
   */
  async handleSettlementRequested(envelope) {
    const { aggregateId, data } = envelope;
    const { requesterId, circleId, amount, currency } = data;

    const recipients = await this._resolveCircleMembers(circleId, requesterId);

    const notification = {
      id: uuid(),
      type: 'SETTLEMENT_REQUESTED',
      recipients,
      payload: {
        circleId,
        requesterId,
        amount,
        currency,
        requestId: aggregateId,
      },
    };

    await this.dispatcher.send(notification);
    logger.info('SettlementRequested notification dispatched for request %s.', aggregateId);
  }

  /**
   * Handle KycVerificationPassed domain event.
   *
   * @param {Object} envelope
   */
  async handleKycVerificationPassed(envelope) {
    const { data } = envelope;
    const { userId } = data;

    const notification = {
      id: uuid(),
      type: 'KYC_VERIFICATION_PASSED',
      recipients: [userId],
      payload: {
        message: 'Your identity verification is complete. Welcome aboard!',
      },
    };

    await this.dispatcher.send(notification);
    logger.info('KycVerificationPassed notification dispatched for user %s.', userId);
  }

  /* ─────────────────────────────────────────────────────────────────────── */
  /* Helper Methods                                                          */
  /* ─────────────────────────────────────────────────────────────────────── */

  /**
   * Resolve active circle members for notification fan-out.
   * Placeholder implementation; in production, query Social Graph service.
   *
   * @param {string} circleId
   * @param {string} excludeUserId
   * @returns {Promise<string[]>} userIds
   * @private
   */
  async _resolveCircleMembers(circleId, excludeUserId) {
    // Stub; would normally call another micro-service
    return ['userA', 'userB', 'userC'].filter((id) => id !== excludeUserId);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Bootstrap                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */
async function bootstrap() {
  const kafka = new Kafka({
    clientId: kafkaCfg.clientId,
    brokers: kafkaCfg.brokers,
    connectionTimeout: 5_000,
  });

  const redis = new Redis(redisCfg);

  const dispatcher = new NotificationDispatcher({ logger });

  const consumer = new EventConsumer({ kafkaClient: kafka, redis, dispatcher });

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info('Received %s – initiating shutdown…', signal);
    await consumer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await consumer.start();
  } catch (err) {
    logger.error('Fatal error in bootstrap: %o', err);
    await shutdown('FATAL');
  }
}

bootstrap().catch((err) => {
  // Last-resort error handler
  logger.error('Unhandled bootstrap error: %o', err);
  process.exit(1);
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Metrics Endpoint (optional)                                               */
/* ────────────────────────────────────────────────────────────────────────── */
if (process.env.EXPOSE_METRICS === 'true') {
  const http = require('http');
  const PORT = process.env.METRICS_PORT || 9095;

  http
    .createServer(async (_req, res) => {
      res.setHeader('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    })
    .listen(PORT, () => logger.info('Metrics exposed on :%d/metrics', PORT));
}
```