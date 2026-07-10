```javascript
/**
 * PayPalsphere – Accounts Service
 * File: paypalsphere/services/accounts-service/src/index.js
 *
 * Exposes a RESTful façade for account-centric commands (CQRS write side)
 * and publishes domain events to the internal event-bus for eventual
 * consistency, KYC pipelines, risk scoring, etc.
 *
 * This file purposely contains all runtime-critical glue code so that the
 * remainder of the service (aggregates, projections, listeners) can be
 * split into their own modules without touching the public contract.
 */

import express from 'express';
import http from 'http';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { MongoClient } from 'mongodb';
import amqplib from 'amqplib';
import Joi from 'joi';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/* ------------------------------------------------------------------------ */
/* Configuration                                                            */
/* ------------------------------------------------------------------------ */

const CONFIG = {
  port: process.env.PORT || 4001,
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/paypalsphere',
  mongoDbName: process.env.MONGODB_DB_NAME || 'paypalsphere',
  rabbitmqUri: process.env.RABBITMQ_URI || 'amqp://guest:guest@localhost:5672',
  eventExchangeName: 'accounts.events',
  queueOptions: { durable: true },
  encryptionKey: Buffer.from(
    process.env.ACCOUNTS_AES_KEY || '0123456789abcdef0123456789abcdef', // 32B key
    'hex'
  ),
  encryptionIvLength: 12, // AES-256-GCM IV size
  kycServiceUrl: process.env.KYC_SERVICE_URL || 'http://kyc-service:4002/kyc/run'
};

/* ------------------------------------------------------------------------ */
/* Utility: Field-level Encryption                                          */
/* ------------------------------------------------------------------------ */

/**
 * Encrypts arbitrary text using AES-256-GCM.
 *
 * @param {string} plaintext
 * @returns {{ cipherText: string, iv: string, authTag: string }}
 */
function encryptField(plaintext) {
  const iv = randomBytes(CONFIG.encryptionIvLength);
  const cipher = createCipheriv('aes-256-gcm', CONFIG.encryptionKey, iv);
  const cipherText = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    cipherText: cipherText.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64')
  };
}

/**
 * Decrypts ciphertext encrypted with encryptField.
 *
 * @param {{ cipherText: string, iv: string, authTag: string }} payload
 * @returns {string}
 */
function decryptField({ cipherText, iv, authTag }) {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    CONFIG.encryptionKey,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final()
  ]);
  return plaintext.toString('utf8');
}

/* ------------------------------------------------------------------------ */
/* Mongo Event Store (Simplified)                                           */
/* ------------------------------------------------------------------------ */

class EventStore {
  /**
   * @param {MongoClient} client
   * @param {string} dbName
   */
  constructor(client, dbName) {
    this._db = client.db(dbName);
    this._coll = this._db.collection('account_events');
    // index for aggregateId & sequence
    this._coll.createIndex({ aggregateId: 1, sequence: 1 }, { unique: true }).catch(() => {});
  }

  /**
   * Persists an event atomically.
   *
   * @param {object} event
   * @returns {Promise<void>}
   */
  async append(event) {
    await this._coll.insertOne(event);
  }

  /**
   * Fetches events by aggregate ID, ordered by sequence.
   *
   * @param {string} aggregateId
   * @returns {Promise<Array<object>>}
   */
  async loadByAggregateId(aggregateId) {
    return this._coll.find({ aggregateId }).sort({ sequence: 1 }).toArray();
  }
}

/* ------------------------------------------------------------------------ */
/* RabbitMQ Wrapper                                                         */
/* ------------------------------------------------------------------------ */

class EventBus {
  /**
   * @param {string} uri
   * @param {string} exchange
   */
  constructor(uri, exchange) {
    this._uri = uri;
    this._exchange = exchange;
  }

  async connect() {
    this._conn = await amqplib.connect(this._uri);
    this._channel = await this._conn.createChannel();
    await this._channel.assertExchange(this._exchange, 'fanout', { durable: true });
  }

  /**
   * Publishes an event to the shared exchange.
   *
   * @param {object} event
   * @returns {Promise<void>}
   */
  async publish(event) {
    const payload = Buffer.from(JSON.stringify(event));
    this._channel.publish(this._exchange, '', payload, { persistent: true });
  }

  async close() {
    await this._channel?.close();
    await this._conn?.close();
  }
}

/* ------------------------------------------------------------------------ */
/* Aggregate: Account                                                       */
/* ------------------------------------------------------------------------ */

class Account {
  static create({ email, displayName }) {
    const id = randomUUID();
    const now = new Date().toISOString();
    return {
      aggregateId: id,
      sequence: 1,
      type: 'AccountCreated',
      timestamp: now,
      data: {
        email: encryptField(email), // encrypted at rest
        displayName,
        status: 'PENDING_KYC'
      }
    };
  }

  static emailUpdated({ aggregateId, newEmail, currentSequence }) {
    const now = new Date().toISOString();
    return {
      aggregateId,
      sequence: currentSequence + 1,
      type: 'AccountEmailUpdated',
      timestamp: now,
      data: {
        email: encryptField(newEmail)
      }
    };
  }

  static kycRequested({ aggregateId, currentSequence }) {
    const now = new Date().toISOString();
    return {
      aggregateId,
      sequence: currentSequence + 1,
      type: 'AccountKYCRequested',
      timestamp: now,
      data: {}
    };
  }
}

/* ------------------------------------------------------------------------ */
/* Command Validation Schemas (Joi)                                         */
/* ------------------------------------------------------------------------ */

const Schemas = {
  createAccount: Joi.object({
    email: Joi.string().email().required(),
    displayName: Joi.string().min(2).max(128).required()
  }),

  updateEmail: Joi.object({
    aggregateId: Joi.string()
      .guid({ version: 'uuidv4' })
      .required(),
    email: Joi.string().email().required()
  })
};

/* ------------------------------------------------------------------------ */
/* Command Handler                                                          */
/* ------------------------------------------------------------------------ */

class AccountCommandHandler {
  /**
   * @param {EventStore} store
   * @param {EventBus} bus
   */
  constructor(store, bus) {
    this._store = store;
    this._bus = bus;
  }

  /**
   * Handles 'CreateAccount' intent.
   *
   * @param {object} payload
   * @returns {Promise<object>} – the created event
   */
  async handleCreateAccount(payload) {
    const { error } = Schemas.createAccount.validate(payload);
    if (error) throw new ValidationError(error.message);

    const event = Account.create(payload);
    await this._store.append(event);
    await this._bus.publish(event);

    // Fire-and-forget KYC
    this._dispatchKycRequest(event).catch(console.error);

    return { aggregateId: event.aggregateId };
  }

  /**
   * Handles 'UpdateEmail' intent.
   *
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async handleUpdateEmail(payload) {
    const { error } = Schemas.updateEmail.validate(payload);
    if (error) throw new ValidationError(error.message);

    const history = await this._store.loadByAggregateId(payload.aggregateId);
    if (history.length === 0) throw new NotFoundError('Account not found');

    const lastSeq = history[history.length - 1].sequence;
    const event = Account.emailUpdated({
      aggregateId: payload.aggregateId,
      newEmail: payload.email,
      currentSequence: lastSeq
    });

    await this._store.append(event);
    await this._bus.publish(event);
  }

  /**
   * Triggers KYC request to the external service and commits an
   * 'AccountKYCRequested' event if the request was accepted.
   *
   * @param {object} creationEvent
   * @private
   */
  async _dispatchKycRequest(creationEvent) {
    try {
      const decryptedEmail = decryptField(creationEvent.data.email);
      await axios.post(CONFIG.kycServiceUrl, {
        accountId: creationEvent.aggregateId,
        email: decryptedEmail
      });

      const kycEvent = Account.kycRequested({
        aggregateId: creationEvent.aggregateId,
        currentSequence: creationEvent.sequence
      });
      await this._store.append(kycEvent);
      await this._bus.publish(kycEvent);
    } catch (err) {
      console.error('Failed to dispatch KYC request:', err.message);
      // We deliberately do not propagate the error to the caller
    }
  }
}

/* ------------------------------------------------------------------------ */
/* HTTP API (Express)                                                       */
/* ------------------------------------------------------------------------ */

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health-check endpoint
app.get('/health', (_, res) => res.status(200).send({ status: 'OK' }));

/**
 * POST /accounts
 * Body: { email, displayName }
 */
app.post('/accounts', async (req, res, next) => {
  try {
    const result = await req.ctx.commands.handleCreateAccount(req.body);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /accounts/:id/email
 * Body: { email }
 */
app.patch('/accounts/:id/email', async (req, res, next) => {
  try {
    const payload = {
      aggregateId: req.params.id,
      email: req.body.email
    };
    await req.ctx.commands.handleUpdateEmail(payload);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------------------------------ */
/* Error Handling                                                           */
/* ------------------------------------------------------------------------ */

class ApplicationError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}
class ValidationError extends ApplicationError {
  constructor(message) {
    super(message, 400);
  }
}
class NotFoundError extends ApplicationError {
  constructor(message) {
    super(message, 404);
  }
}

app.use((err, _req, res, _next) => {
  if (err instanceof ApplicationError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Unexpected error' });
});

/* ------------------------------------------------------------------------ */
/* Bootstrap & Graceful Shutdown                                            */
/* ------------------------------------------------------------------------ */

(async () => {
  const mongoClient = new MongoClient(CONFIG.mongodbUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  await mongoClient.connect();

  const eventStore = new EventStore(mongoClient, CONFIG.mongoDbName);
  const eventBus = new EventBus(CONFIG.rabbitmqUri, CONFIG.eventExchangeName);
  await eventBus.connect();

  const commandHandler = new AccountCommandHandler(eventStore, eventBus);

  // Inject per-request context
  app.use((req, _res, next) => {
    req.ctx = { commands: commandHandler };
    next();
  });

  const server = http.createServer(app);

  server.listen(CONFIG.port, () => {
    console.log(`Accounts-Service listening on port ${CONFIG.port}`);
  });

  /* Graceful shutdown */
  const shutdown = async (signal) => {
    console.info(`Received ${signal}. Shutting down...`);
    server.close(async () => {
      await eventBus.close();
      await mongoClient.close();
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('Failed to bootstrap Accounts-Service', err);
  process.exit(1);
});
```