```javascript
/**
 * PayPalsphere – Social-Graph Service
 * ===================================
 *
 * Entry-point & composition root for the Social-Graph micro-service. The service owns
 * the “social” bounded context: friendships, circles, memberships and follow
 * relationships, exposing a RESTful CQRS surface and emitting immutable domain
 * events into the company-wide Event Bus (Kafka).
 *
 * Architectural concerns addressed:
 *  • Security-by-Design  – JWT / mTLS ready, field-level encryption helpers (libsodium)
 *  • CQRS               – commands mutate state, queries read from projections
 *  • Event Sourcing     – every state transition is persisted as an event record
 *  • Saga friendly      – events are published on Kafka for orchestration
 *
 * NOTE: some infrastructure (e.g. DB migrations, Kafka topic creation) is assumed to
 * be provisioned by DevOps pipelines and is not implemented here.
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────────
 * External Dependencies
 * ────────────────────────────────────────────────────────────────────────── */
const express            = require('express');
const helmet             = require('helmet');
const morgan             = require('morgan');
const { v4: uuid }       = require('uuid');
const Ajv                = require('ajv').default;
const addFormats         = require('ajv-formats');
const { Pool }           = require('pg');
const { Kafka }          = require('kafkajs');
const pino               = require('pino');
const Crypto             = require('crypto');

/* ────────────────────────────────────────────────────────────────────────────
 * Environment & Globals
 * ────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();

const {
  PORT                 = 4003,
  SERVICE_NAME         = 'social-graph-service',
  DB_URL,
  KAFKA_BROKERS        = 'localhost:9092',
  KAFKA_CLIENT_ID      = 'paypalsphere-social-graph',
  EVENT_TOPIC          = 'social.events',
  COMMAND_TOPIC        = 'social.commands',           // optional, if consuming commands
  FIELD_ENCRYPTION_KEY // 32-byte base64 key
} = process.env;

if (!DB_URL) {
  /* eslint no-console: 0 */
  console.error('FATAL: DB_URL env-var is required'); // early fail
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Logger
 * ────────────────────────────────────────────────────────────────────────── */
const log = pino({
  name     : SERVICE_NAME,
  level    : process.env.LOG_LEVEL || 'info',
  redact   : ['req.headers.authorization', 'req.headers.cookie']
});

/* ────────────────────────────────────────────────────────────────────────────
 * Utility: Field-level Encryption / Decryption
 *   – small wrapper around AES-256-GCM symmetric encryption.
 * ────────────────────────────────────────────────────────────────────────── */
const ENC_KEY = Buffer.from(FIELD_ENCRYPTION_KEY || Crypto.randomBytes(32)); // 32 bytes
const IV_LEN = 12;

function encryptField(plainText) {
  const iv = Crypto.randomBytes(IV_LEN);
  const cipher = Crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptField(encDataB64) {
  const data = Buffer.from(encDataB64, 'base64');
  const iv   = data.slice(0, IV_LEN);
  const tag  = data.slice(IV_LEN, IV_LEN + 16);
  const text = data.slice(IV_LEN + 16);
  const decipher = Crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
  decipher.setAuthTag(tag);
  return decipher.update(text, null, 'utf8') + decipher.final('utf8');
}

/* ────────────────────────────────────────────────────────────────────────────
 * PostgreSQL Pool – singleton
 * ────────────────────────────────────────────────────────────────────────── */
const pg = new Pool({ connectionString: DB_URL });

pg.on('error', (err) => {
  log.error({ err }, 'Postgres pool error (unexpected), exiting.');
  process.exit(1); // let container restart
});

/* ────────────────────────────────────────────────────────────────────────────
 * Kafka – producer (and optional consumer)
 * ────────────────────────────────────────────────────────────────────────── */
const kafka = new Kafka({
  clientId : KAFKA_CLIENT_ID,
  brokers  : KAFKA_BROKERS.split(',')
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: `${KAFKA_CLIENT_ID}-group` });

async function initKafka() {
  await producer.connect();
  log.info('Kafka producer connected');

  // Optional: listen for external commands (Saga choreography)
  await consumer.connect();
  await consumer.subscribe({ topic: COMMAND_TOPIC, fromBeginning: false });

  consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const command = JSON.parse(message.value.toString());
        log.debug({ topic, command }, 'Received command');
        await CommandBus.dispatch(command); // pass to in-mem command bus
      } catch (err) {
        log.error({ err }, 'Failed processing Kafka command');
      }
    }
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * AJV Schemas
 * ────────────────────────────────────────────────────────────────────────── */
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/**
 * Command schema definitions
 */
const CommandSchemas = {
  AddFriend: {
    type: 'object',
    properties: {
      type: { const: 'AddFriend' },
      payload: {
        type: 'object',
        properties: {
          requesterUserId: { type: 'string', format: 'uuid' },
          targetUserId   : { type: 'string', format: 'uuid' }
        },
        required: ['requesterUserId', 'targetUserId'],
        additionalProperties: false
      },
      metadata: { type: 'object' }
    },
    required: ['type', 'payload'],
    additionalProperties: false
  },

  CreateCircle: {
    type: 'object',
    properties: {
      type: { const: 'CreateCircle' },
      payload: {
        type: 'object',
        properties: {
          ownerUserId: { type: 'string', format: 'uuid' },
          name       : { type: 'string', minLength: 1, maxLength: 120 },
          visibility : { enum: ['private', 'public'] }
        },
        required: ['ownerUserId', 'name', 'visibility'],
        additionalProperties: false
      },
      metadata: { type: 'object' }
    },
    required: ['type', 'payload'],
    additionalProperties: false
  },

  // ... other command schemas
};

Object.entries(CommandSchemas).forEach(([k, schema]) => {
  ajv.addSchema(schema, `CMD::${k}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * Domain Repository (simplified)
 * ────────────────────────────────────────────────────────────────────────── */
