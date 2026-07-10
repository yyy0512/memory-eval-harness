```javascript
/**
 * PayPalsphere – Settlement Service
 * File: paypalsphere/services/settlement-service/src/index.js
 *
 * Responsibilities
 * ─────────────────
 * • Exposes a REST-ful façade for Circle settlement workflows
 * • Implements CQRS + Event Sourcing:
 *     – Commands received through HTTP → written as immutable events
 *     – A minimal read-model is updated in-process for fast look-ups
 * • Publishes domain events to the internal event bus (RabbitMQ)
 * • Coordinates a local Saga for cross-service orchestration
 *
 * Security & Ops
 * ──────────────
 * • Field-level AES-256 encryption before persistence
 * • Rate limiting, HTTP hardening, structured logging
 * • Graceful shutdown hooks for DB + AMQP
 *
 * NOTE: In a real-world repository, domain models, config, and infra helpers
 *       would be split across multiple modules. For the purpose of this
 *       exercise they are collocated in a single file for transparency.
 */
/* eslint-disable no-console */

require('dotenv').config(); // Load .env before anything else

/* ──────────────────  Node/3P dependencies  ────────────────── */
const express           = require('express');
const helmet            = require('helmet');
const rateLimit         = require('express-rate-limit');
const Joi               = require('joi');
const { v4: uuid }      = require('uuid');
const winston           = require('winston');
const amqp              = require('amqplib');
const { Pool }          = require('pg');
const crypto            = require('crypto');

/* ──────────────────  Configuration constants  ────────────────── */
const {
  PORT                     = 4004,
  POSTGRES_URL             = 'postgres://settlement:secret@localhost:5432/settlement',
  RABBITMQ_URL             = 'amqp://localhost',
  EVENT_EXCHANGE           = 'paypalsphere.events',
  AES_SECRET               = crypto.randomBytes(32).toString('hex'), // Fallback (dev only)
  RATE_LIMIT_WINDOW_MS     = 15 * 60 * 1000, // 15 minutes
  RATE_LIMIT_MAX_REQUESTS  = 500,
} = process.env;

/* ──────────────────  Logger  ────────────────── */
const logger = winston.createLogger({
  level      : 'info',
  format     : winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports : [
    new winston.transports.Console({ handleExceptions: true }),
  ],
});

/* ──────────────────  Database (Write-model + Event Store)  ────────────────── */
const pool = new Pool({ connectionString: POSTGRES_URL });

const initDb = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlement_events (
      id              UUID        PRIMARY KEY,
      settlement_id   UUID        NOT NULL,
      circle_id       UUID        NOT NULL,
      event_type      TEXT        NOT NULL,
      payload         JSONB       NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Materialised 'read' projection for quick access
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settlement_projection (
      settlement_id   UUID        PRIMARY KEY,
      state           TEXT        NOT NULL,
      total_amount    NUMERIC     NOT NULL,
      currency        TEXT        NOT NULL,
      payer_id        UUID        NOT NULL,
      participants    JSONB       NOT NULL,
      description_enc BYTEA       NOT NULL,            -- Encrypted
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

/* ──────────────────  AMQP  ────────────────── */
let amqpConn;
let amqpChannel;

const initAmqp = async () => {
  amqpConn    = await amqp.connect(RABBITMQ_URL);
  amqpChannel = await amqpConn.createChannel();
  await amqpChannel.assertExchange(EVENT_EXCHANGE, 'fanout', { durable: true });
  logger.info('AMQP connected');
};

const publishEvent = async (type, payload) => {
  const message = Buffer.from(JSON.stringify({ type, payload, ts: Date.now() }));
  await amqpChannel.publish(EVENT_EXCHANGE, '', message, { persistent: true });
};

/* ──────────────────  Encryption helpers  ────────────────── */
const AES_ALG = 'aes-256-gcm';

const encrypt = (plaintext) => {
  const iv   = crypto.randomBytes(12);
  const key  = Buffer.from(AES_SECRET, 'hex');
  const cipher = crypto.createCipheriv(AES_ALG, key, iv);

  const enc  = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]); // Store IV+TAG+DATA
};

const decrypt = (ciphertext) => {
  const buf  = Buffer.from(ciphertext);
  const iv   = buf.slice(0, 12);
  const tag  = buf.slice(12, 28);
  const data = buf.slice(28);
  const key  = Buffer.from(AES_SECRET, 'hex');
  const decipher = crypto.createDecipheriv(AES_ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
};

/* ──────────────────  Domain & Validation  ────────────────── */
const settlementSchema = Joi.object({
  circleId     : Joi.string().uuid().required(),
  amount       : Joi.number().precision(2).positive().required(),
  currency     : Joi.string().length(3).uppercase().required(),
  payerId      : Joi.string().uuid().required(),
  participants : Joi.array().items(Joi.string().uuid()).min(1).required(),
  description  : Joi.string().max(280).allow('').default(''),
});

/* ──────────────────  Express App  ────────────────── */
const app = express();

app.use(express.json());
app.use(helmet());
app.use(rateLimit({
  windowMs : RATE_LIMIT_WINDOW_MS,
  max      : RATE_LIMIT_MAX_REQUESTS,
}));
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));

/**
 * POST /settlements
 * Create a new settlement request
 */
app.post('/settlements', async (req, res) => {
  const { error, value } = settlementSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', details: error.details });
  }

  const {
    circleId, amount, currency, payerId, participants, description,
  } = value;

  const settlementId = uuid();
  const eventId      = uuid();

  const eventPayload = {
    settlementId,
    circleId,
    amount,
    currency,
    payerId,
    participants,
    description,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    /* 1. Persist immutable event */
    await client.query(
      `INSERT INTO settlement_events (id, settlement_id, circle_id, event_type, payload)
       VALUES ($1, $2, $3, 'SettlementRequested', $4)`,
      [eventId, settlementId, circleId, eventPayload],
    );

    /* 2. Update Read Model (projection) */
    await client.query(
      `INSERT INTO settlement_projection
        (settlement_id, state, total_amount, currency, payer_id, participants, description_enc)
       VALUES ($1, 'REQUESTED', $2, $3, $4, $5, $6)`,
      [
        settlementId,
        amount,
        currency,
        payerId,
        JSON.stringify(participants),
        encrypt(description),
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('DB transaction failed', { err });
    return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  } finally {
    client.release();
  }

  /* 3. Emit event to bus for downstream consumers (KYC, Risk, etc.) */
  await publishEvent('SettlementRequested', eventPayload);

  logger.info('SettlementRequested event published', { settlementId });
  return res.status(202).json({ settlementId, state: 'REQUESTED' });
});

/**
 * GET /settlements/:id
 * Retrieve current settlement state (projection)
 */
app.get('/settlements/:id', async (req, res) => {
  const { id } = req.params;
  if (!uuid.validate(id)) return res.status(400).json({ error: 'INVALID_ID' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM settlement_projection WHERE settlement_id = $1',
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: 'NOT_FOUND' });

    const row = rows[0];
    return res.json({
      settlementId : row.settlement_id,
      state        : row.state,
      amount       : row.total_amount,
      currency     : row.currency,
      payerId      : row.payer_id,
      participants : row.participants,
      description  : decrypt(row.description_enc),
      createdAt    : row.created_at,
      updatedAt    : row.updated_at,
    });
  } catch (err) {
    logger.error('Failed to fetch settlement', { err });
    return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});

/**
 * (AMQP consumer) Handle external events to progress local Saga
 * Example: KycVerified, RiskScored, FundsCaptured → SettlementCompleted
 */
const bootstrapSagaConsumers = async () => {
  const queue = 'settlement-service'; // Service-local queue
  await amqpChannel.assertQueue(queue, { durable: true });
  await amqpChannel.bindQueue(queue, EVENT_EXCHANGE, '');

  amqpChannel.consume(queue, async (msg) => {
    if (!msg) return;
    let event;
    try {
      event = JSON.parse(msg.content.toString());
    } catch (e) {
      logger.warn('Invalid event JSON', { err: e });
      return amqpChannel.ack(msg);
    }

    try {
      await handleIncomingEvent(event);
      amqpChannel.ack(msg);
    } catch (err) {
      logger.error('Event handling failed', { err, event });
      /* NACK with requeue=false to prevent poison-message loops.
         A DLQ would be a better production strategy. */
      amqpChannel.nack(msg, false, false);
    }
  });
};

/* ──────────────────  Saga Orchestration  ────────────────── */
const handleIncomingEvent = async ({ type, payload }) => {
  switch (type) {
    case 'FundsCaptured':    return progressSettlement(payload.settlementId, 'CAPTURED');
    case 'ComplianceOk':     return progressSettlement(payload.settlementId, 'COMPLETED');
    case 'ComplianceFail':   return progressSettlement(payload.settlementId, 'REJECTED');
    default:                 return null;
  }
};

const progressSettlement = async (settlementId, nextState) => {
  const eventId = uuid();
  const client  = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert state change event
    await client.query(`
      INSERT INTO settlement_events (id, settlement_id, circle_id, event_type, payload)
      SELECT $1, settlement_id, circle_id, $2, jsonb_build_object('state', $3)
      FROM settlement_events WHERE settlement_id = $4 LIMIT 1
    `, [eventId, 'Settlement' + nextState, nextState, settlementId]);

    // Update projection
    await client.query(`
      UPDATE settlement_projection
      SET state      = $1,
          updated_at = NOW()
      WHERE settlement_id = $2
    `, [nextState, settlementId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('progressSettlement failed', { err, settlementId });
    throw err; // Let caller nack/ack appropriately
  } finally {
    client.release();
  }

  /* Inform other services that the settlement advanced */
  await publishEvent('Settlement' + nextState, { settlementId, state: nextState });
  logger.info('Settlement advanced', { settlementId, state: nextState });
};

/* ──────────────────  Bootstrap  ────────────────── */
(async () => {
  try {
    await initDb();
    await initAmqp();
    await bootstrapSagaConsumers();

    const server = app.listen(PORT, () =>
      logger.info(`Settlement Service listening on :${PORT}`),
    );

    /* Graceful shutdown */
    const shutdown = async () => {
      logger.info('Shutting down…');
      await server.close();
      await amqpConn?.close();
      await pool.end();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error('Service failed to boot', { err });
    process.exit(1);
  }
})();
```