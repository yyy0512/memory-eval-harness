```javascript
/**
 * PayPalsphere • KYC-Service
 *
 * This micro-service is responsible for Know-Your-Customer (KYC) verification.
 * It exposes an HTTP command API, publishes/consumes events on Kafka, and
 * persists an immutable audit trail via EventStoreDB (event-sourcing).
 *
 * Dependencies are intentionally kept in-file for demo purposes. In production,
 * each module would live in its own file with tighter unit/integration tests.
 */

/* ────────────  Node & 3rd-party imports ──────────── */
require('dotenv').config();                     // Environment variables
const express             = require('express');
const { v4: uuid }        = require('uuid');    // Correlation / aggregate IDs
const Ajv                 = require('ajv');     // JSON-Schema validation
const { Kafka }           = require('kafkajs'); // Message bus
const winston             = require('winston'); // Structured logging
const {
  json,
  urlencoded
}                       = express;
const {
  EventStoreDBClient,    // CQRS / Event-Sourcing datastore
  jsonEvent,
  FORWARDS
} = require('@eventstore/db-client');

/* ────────────  Configuration & constants ──────────── */
const {
  PORT                     = 4002,
  KAFKA_BROKERS            = 'localhost:9092',
  EVENTSTOREDB_URI         = 'esdb://localhost:2113?tls=false',
  KYC_THIRD_PARTY_ENDPOINT = 'https://sandbox.kyc-provider.fake/verify',
  SERVICE_NAME             = 'kyc-service'
} = process.env;

const KAFKA_CLIENT_ID = SERVICE_NAME;
const CMD_TOPIC       = 'kyc.commands';
const EVT_TOPIC       = 'kyc.events';

/* ────────────  Logger setup ──────────── */
const logger = winston.createLogger({
  level     : 'info',
  format    : winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

/* ────────────  Schema validation setup ──────────── */
const ajv          = new Ajv();
const requestSchema = {
  $id       : 'KYCCreationRequest',
  type      : 'object',
  required  : ['userId', 'documentType', 'documentNumber', 'fullName', 'dateOfBirth'],
  additionalProperties: false,
  properties: {
    userId         : { type: 'string', minLength: 3 },
    documentType   : { type: 'string', enum: ['PASSPORT', 'NATIONAL_ID', 'DRIVERS_LICENSE'] },
    documentNumber : { type: 'string', minLength: 5 },
    fullName       : { type: 'string', minLength: 3 },
    dateOfBirth    : { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } // YYYY-MM-DD
  }
};
const validateRequestBody = ajv.compile(requestSchema);

/* ────────────  Third-party KYC provider stub ──────────── */
/**
 * In production, this would integrate with a vendor like Persona, Onfido,
 * or Trulioo. We keep it deterministic here for ease of testing.
 *
 * @returns {Promise<'APPROVED'|'DENIED'|'PENDING_REVIEW'>}
 */
async function callThirdPartyKycProvider(payload) {
  logger.info('Calling external KYC provider', { payload });

  // Simulate variable latency & result
  await new Promise(res => setTimeout(res, 500 + Math.random() * 1200));

  // Simple deterministic rule for demo: odd document numbers == DENIED
  const lastChar = payload.documentNumber.slice(-1);
  if (parseInt(lastChar, 10) % 2) return 'DENIED';
  if (lastChar === '0')          return 'PENDING_REVIEW';
  return 'APPROVED';
}

/* ────────────  EventStoreDB client ──────────── */
const eventStore = EventStoreDBClient.connectionString(EVENTSTOREDB_URI);

/**
 * Persist an immutable event to EventStoreDB.
 * @param {string}       streamId e.g., "kyc-<userId>"
 * @param {string}       type     domain event name
 * @param {Record<string,any>} data  serialisable payload
 */
async function persistEvent(streamId, type, data) {
  try {
    await eventStore.appendToStream(streamId, jsonEvent({ type, data }));
  } catch (err) {
    logger.error('Failed to append event to store', { streamId, type, err });
    throw err;
  }
}

/* ────────────  Kafka connectivity ──────────── */
const kafka    = new Kafka({
  clientId : KAFKA_CLIENT_ID,
  brokers  : KAFKA_BROKERS.split(',').map(b => b.trim())
});
const producer = kafka.producer({ allowAutoTopicCreation: true });
const consumer = kafka.consumer({ groupId: `${SERVICE_NAME}-group` });

/* ────────────  Express setup ──────────── */
const app = express();
app.use(json({ limit: '100kb' }));
app.use(urlencoded({ extended: false }));

/* ────────────  Health & readiness probes ──────────── */
app.get('/health', (req, res) => res.json({ service: SERVICE_NAME, status: 'OK' }));

/* ────────────  /kyc/verify endpoint ──────────── */
app.post('/kyc/verify', async (req, res) => {
  const payload = req.body;

  if (!validateRequestBody(payload)) {
    return res.status(400).json({ errors: validateRequestBody.errors });
  }

  const correlationId = uuid();
  const command = {
    id           : uuid(),          // command id
    correlationId,
    type         : 'VERIFY_KYC',
    occurredAt   : new Date().toISOString(),
    payload
  };

  try {
    // Publish command to Kafka
    await producer.send({
      topic : CMD_TOPIC,
      messages: [
        { key: payload.userId, value: JSON.stringify(command) }
      ]
    });

    logger.info('VERIFY_KYC command queued', { correlationId, userId: payload.userId });
    res.status(202).json({ correlationId });
  } catch (err) {
    logger.error('Failed to dispatch VERIFY_KYC command', { err });
    res.status(500).json({ message: 'Failed to queue verification request.' });
  }
});

/* ────────────  Command handling worker ──────────── */
async function startCommandConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topic: CMD_TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let command;
      try {
        command = JSON.parse(message.value.toString('utf8'));
      } catch (err) {
        return logger.error('Unable to parse command', { err, raw: message.value });
      }

      if (command.type !== 'VERIFY_KYC') return;

      const { payload, correlationId } = command;
      const streamId = `kyc-${payload.userId}`;

      logger.info('Processing VERIFY_KYC', { correlationId, userId: payload.userId });

      try {
        // Step 1: Persist KycRequested event
        await persistEvent(streamId, 'KycRequested', { ...payload, correlationId });

        // Step 2: Invoking vendor
        const result = await callThirdPartyKycProvider(payload);

        // Step 3: Persist KycResult event
        const resultEventType = 'Kyc' + (result.charAt(0) + result.slice(1).toLowerCase()); // e.g., KycApproved
        await persistEvent(streamId, resultEventType, { ...payload, correlationId, result });

        // Step 4: Emit domain event to Kafka
        const domainEvent = {
          id           : uuid(),
          correlationId,
          aggregateId  : payload.userId,
          type         : resultEventType,
          occurredAt   : new Date().toISOString(),
          payload: { result }
        };
        await producer.send({
          topic   : EVT_TOPIC,
          messages: [{ key: payload.userId, value: JSON.stringify(domainEvent) }]
        });

        logger.info('KYC verification completed', { correlationId, result });
      } catch (err) {
        logger.error('Failed processing VERIFY_KYC command', { correlationId, err });
        const failureEvent = {
          id           : uuid(),
          correlationId,
          aggregateId  : payload.userId,
          type         : 'KycVerificationFailed',
          occurredAt   : new Date().toISOString(),
          payload      : { reason: err.message }
        };
        // Persist failure event
        await persistEvent(streamId, failureEvent.type, failureEvent.payload).catch(() => {
          /* intentionally ignored to avoid infinite failure loops */
        });
      }
    }
  });
}

/* ────────────  Graceful shutdown helpers ──────────── */
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down ${SERVICE_NAME}…`);
  try {
    await consumer.disconnect();
    await producer.disconnect();
  } catch (err) {
    logger.warn('Error during Kafka disconnect', { err });
  }
  server.close(err => {
    if (err) {
      logger.error('Error closing HTTP server', { err });
      process.exit(1);
    }
    logger.info(`${SERVICE_NAME} terminated gracefully`);
    process.exit(0);
  });
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => {
  process.on(sig, () => gracefulShutdown(sig));
});

/* ────────────  Bootstrap sequence ──────────── */
let server;

(async () => {
  try {
    await producer.connect();
    logger.info('Kafka producer connected');

    await startCommandConsumer();
    logger.info('Kafka consumer running');

    server = app.listen(PORT, () =>
      logger.info(`${SERVICE_NAME} listening on port ${PORT}`)
    );
  } catch (err) {
    logger.error('Service failed to start', { err });
    process.exit(1);
  }
})();
```