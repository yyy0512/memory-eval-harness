```javascript
/**
 * PayPalsphere ‑ Accounts Service
 * --------------------------------
 * Event Consumer
 *
 * Listens to immutable domain events emitted on the Kafka bus and updates the
 * Accounts read-model while orchestrating side-effects (e.g. triggering KYC,
 * updating risk scores, emitting compensating commands for sagas, etc.).
 *
 * Design notes:
 *   • Security-by-Design: all event payloads are validated against an allow-list
 *     of Zod schemas before processing.
 *   • Observability: Pino for structured logs, Prom-client for metrics,
 *     OpenTelemetry for tracing (optional).
 *   • Resilience: automatic retry with exponential back-off; poison messages are
 *     shunted to a dead-letter topic for later inspection.
 */

'use strict';

const { Kafka, logLevel } = require('kafkajs');
const { randomUUID }            = require('crypto');
const z                         = require('zod');
const logger                    = require('./utils/logger');
const metrics                   = require('./utils/metrics');
const tracer                    = require('./utils/tracer');
const accountRepository         = require('./repositories/account-repository');
const { publishToTopic }        = require('./utils/kafka-producer');

// ───────────────────────────────────────────────────────────────────────────────
// Environment & Configuration
// ───────────────────────────────────────────────────────────────────────────────
const {
  KAFKA_BROKERS             = 'localhost:9092',
  KAFKA_CLIENT_ID           = 'paypalsphere-accounts',
  KAFKA_GROUP_ID            = 'accounts-service-consumer',
  DOMAIN_EVENTS_TOPIC       = 'paypalsphere.domain.events',
  DLQ_TOPIC                 = 'paypalsphere.dlq',
  MAX_PROCESSING_RETRIES    = '5',
} = process.env;

const kafka = new Kafka({
  clientId : KAFKA_CLIENT_ID,
  brokers  : KAFKA_BROKERS.split(','),
  logLevel : logLevel.ERROR,
});

// ───────────────────────────────────────────────────────────────────────────────
// Zod Schemas for Event Validation
// ───────────────────────────────────────────────────────────────────────────────
const schemas = {
  AccountCreated: z.object({
    accountId   : z.string().uuid(),
    userId      : z.string().uuid(),
    email       : z.string().email(),
    createdAt   : z.string().datetime(),
    metadata    : z.record(z.any()).optional(),
  }),

  KYCVerificationCompleted: z.object({
    accountId: z.string().uuid(),
    status   : z.enum(['PASSED', 'FAILED']),
    reason   : z.string().optional(),
    checkedAt: z.string().datetime(),
  }),

  RiskAssessmentFlagged: z.object({
    accountId : z.string().uuid(),
    score     : z.number().min(0).max(100),
    flaggedAt : z.string().datetime(),
    attributes: z.record(z.any()).optional(),
  }),
};

// ───────────────────────────────────────────────────────────────────────────────
// Event Dispatcher
// ───────────────────────────────────────────────────────────────────────────────
/** @type {Record<string,(payload: any, headers: any)=>Promise<void>>} */
const handlers = {
  AccountCreated: async (payload) => {
    await accountRepository.create({
      id        : payload.accountId,
      userId    : payload.userId,
      email     : payload.email,
      createdAt : payload.createdAt,
      metadata  : payload.metadata ?? {},
      status    : 'PENDING_KYC',
    });

    metrics.accountsCreated.inc();
  },

  KYCVerificationCompleted: async (payload) => {
    await accountRepository.updateStatus(
      payload.accountId,
      payload.status === 'PASSED' ? 'ACTIVE' : 'KYC_FAILED',
      { kycCheckedAt: payload.checkedAt, kycReason: payload.reason }
    );

    metrics.kycProcessed.inc({ status: payload.status });
  },

  RiskAssessmentFlagged: async (payload) => {
    await accountRepository.markAsHighRisk(payload.accountId, {
      score      : payload.score,
      flaggedAt  : payload.flaggedAt,
      attributes : payload.attributes,
    });

    metrics.riskFlagged.inc();
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// Utility: Validate and Parse Incoming Message
// ───────────────────────────────────────────────────────────────────────────────
function parseMessage(message) {
  const raw         = message.value.toString('utf8');
  const { eventName, data } = JSON.parse(raw);

  if (!schemas[eventName]) {
    throw new Error(`Unsupported event '${eventName}'`);
  }

  const parseResult = schemas[eventName].safeParse(data);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Validation failed for event '${eventName}': ${issues}`);
  }

  return { eventName, data: parseResult.data };
}