class SocialGraphRepository {
  /**
   * Add a bi-directional friendship edge.
   */
  static async addFriendEdge(requesterUserId, targetUserId) {
    const client = await pg.connect();
    try {
      await client.query('BEGIN');

      const insertText = `
        INSERT INTO social_friendships (user_id, friend_user_id)
        VALUES ($1, $2), ($2, $1)
        ON CONFLICT DO NOTHING
      `;

      await client.query(insertText, [requesterUserId, targetUserId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Create a circle and assign ownership membership.
   */
  static async createCircle(ownerUserId, name, visibility) {
    const client = await pg.connect();
    try {
      await client.query('BEGIN');

      const circleIdRes = await client.query(
        `INSERT INTO social_circles (circle_id, name, visibility, owner_user_id)
         VALUES ($1, $2, $3, $4) RETURNING circle_id`,
        [uuid(), encryptField(name), visibility, ownerUserId] // Store name encrypted
      );

      const circleId = circleIdRes.rows[0].circle_id;

      await client.query(
        `INSERT INTO social_circle_members (circle_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [circleId, ownerUserId]
      );

      await client.query('COMMIT');
      return circleId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get friends for query projection.
   */
  static async listFriends(userId) {
    const { rows } = await pg.query(
      `SELECT friend_user_id AS friend
         FROM social_friendships
        WHERE user_id = $1`,
      [userId]
    );
    return rows.map(r => r.friend);
  }

  // ... additional repository helpers
}

/* ────────────────────────────────────────────────────────────────────────────
 * Event Store
 *  – simplistic implementation using single table append-only log
 * ────────────────────────────────────────────────────────────────────────── */
class EventStore {
  static async append(event) {
    return pg.query(
      `INSERT INTO social_event_store (event_id, type, payload, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [event.id, event.type, JSON.stringify(event.payload), JSON.stringify(event.metadata || {})]
    );
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Domain Events
 * ────────────────────────────────────────────────────────────────────────── */
class DomainEvent {
  constructor(type, payload, metadata = {}) {
    this.id       = uuid();
    this.type     = type;        // e.g. 'FriendAdded'
    this.payload  = payload;
    this.metadata = { ...metadata, service: SERVICE_NAME, occurredAt: new Date().toISOString() };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Command Bus
 * ────────────────────────────────────────────────────────────────────────── */
const CommandHandlers = {
  async AddFriend(command) {
    const { requesterUserId, targetUserId } = command.payload;
    await SocialGraphRepository.addFriendEdge(requesterUserId, targetUserId);

    const event = new DomainEvent('FriendAdded', { requesterUserId, targetUserId }, command.metadata);
    await EventStore.append(event);
    await producer.send({ topic: EVENT_TOPIC, messages: [{ key: event.id, value: JSON.stringify(event) }] });
    log.info({ event }, 'FriendAdded event published');
  },

  async CreateCircle(command) {
    const { ownerUserId, name, visibility } = command.payload;
    const circleId = await SocialGraphRepository.createCircle(ownerUserId, name, visibility);

    const event = new DomainEvent('CircleCreated', { circleId, ownerUserId, name, visibility }, command.metadata);
    await EventStore.append(event);
    await producer.send({ topic: EVENT_TOPIC, messages: [{ key: event.id, value: JSON.stringify(event) }] });
    log.info({ event }, 'CircleCreated event published');
  }

  // ... other handlers
};

class CommandBus {
  static async dispatch(command) {
    const validate = ajv.getSchema(`CMD::${command.type}`);
    if (!validate) {
      throw new Error(`Unsupported command: ${command.type}`);
    }
    const valid = validate(command);
    if (!valid) {
      const err = new Error('Command validation failed');
      err.validation = validate.errors;
      throw err;
    }

    const handler = CommandHandlers[command.type];
    if (!handler) {
      throw new Error(`No command handler registered for ${command.type}`);
    }
    await handler(command);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Express App (Query Side + Command HTTP ingress)
 * ────────────────────────────────────────────────────────────────────────── */
const app = express();

app.use(helmet());
app.use(express.json({ limit: '512kb' }));
app.use(morgan('combined', { stream: { write: (msg) => log.info(msg.trim()) } }));

/**
 * Middleware: Standard error envelope
 */
function errorHandler(err, req, res, next) { // eslint-disable-line
  log.error({ err }, 'Unhandled error');
  const status = err.validation ? 400 : 500;
  res.status(status).json({
    error: {
      message: err.message,
      ...(err.validation ? { validation: err.validation } : {})
    }
  });
}

/**
 * Health-check
 */
app.get('/health', (_req, res) => res.json({ status: 'ok', service: SERVICE_NAME }));

/* ────────────────────────────────────────────────────────────────────────────
 * Command ingress (HTTP) – POST /commands
 * ────────────────────────────────────────────────────────────────────────── */
app.post('/commands', async (req, res, next) => {
  try {
    await CommandBus.dispatch(req.body);
    return res.status(202).json({ status: 'accepted', commandId: req.body.metadata?.correlationId || null });
  } catch (err) {
    return next(err);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * Query API
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * GET /users/:userId/friends
 * – Return list of friend userIds.
 */
app.get('/users/:userId/friends', async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!uuid.validate(userId)) {
      return res.status(400).json({ error: { message: 'Invalid userId' } });
    }
    const friends = await SocialGraphRepository.listFriends(userId);
    return res.json({ userId, friends });
  } catch (err) {
    return next(err);
  }
});

/**
 * TODO: implement more query endpoints
 */

app.use(errorHandler);

/* ────────────────────────────────────────────────────────────────────────────
 * Bootstrap
 * ────────────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pg.query('SELECT 1'); // sanity DB ping
    await initKafka();

    app.listen(PORT, () => {
      log.info({ PORT }, `${SERVICE_NAME} listening on port ${PORT}`);
    });
  } catch (err) {
    log.error({ err }, 'Failed during service bootstrap');
    process.exit(1);
  }
})();
```