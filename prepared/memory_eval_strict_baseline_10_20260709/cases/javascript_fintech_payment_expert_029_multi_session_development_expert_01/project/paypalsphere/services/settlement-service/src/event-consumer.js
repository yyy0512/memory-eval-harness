```javascript
'use strict';

/**
 * event-consumer.js
 *
 * Settlement Service – Event Consumer
 *
 * Consumes domain events from the settlement-events topic,
 * routes them to the appropriate domain logic, and publishes
 * audit/dead-letter messages when necessary.
 *
 * Design notes:
 *  • Kafka is used as the event backbone (kafkajs).
 *  • Ajv performs strict schema validation.
 *  • Winston centralises structured logging.
 *  • Crypto utilities decrypt field-level encrypted payloads.
 *  • All outgoing messages (audit or DLQ) contain the original
 *    correlationId to maintain traceability across services.
 */

const { Kafka, logLevel }   = require('kafkajs');
const { v4: uuid }          = require('uuid');
const winston               = require('winston');
const Ajv                   = require('ajv').default;
const addFormats            = require('ajv-formats');
const crypto                = require('crypto');
const { Pool }              = require('pg');
const _pick                 = require('lodash/pick');

// -----------------------------------------------------------------------------
// Environment
// -----------------------------------------------------------------------------
const {
  KAFKA_BROKERS                = 'localhost:9092',
  KAFKA_SSL_ENABLE             = 'false',
  KAFKA_SASL_MECHANISM,
  KAFKA_SASL_USERNAME,
  KAFKA_SASL_PASSWORD,

  KAFKA_SETTLEMENT_EVENTS_TOPIC = 'settlement.events',
  KAFKA_AUDIT_TRAIL_TOPIC       = 'audit.trail',
  KAFKA_DLQ_TOPIC               = 'dead.letter',

  SERVICE_ID                   = 'settlement-service',
  POSTGRES_URL                 = 'postgresql://postgres:postgres@localhost:5432/paypalsphere',
  ENCRYPTION_MASTER_KEY        = 'PLEASE_OVERRIDE_WITH_32_BYTE_BASE64==',
  NODE_ENV                     = 'development'
} = process.env;


// -----------------------------------------------------------------------------
// Logger
// -----------------------------------------------------------------------------
const logger = winston.createLogger({
  level   : NODE_ENV === 'production' ? 'info' : 'debug',
  format  : winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports : [
    new winston.transports.Console({ stderrLevels: ['error'] })
  ],
});


// -----------------------------------------------------------------------------
// Kafka client
// -----------------------------------------------------------------------------
const kafka = new Kafka({
  clientId : SERVICE_ID,
  brokers  : KAFKA_BROKERS.split(','),
  logLevel : logLevel.NOTHING, // winston handles logging
  ssl      : KAFKA_SSL_ENABLE === 'true' ? {} : undefined,
  sasl     : KAFKA_SASL_MECHANISM ? {
    mechanism : KAFKA_SASL_MECHANISM,
    username  : KAFKA_SASL_USERNAME,
    password  : KAFKA_SASL_PASSWORD
  } : undefined
});

const consumer = kafka.consumer({ groupId: `${SERVICE_ID}-consumer` });
const producer = kafka.producer();


// -----------------------------------------------------------------------------
// Ajv – Event schema validation
// -----------------------------------------------------------------------------
const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const eventSchemas = {
  'SETTLEMENT_REQUESTED': {
    type       : 'object',
    required   : ['type', 'payload', 'meta'],
    properties : {
      type : { const: 'SETTLEMENT_REQUESTED' },
      payload : {
        type       : 'object',
        required   : ['settlementId', 'initiatorUserId', 'amount', 'currency'],
        properties : {
          settlementId     : { type: 'string', format: 'uuid' },
          initiatorUserId  : { type: 'string', format: 'uuid' },
          amount           : { type: 'number', minimum: 0 },
          currency         : { type: 'string', minLength: 3, maxLength: 3 },
          encrypted        : { type: 'boolean' }
        },
        additionalProperties : true
      },
      meta : {
        type       : 'object',
        required   : ['correlationId', 'timestamp'],
        properties : {
          correlationId : { type: 'string', format: 'uuid' },
          timestamp     : { type: 'string', format: 'date-time' }
        },
        additionalProperties : true
      }
    },
    additionalProperties : false
  },
  'SETTLEMENT_FUNDS_CAPTURED': {
    // … identical structural definition, omitted for brevity
  },
  'RISK_ASSESSMENT_COMPLETED': {
    // … identical structural definition, omitted for brevity
  }
};

// Pre-compile validators for performance
const validators = Object.entries(eventSchemas)
  .reduce((acc, [key, schema]) => {
    acc[key] = ajv.compile(schema);
    return acc;
  }, {});


// -----------------------------------------------------------------------------
// Crypto utilities – AES-256-GCM wrapper
// -----------------------------------------------------------------------------
const ENCRYPTION_KEY = Buffer.from(ENCRYPTION_MASTER_KEY, 'base64');
if (ENCRYPTION_KEY.length !== 32) {
  logger.warn(
    'Encryption key is not 32 bytes – check ENCRYPTION_MASTER_KEY environment variable.'
  );
}

/**
 * Decrypts a base64 encoded, AES-256-GCM encrypted payload.
 * Expected JSON shape:
 * { iv: 'base64', authTag: 'base64', cipherText: 'base64' }
 */
function decryptPayload (encrypted) {
  const { iv, authTag, cipherText } = encrypted;
  const ivBuf        = Buffer.from(iv, 'base64');
  const tagBuf       = Buffer.from(authTag, 'base64');
  const cipherBuf    = Buffer.from(cipherText, 'base64');
  const decipher     = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, ivBuf);

  decipher.setAuthTag(tagBuf);
  const decrypted = Buffer.concat([ decipher.update(cipherBuf), decipher.final() ]);
  return JSON.parse(decrypted.toString('utf8'));
}


// -----------------------------------------------------------------------------
// Postgres – simple connection pool
// -----------------------------------------------------------------------------
const dbPool = new Pool({ connectionString: POSTGRES_URL });


// -----------------------------------------------------------------------------
// Domain layer (simplified)
// -----------------------------------------------------------------------------
class SettlementDomainService {
  /**
   * @param {Pool} db – Postgres connection pool
   */
  constructor (db) {
    this.db = db;
  }

  /**
   * Creates a settlement draft and triggers downstream saga orchestration.
   */
  async initiateSettlement ({ settlementId, initiatorUserId, amount, currency }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO settlements (id, initiator_user_id, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5)`,
        [settlementId, initiatorUserId, amount, currency, 'PENDING_CAPTURE']
      );
      await client.query('COMMIT');
      logger.info('Settlement draft persisted', { settlementId });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to initiate settlement', { err, settlementId });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Marks settlement as completed after funds capture.
   */
  async completeSettlement ({ settlementId, paymentReference }) {
    await this.db.query(
      `UPDATE settlements
         SET status = $1,
             payment_reference = $2,
             completed_at = NOW()
       WHERE id = $3`,
      ['COMPLETED', paymentReference, settlementId]
    );
    logger.info('Settlement completed', { settlementId });
  }

  /**
   * Updates internal risk status based on external scoring.
   */
  async handleRiskResult ({ settlementId, score, disposition }) {
    await this.db.query(
      `UPDATE settlements
         SET risk_score       = $1,
             risk_disposition = $2
       WHERE id = $3`,
      [score, disposition, settlementId]
    );
    logger.info('Risk result ingested', { settlementId, score, disposition });
  }
}

