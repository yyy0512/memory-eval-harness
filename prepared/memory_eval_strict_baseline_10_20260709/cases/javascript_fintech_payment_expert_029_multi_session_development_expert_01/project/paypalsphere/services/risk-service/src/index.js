/**
 * PayPalsphere – Risk Service
 *
 * The Risk Service is responsible for real-time fraud screening and risk
 * classification of transactions flowing through the PayPalsphere network.
 * The service is event-driven (CQRS / Event-Sourcing) and listens for
 * TransactionInitiated events on the message bus. After evaluating the risk
 * for the transaction, it emits a RiskAssessed event that downstream services
 * (Compliance, Settlement, etc.) can act upon.
 *
 * The service also exposes a minimal HTTP API for synchronous risk assessment
 * (e.g. back-office tooling) and health checks.
 *
 * NOTE: Keep this file intentionally small—delegate domain logic to /domain
 * modules in a real codebase.  For the sake of the challenge, everything lives
 * here.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Dependencies                                                             */
/* ────────────────────────────────────────────────────────────────────────── */
const express = require('express');
const amqp = require('amqplib');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats');
const pino = require('pino');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/* ────────────────────────────────────────────────────────────────────────── */
/* Configuration                                                            */
/* ────────────────────────────────────────────────────────────────────────── */
dotenv.config();

const {
  PORT = 4005,
  AMQP_URL = 'amqp://localhost',
  EXCHANGE_EVENTS = 'paypalsphere.events',
  EXCHANGE_DELAYED = 'paypalsphere.delayed',
  SERVICE_QUEUE = 'risk_service.q',
  SERVICE_ROUTING_KEY = 'risk.#',
  SIGNING_SECRET = 'topsecretkey'
} = process.env;

const app = express();
const logger = pino({ name: 'risk-service', level: process.env.LOG_LEVEL || 'info' });

/* ────────────────────────────────────────────────────────────────────────── */
/* JSON Validator Setup                                                     */
/* ────────────────────────────────────────────────────────────────────────── */
const ajv = new Ajv({ allErrors: true, removeAdditional: true });
addFormats(ajv);

const TRANSACTION_INITIATED_SCHEMA = {
  $id: 'TransactionInitiated',
  type: 'object',
  required: [
    'eventId',
    'eventName',
    'data',
    'timestamp',
    'signature'
  ],
  properties: {
    eventId: { type: 'string', format: 'uuid' },
    eventName: { const: 'TransactionInitiated' },
    timestamp: { type: 'string', format: 'date-time' },
    signature: { type: 'string' },
    data: {
      type: 'object',
      required: [ 'transactionId', 'senderId', 'receiverId', 'amount', 'currency', 'metadata' ],
      properties: {
        transactionId: { type: 'string', format: 'uuid' },
        senderId: { type: 'string', format: 'uuid' },
        receiverId: { type: 'string', format: 'uuid' },
        amount: { type: 'number', minimum: 0 },
        currency: { type: 'string', minLength: 3, maxLength: 3 },
        metadata: { type: 'object' }
      }
    }
  }
};
ajv.addSchema(TRANSACTION_INITIATED_SCHEMA);

/* Schema for synchronous POST /risk/assess endpoint */
const ASSESS_SCHEMA = {
  type: 'object',
  required: [ 'transaction' ],
  properties: {
    transaction: TRANSACTION_INITIATED_SCHEMA.properties.data
  }
};

/* Compile validators */
const validateTransactionInitiated = ajv.getSchema('TransactionInitiated');
const validateAssessBody = ajv.compile(ASSESS_SCHEMA);

/* ────────────────────────────────────────────────────────────────────────── */
/* In-Memory Cache for KYC / Trust Signals                                  */
/* In production this would be a Redis or DynamoDB store.                   */
/* ────────────────────────────────────────────────────────────────────────── */
const trustProfileCache = new Map(); // userId => { kycLevel, trustScore, lastSeen }

/* ────────────────────────────────────────────────────────────────────────── */
/* Utility Helpers                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Very naive HMAC verifier for event payloads. In prod we would rotate keys.
 */
function verifySignature({ signature, payload }) {
  const computed = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
}

/**
 * Main risk scoring algorithm. Returns { score: Number, verdict: String }
 * This placeholder uses simple heuristics. Replace with ML model in prod.
 */
