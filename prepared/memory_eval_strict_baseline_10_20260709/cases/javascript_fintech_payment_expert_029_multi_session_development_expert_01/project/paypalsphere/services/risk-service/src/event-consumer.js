```javascript
/**
 *  event-consumer.js
 *  PayPalsphere :: Risk Service
 *
 *  Consumes domain events from the event bus, performs risk assessments,
 *  and publishes RiskAssessed events for downstream consumers.
 *
 *  Key design points:
 *  - Kafka (via kafkajs) as the event backbone
 *  - Ajv for runtime payload validation
 *  - Security-by-Design: input validation, defensive coding, structured logging
 *  - Graceful shutdown hooks & resiliency helpers
 */

'use strict';

/* ────────────────────────────────────────────────────────── Dependencies ───── */
const { Kafka, logLevel }         = require('kafkajs');
const Ajv                        = require('ajv');
const addFormats                 = require('ajv-formats');
const axios                      = require('axios').default;
const { v4: uuidv4 }             = require('uuid');
const winston                    = require('winston');

/* ──────────────────────────────────────────────────────────── Config ───────── */
const {
  KAFKA_BROKERS           = 'localhost:9092',
  KAFKA_CLIENT_ID         = 'risk-service',
  KAFKA_GROUP_ID          = 'risk-consumer-group',
  DOMAIN_EVENTS_TOPIC     = 'domain-events',
  RISK_EVENTS_TOPIC       = 'risk-events',
  RISK_ENGINE_BASE_URL    = 'http://risk-engine:8080/api/v1',
  NODE_ENV                = 'development',
  LOG_LEVEL               = 'info',
  MAX_RETRY_ATTEMPTS      = '5',
  RETRY_BACKOFF_MS        = '2000',
} = process.env;

/* ──────────────────────────────────────────────────────────── Logger ───────── */
const logger = winston.createLogger({
  level   : LOG_LEVEL,
  format  : winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'risk-service' },
  transports : [
    new winston.transports.Console({ silent: NODE_ENV === 'test' }),
  ],
});

/* ─────────────────────────────────────────────────────── JSON Schemas ─────── */
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const schemas = {
  PaymentInitiated: {
    $id       : 'PaymentInitiated',
    type      : 'object',
    required  : [
      'eventId',
      'type',
      'payload',
      'metadata',
      'timestamp',
    ],
    properties: {
      eventId  : { type: 'string', format: 'uuid' },
      type     : { const: 'PaymentInitiated' },
      timestamp: { type: 'string', format: 'date-time' },
      payload  : {
        type    : 'object',
        required: ['paymentId', 'amount', 'currency', 'originUserId', 'destUserId'],
        properties: {
          paymentId   : { type: 'string', format: 'uuid' },
          amount      : { type: 'number', minimum: 0 },
          currency    : { type: 'string', minLength: 3, maxLength: 3 },
          originUserId: { type: 'string', format: 'uuid' },
          destUserId  : { type: 'string', format: 'uuid' },
          note        : { type: 'string' },
        },
      },
      metadata : { type: 'object' },
    },
  },
  SettlementRequested: {
    $id       : 'SettlementRequested',
    type      : 'object',
    required  : ['eventId', 'type', 'payload', 'timestamp'],
    properties: {
      eventId  : { type: 'string', format: 'uuid' },
      type     : { const: 'SettlementRequested' },
      timestamp: { type: 'string', format: 'date-time' },
      payload  : {
        type    : 'object',
        required: ['settlementId', 'circleId', 'totalAmount', 'currency'],
        properties: {
          settlementId: { type: 'string', format: 'uuid' },
          circleId    : { type: 'string', format: 'uuid' },
          totalAmount : { type: 'number', minimum: 0 },
          currency    : { type: 'string', minLength: 3, maxLength: 3 },
        },
      },
      metadata : { type: 'object' },
    },
  },
};

/* Compile schemas once for performance */
const validators = Object.entries(schemas).reduce((acc, [k, schema]) => {
  acc[k] = ajv.compile(schema);
  return acc;
}, {});

/* ────────────────────────────────────────────────────────── Helpers ───────── */
const delay = ms => new Promise(res => setTimeout(res, ms));

/**
 * Invokes the internal Risk Engine to compute a risk score.
 * Throws on non-2xx response codes.
 */
async function computeRiskScore(eventType, payload, metadata) {
  const correlationId = metadata?.correlationId || uuidv4();

  const reqBody = {
    eventType,
    payload,
    metadata: {
      ...metadata,
      correlationId,
    },
  };

  const url = `${RISK_ENGINE_BASE_URL}/score`;

  logger.debug('Calling Risk Engine %s with correlationId=%s', url, correlationId);

  const response = await axios.post(url, reqBody, {
    timeout: 5_000,
    headers: { 'x-correlation-id': correlationId },
  });

  return response.data; // { score: Number, verdict: 'APPROVE' | 'REVIEW' | 'DECLINE' }
}

/* ────────────────────────────────────────────── Kafka Bootstrapping ───────── */
const kafka = new Kafka({
  clientId : KAFKA_CLIENT_ID,
  brokers  : KAFKA_BROKERS.split(','),
  logLevel : logLevel.ERROR, // minimize noise—handled by winston instead
});

/**
 * Creates and configures a Kafka consumer ready to process domain events.
 */
function createConsumer() {
  return kafka.consumer({ groupId: KAFKA_GROUP_ID });
}

/**
 * Creates and configures a Kafka producer for emitting RiskAssessed events.
 */
function createProducer() {
  return kafka.producer();
}

/* ──────────────────────────────────────────────────── Main Class ─────────── */
class EventConsumer {
  constructor() {
    this.consumer  = createConsumer();
    this.producer  = createProducer();
    this.running   = false;
    this.retryCtr  = 0;
  }

  async init() {
    await Promise.all([this.consumer.connect(), this.producer.connect()]);

    await this.consumer.subscribe({ topic: DOMAIN_EVENTS_TOPIC, fromBeginning: false });

    logger.info('Risk Service consumer subscribed to %s', DOMAIN_EVENTS_TOPIC);

    this.running = true;
  }

  async start() {
    await this.init();

    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        try {
          const event = JSON.parse(message.value.toString());
          await this.handleEvent(event);
          this.retryCtr = 0; // reset retry counter on success
        } catch (err) {
          await this.handleProcessingError(err, message);
        }
      },
    });

    /* Handle graceful shutdown */
    ['SIGTERM', 'SIGINT', 'SIGQUIT'].forEach(signal => {
      process.on(signal, async () => {
        try {
          logger.info('Received %s. Shutting down consumer gracefully…', signal);
          await this.consumer.stop();
          await this.consumer.disconnect();
          await this.producer.disconnect();
          process.exit(0);
        } catch (err) {
          logger.error('Error while shutting down %o', err);
          process.exit(1);
        }
      });
    });
  }

  /* ───────────────────────────────────────── Event Dispatcher ──────────── */
  async handleEvent(event) {
    const { type } = event;

    logger.debug('Received event of type=%s', type);

    if (!validators[type]) {
      logger.warn('No validator configured for event type=%s. Skipping.', type);
      return;
    }

    if (!validators[type](event)) {
      logger.warn('Validation failed for eventId=%s :: %o', event.eventId, validators[type].errors);
      return;
    }

    switch (type) {
      case 'PaymentInitiated':
      case 'SettlementRequested':
        await this.assessRisk(event);
        break;
      default:
        logger.debug('Handler not implemented for type=%s', type);
    }
  }

  /* ───────────────────────────────────────── Risk Assessment ───────────── */
  async assessRisk(event) {
    const { type, payload, metadata } = event;

    logger.info('Assessing risk for eventId=%s type=%s', event.eventId, type);

    const start = Date.now();

    let scoreResponse;
    try {
      scoreResponse = await computeRiskScore(type, payload, metadata);
    } catch (err) {
      logger.error('Risk Engine call failed %o', err);
      throw err; // bubble up to trigger retry
    }

    const latency = Date.now() - start;

    logger.info(
      'Risk assessed for eventId=%s verdict=%s score=%d latency=%dms',
      event.eventId,
      scoreResponse.verdict,
      scoreResponse.score,
      latency
    );

    const riskEvent = {
      eventId   : uuidv4(),
      type      : 'RiskAssessed',
      timestamp : new Date().toISOString(),
      payload   : {
        originalEventId: event.eventId,
        assessment     : scoreResponse,
      },
      metadata  : {
        correlationId: metadata?.correlationId || uuidv4(),
        source       : 'risk-service',
      },
    };

    await this.producer.send({
      topic: RISK_EVENTS_TOPIC,
      messages: [{ key: riskEvent.payload.originalEventId, value: JSON.stringify(riskEvent) }],
    });

    logger.debug('RiskAssessed event produced for originalEventId=%s', event.eventId);
  }

  /* ────────────────────────────────────────── Error Handling ───────────── */
  async handleProcessingError(err, message) {
    this.retryCtr += 1;
    const backoffMs = parseInt(RETRY_BACKOFF_MS, 10) * this.retryCtr;

    logger.error(
      'Error processing message at offset=%s partition=%s (attempt %d/%d) — %o',
      message.offset,
      message.partition,
      this.retryCtr,
      MAX_RETRY_ATTEMPTS,
      err
    );

    if (this.retryCtr >= parseInt(MAX_RETRY_ATTEMPTS, 10)) {
      logger.error('Max retry attempts reached. Skipping message.');
      this.retryCtr = 0;
      return;
    }

    logger.info('Backing off for %dms before retrying…', backoffMs);
    await delay(backoffMs);
  }
}

/* ─────────────────────────────────────────────────────────── Bootstrap ───── */
(async function bootstrap() {
  try {
    const consumer = new EventConsumer();
    await consumer.start();
  } catch (err) {
    logger.error('Fatal error in Risk Service consumer: %o', err);
    process.exit(1);
  }
})();
```