const settlementService = new SettlementDomainService(dbPool);


// -----------------------------------------------------------------------------
// Event handlers map
// -----------------------------------------------------------------------------
const handlers = {
  SETTLEMENT_REQUESTED        : async ({ payload }) =>
    settlementService.initiateSettlement(payload),

  SETTLEMENT_FUNDS_CAPTURED   : async ({ payload }) =>
    settlementService.completeSettlement(payload),

  RISK_ASSESSMENT_COMPLETED   : async ({ payload }) =>
    settlementService.handleRiskResult(payload)
};


// -----------------------------------------------------------------------------
// Utility – forward an event to a different topic (audit / DLQ)
// -----------------------------------------------------------------------------
async function forwardEvent (topic, originalEvent, extra = {}) {
  try {
    await producer.send({
      topic,
      messages: [{
        key   : originalEvent.meta?.correlationId || uuid(),
        value : JSON.stringify({ ...originalEvent, ...extra })
      }]
    });
  } catch (err) {
    logger.error('Unable to forward event', { topic, err });
  }
}


// -----------------------------------------------------------------------------
// Consumer bootstrap
// -----------------------------------------------------------------------------
async function start () {
  logger.info('Starting Settlement Event Consumer…');

  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topic: KAFKA_SETTLEMENT_EVENTS_TOPIC, fromBeginning: false });

  consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message, heartbeat, pause }) => {
      const rawValue = message.value.toString();
      let event;

      try {
        event = JSON.parse(rawValue);
      } catch (err) {
        logger.error('Invalid JSON', { err, rawValue });
        await forwardEvent(KAFKA_DLQ_TOPIC, { rawValue }, { reason: 'INVALID_JSON', timestamp: new Date().toISOString() });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        return;
      }

      const correlationId = event?.meta?.correlationId || uuid();
      logger.debug('Event received', { type: event.type, correlationId });

      // Schema validation
      const validate = validators[event.type];
      if (!validate) {
        logger.warn('Unknown event type – skipping', { type: event.type, correlationId });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        return;
      }

      if (!validate(event)) {
        logger.error('Schema validation failed', {
          errors       : validate.errors,
          correlationId,
          eventType    : event.type
        });
        await forwardEvent(KAFKA_DLQ_TOPIC, event, { reason: 'SCHEMA_INVALID', validationErrors: validate.errors });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        return;
      }

      // Decrypt payload if necessary
      try {
        if (event.payload.encrypted) {
          event.payload = decryptPayload(event.payload);
        }
      } catch (err) {
        logger.error('Payload decryption failed', { err, correlationId });
        await forwardEvent(KAFKA_DLQ_TOPIC, event, { reason: 'DECRYPTION_FAILED', error: err.message });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        return;
      }

      // Domain handling
      const handler = handlers[event.type];
      if (!handler) {
        logger.warn('No handler registered – skipping', { type: event.type });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
        return;
      }

      try {
        await handler({ payload: event.payload, meta: event.meta });
        await forwardEvent(KAFKA_AUDIT_TRAIL_TOPIC, event, { processedBy: SERVICE_ID, processedAt: new Date().toISOString() });
        await consumer.commitOffsets([{ topic, partition, offset: (Number(message.offset) + 1).toString() }]);
      } catch (err) {
        logger.error('Domain handler failed', { err, correlationId, eventType: event.type });
        await forwardEvent(KAFKA_DLQ_TOPIC, event, { reason: 'HANDLER_ERROR', error: err.message });
        // Do not commit offset to allow retry (depends on retry policy & DLQ strategy)
      }

      // Heartbeat to avoid session timeout on long tasks
      await heartbeat();
    }
  });

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function shutdown () {
  logger.info('Shutting down Settlement Event Consumer…');
  await consumer.disconnect();
  await producer.disconnect();
  await dbPool.end();
  process.exit(0);
}


// -----------------------------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------------------------
start()
  .catch(err => {
    logger.error('Fatal error in consumer', { err });
    process.exit(1);
  });

```