function calculateRiskScore({ amount, currency, senderTrustScore }) {
  let score = 0;

  // High-value transaction
  if (amount > 10000) score += 40;
  else if (amount > 5000) score += 25;
  else if (amount > 1000) score += 10;

  // Unsupported or exotic currency
  const mainstreamCurrencies = [ 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD' ];
  if (!mainstreamCurrencies.includes(currency)) score += 15;

  // Sender trust score (0-100, higher means safer)
  score += (100 - senderTrustScore) * 0.3;

  const verdict = score >= 60 ? 'HIGH'
                : score >= 30 ? 'MEDIUM'
                : 'LOW';

  return { score: Math.round(score), verdict };
}

/**
 * Publishes a domain event to the default exchange.
 */
async function emitEvent({ channel, eventName, data }) {
  const evt = {
    eventId: uuidv4(),
    eventName,
    timestamp: new Date().toISOString(),
    data
  };

  const signature = crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(JSON.stringify(evt))
    .digest('hex');
  evt.signature = signature;

  const payload = Buffer.from(JSON.stringify(evt));
  await channel.publish(EXCHANGE_EVENTS, `${eventName}`, payload, {
    contentType: 'application/json',
    persistent: true
  });

  logger.info({ eventName, eventId: evt.eventId }, 'Domain Event Emitted');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* AMQP Bootstrap                                                           */
/* ────────────────────────────────────────────────────────────────────────── */
let amqpConn;
let amqpChannel;

async function initAmqp() {
  amqpConn = await amqp.connect(AMQP_URL);
  amqpChannel = await amqpConn.createChannel();

  await amqpChannel.assertExchange(EXCHANGE_EVENTS, 'topic', { durable: true });
  await amqpChannel.assertQueue(SERVICE_QUEUE, { durable: true });
  await amqpChannel.bindQueue(SERVICE_QUEUE, EXCHANGE_EVENTS, SERVICE_ROUTING_KEY);

  // Bind to individual events
  await amqpChannel.bindQueue(SERVICE_QUEUE, EXCHANGE_EVENTS, 'TransactionInitiated');
  await amqpChannel.bindQueue(SERVICE_QUEUE, EXCHANGE_EVENTS, 'KYCUpdated');

  logger.info('AMQP connected and queue bound.');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* AMQP Consumer Logic                                                      */
/* ────────────────────────────────────────────────────────────────────────── */
async function startConsumer() {
  await amqpChannel.consume(SERVICE_QUEUE, async (msg) => {
    if (!msg) return;

    try {
      const payload = JSON.parse(msg.content.toString());
      const { eventName } = payload;

      switch (eventName) {
        case 'TransactionInitiated':
          await handleTransactionInitiated(payload);
          break;
        case 'KYCUpdated':
          await handleKycUpdated(payload);
          break;
        default:
          logger.warn({ eventName }, 'Unhandled event received.');
      }

      amqpChannel.ack(msg);
    } catch (err) {
      logger.error({ err }, 'Error processing message.');
      // Negative-ack and re-queue with delay? For simplicity we nack w/o requeue.
      amqpChannel.nack(msg, false, false);
    }
  });

  logger.info('Consumer started.');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Event Handlers                                                           */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Handle TransactionInitiated event.
 */
async function handleTransactionInitiated(event) {
  if (!validateTransactionInitiated(event)) {
    logger.error({ errors: validateTransactionInitiated.errors }, 'Invalid event format.');
    return;
  }

  if (!verifySignature({ signature: event.signature, payload: event })) {
    logger.error({ eventId: event.eventId }, 'Invalid signature. Ignoring message.');
    return;
  }

  const {
    transactionId,
    senderId,
    amount,
    currency
  } = event.data;

  // Lookup sender trust profile
  const profile = trustProfileCache.get(senderId) || { trustScore: 50 }; // default 50
  const { trustScore } = profile;

  const { score, verdict } = calculateRiskScore({
    amount,
    currency,
    senderTrustScore: trustScore
  });

  logger.info(
    { transactionId, senderId, score, verdict },
    'Risk assessment completed.'
  );

  // Emit RiskAssessed event
  await emitEvent({
    channel: amqpChannel,
    eventName: 'RiskAssessed',
    data: {
      transactionId,
      senderId,
      riskScore: score,
      riskVerdict: verdict
    }
  });
}

/**
 * Handle KYCUpdated event.
 * Keep trust profile cache up-to-date.
 */
async function handleKycUpdated(event) {
  const {
    userId,
    kycLevel,
    trustScore
  } = event.data || {};

  if (!userId) return;

  trustProfileCache.set(userId, { kycLevel, trustScore });
  logger.debug({ userId, kycLevel, trustScore }, 'Trust profile updated.');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* HTTP Server                                                              */
/* ────────────────────────────────────────────────────────────────────────── */
app.use(express.json());

/**
 * Health probe for Kubernetes / Docker
 */
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

/**
 * Synchronous risk assessment endpoint.
 * POST /risk/assess
 * {
 *   "transaction": {
 *     "transactionId": "...",
 *     "senderId": "...",
 *     "receiverId": "...",
 *     "amount": 42.9,
 *     "currency": "USD",
 *     "metadata": {}
 *   }
 * }
 */
app.post('/risk/assess', async (req, res) => {
  const body = req.body;

  if (!validateAssessBody(body)) {
    return res.status(400).json({ errors: validateAssessBody.errors });
  }

  const { transaction } = body;
  const profile = trustProfileCache.get(transaction.senderId) || { trustScore: 50 };
  const { score, verdict } = calculateRiskScore({
    amount: transaction.amount,
    currency: transaction.currency,
    senderTrustScore: profile.trustScore
  });

  // Asynchronously emit RiskAssessed event for parity with async flow
  emitEvent({
    channel: amqpChannel,
    eventName: 'RiskAssessed',
    data: {
      transactionId: transaction.transactionId,
      senderId: transaction.senderId,
      riskScore: score,
      riskVerdict: verdict
    }
  }).catch((err) => logger.error({ err }, 'Failed to emit RiskAssessed event.'));

  res.json({ score, verdict });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* Graceful Shutdown                                                        */
/* ────────────────────────────────────────────────────────────────────────── */
function shutdown(signal) {
  logger.warn({ signal }, 'Shutdown signal received.');

  Promise.resolve()
    .then(() => amqpChannel && amqpChannel.close())
    .then(() => amqpConn && amqpConn.close())
    .then(() => {
      logger.info('AMQP connection closed. Exiting.');
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Error during shutdown.');
      process.exit(1);
    });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ────────────────────────────────────────────────────────────────────────── */
/* Bootstrap                                                                */
/* ────────────────────────────────────────────────────────────────────────── */
(async function bootstrap() {
  try {
    await initAmqp();
    await startConsumer();

    app.listen(PORT, () => {
      logger.info(`Risk Service listening on port ${PORT}`);
    });
  } catch (err) {
    logger.error({ err }, 'Failed to bootstrap service.');
    process.exit(1);
  }
})();