// ───────────────────────────────────────────────────────────────────────────────
// Main Consumer Loop
// ───────────────────────────────────────────────────────────────────────────────
const consumer = kafka.consumer({ groupId: KAFKA_GROUP_ID });

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topic: DOMAIN_EVENTS_TOPIC, fromBeginning: false });

  logger.info({ topic: DOMAIN_EVENTS_TOPIC }, 'Consumer connected & subscribed.');

  await consumer.run({
    autoCommit: false,

    eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
      const span = tracer.startSpan('accounts.event.process', {
        attributes: {
          'messaging.system'    : 'kafka',
          'messaging.kafka.topic': topic,
        },
      });

      const headers = Object.fromEntries(
        Object.entries(message.headers || {}).map(([k, v]) => [k, v.toString()])
      );

      // Each event gets a correlation id for traceability
      const correlationId = headers['correlation-id'] || randomUUID();

      try {
        const { eventName, data } = parseMessage(message);

        logger.info(
          { eventName, partition, offset: message.offset, correlationId },
          'Received domain event.'
        );

        // Process the event
        await retryableHandler(eventName, data, headers);

        // Commit offset only when processing succeeded
        await consumer.commitOffsets([
          { topic, partition, offset: (Number(message.offset) + 1).toString() },
        ]);

        span.setStatus({ code: 1 }); // OK
      } catch (err) {
        span.recordException(err);

        logger.error(
          { err, offset: message.offset, headers },
          'Failed to process message.'
        );

        await handlePoisonMessage(message);
      } finally {
        span.end();
        await heartbeat(); // keep consumer session alive
      }
    },
  });
}

/**
 * Retry wrapper with exponential back-off.
 */
async function retryableHandler(eventName, payload, headers) {
  const handler = handlers[eventName];

  if (!handler) {
    throw new Error(`No handler registered for '${eventName}'.`);
  }

  const maxRetries = Number(MAX_PROCESSING_RETRIES);
  let attempt      = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      metrics.eventProcessingAttempts.inc({ event: eventName });
      await handler(payload, headers);
      metrics.eventProcessed.inc({ event: eventName });
      return;
    } catch (err) {
      attempt += 1;
      metrics.eventProcessingFailures.inc({ event: eventName });

      if (attempt > maxRetries) {
        throw err;
      }

      // Exponential back-off (e.g. 2^n * 100ms)
      const delay = 2 ** attempt * 100;
      logger.warn(
        { attempt, delay, eventName, err },
        'Retrying event processing after transient failure.'
      );
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

/**
 * Push malformed/unprocessable messages to Dead-Letter Queue to unblock the
 * consumer flow while retaining evidence for later inspection.
 */
async function handlePoisonMessage(message) {
  try {
    await publishToTopic(DLQ_TOPIC, {
      value: message.value,
      headers: {
        ...message.headers,
        'x-original-topic'    : message.topic,
        'x-original-partition': String(message.partition),
        'x-original-offset'   : String(message.offset),
      },
    });

    // Commit offset so we don't get stuck
    await consumer.commitOffsets([
      { topic: message.topic, partition: message.partition, offset: (Number(message.offset) + 1).toString() },
    ]);

    metrics.dlqMessages.inc();
  } catch (err) {
    logger.fatal({ err }, 'Failed to write to DLQ. Halting consumer to prevent data loss.');
    // In production you may trigger alerting or circuit breaker here
    process.exit(1);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ───────────────────────────────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down consumer …');
  try {
    await consumer.disconnect();
    logger.info('Consumer disconnected.');
  } catch (err) {
    logger.error({ err }, 'Error during Kafka disconnect.');
  } finally {
    process.exit(0);
  }
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => {
  process.on(sig, () => shutdown(sig));
});

// ───────────────────────────────────────────────────────────────────────────────
// Kick-off
// ───────────────────────────────────────────────────────────────────────────────
start()
  .catch(err => {
    logger.fatal({ err }, 'Unable to start Accounts event consumer. Bailing out.');
    process.exit(1);
  });

/* -------------------------------------------------------------------------- */
/* Metrics Registration (Prom-client)                                         */
/* -------------------------------------------------------------------------- */
metrics.eventProcessingAttempts = metrics.counter('accounts_event_attempts_total', 'Total attempts to process events', ['event']);
metrics.eventProcessed         = metrics.counter('accounts_event_processed_total', 'Total successfully processed events', ['event']);
metrics.eventProcessingFailures = metrics.counter('accounts_event_failures_total', 'Total failed events per event name', ['event']);
metrics.accountsCreated        = metrics.counter('accounts_created_total', 'Number of accounts created');
metrics.kycProcessed           = metrics.counter('kyc_processed_total', 'Number of KYC verification events processed', ['status']);
metrics.riskFlagged            = metrics.counter('risk_flagged_total', 'Number of risk assessment flagged events');
metrics.dlqMessages            = metrics.counter('dlq_messages_total', 'Number of messages relocated to Dead-Letter Queue');
```