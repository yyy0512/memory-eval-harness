```javascript
/**
 * PayPalsphere – Transactions Service (CQRS + Event-Sourcing boundary)
 *
 * Entry point for the Transactions micro-service. Exposes a small façade for
 * command/query APIs, publishes domain events to the event-bus, listens for
 * saga callbacks, and persists events in an append-only EventStore.
 *
 * NOTE:  In production this project is split across multiple files/packages,
 *        but collapsed here for brevity.
 */

require('dotenv').config();

const express           = require('express');
const http              = require('http');
const { v4: uuid }      = require('uuid');
const crypto            = require('crypto');
const amqplib           = require('amqplib');
const { Pool }          = require('pg');
const winston           = require('winston');
const Ajv               = require('ajv').default;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  serviceName : 'transactions-service',
  port        : process.env.PORT               || 4003,
  nodeEnv     : process.env.NODE_ENV           || 'development',
  pg: {
    connectionString: process.env.EVENTSTORE_DSN
                      || 'postgres://postgres:postgres@localhost:5432/paypalsphere'
  },
  amqp: {
    url: process.env.AMQP_URL || 'amqp://guest:guest@localhost:5672'
  },
  encryption: {
    algo : 'aes-256-gcm',
    key  : Buffer.from(process.env.FIELD_LEVEL_KEY || crypto.randomBytes(32), 'utf8'),
    ivLen: 16
  }
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = winston.createLogger({
  level   : CONFIG.nodeEnv === 'production' ? 'info' : 'debug',
  format  : winston.format.combine(
              winston.format.timestamp(),
              winston.format.printf(({ level, message, timestamp, ...meta }) => {
                return `${timestamp} [${level.toUpperCase()}]: ${message} ${
                  Object.keys(meta).length ? JSON.stringify(meta) : ''
                }`;
              })
            ),
  transports: [new winston.transports.Console()]
});

// ---------------------------------------------------------------------------
// Utilities – Encryption helpers  (Security-by-Design)
// ---------------------------------------------------------------------------

function encryptField(plainText) {
  const iv  = crypto.randomBytes(CONFIG.encryption.ivLen);
  const cipher = crypto.createCipheriv(CONFIG.encryption.algo, CONFIG.encryption.key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptField(cipherText) {
  const [ivHex, tagHex, dataHex] = cipherText.split(':');
  const decipher = crypto.createDecipheriv(
    CONFIG.encryption.algo,
    CONFIG.encryption.key,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// EventStore (simplified) – append-only table "events"
// ---------------------------------------------------------------------------

class EventStore {
  constructor(pool) { this.pool = pool; }

  async append(event) {
    const { id, type, payload, metadata, timestamp } = event;
    const text = `INSERT INTO events(id, type, payload, metadata, timestamp)
                  VALUES ($1, $2, $3, $4, $5)`;
    await this.pool.query(text, [
      id, type, JSON.stringify(payload), JSON.stringify(metadata), timestamp
    ]);
    return event;
  }

  async loadStream(aggregateId) {
    const res = await this.pool.query(
      'SELECT * FROM events WHERE metadata->>\'aggregateId\' = $1 ORDER BY timestamp ASC',
      [aggregateId]
    );
    return res.rows;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id        UUID PRIMARY KEY,
        type      VARCHAR(255) NOT NULL,
        payload   JSONB NOT NULL,
        metadata  JSONB NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_aggregate
        ON events ((metadata->>'aggregateId'));
    `);
    logger.info('EventStore ready');
  }
}

// ---------------------------------------------------------------------------
// EventBus – simple wrapper around RabbitMQ (AMQP)
// ---------------------------------------------------------------------------

class EventBus {
  constructor(url) { this.url = url; }

  async connect() {
    this.conn = await amqplib.connect(this.url);
    this.channel = await this.conn.createChannel();
    await this.channel.assertExchange('domain-events', 'topic', { durable: true });
    logger.info('Connected to AMQP broker');
  }

  publish(event) {
    const routingKey = `${event.type}`;
    this.channel.publish(
      'domain-events',
      routingKey,
      Buffer.from(JSON.stringify(event)),
      { persistent: true }
    );
    logger.debug(`Published event`, { routingKey, id: event.id });
  }

  async subscribe(bindingKeys, onMessage) {
    const q = await this.channel.assertQueue('', { exclusive: true });
    for (const key of bindingKeys) {
      await this.channel.bindQueue(q.queue, 'domain-events', key);
    }
    this.channel.consume(q.queue, async msg => {
      if (!msg) return;
      try {
        const event = JSON.parse(msg.content.toString());
        await onMessage(event);
        this.channel.ack(msg);
      } catch (e) {
        logger.error('Error handling event', { err: e });
        this.channel.nack(msg, false, false); // dead-letter
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Domain  – Commands & Aggregates (simplified, within single file)
// ---------------------------------------------------------------------------

class TransactionAggregate {
  constructor(id) {
    this.id          = id || uuid();
    this.version     = 0;
    this.state       = 'NEW';
    this.totalAmount = 0;
    this.currency    = 'USD';
    this.payerId     = null;
    this.payeeId     = null;
    this.events      = [];
  }

  static create({ payerId, payeeId, amount, currency }) {
    const agg = new TransactionAggregate();
    const event = {
      id   : uuid(),
      type : 'TransactionCreated',
      payload : {
        amount, currency,
        payerId, payeeId
      },
      metadata : {
        aggregateId: agg.id,
        version    : agg.version + 1
      },
      timestamp: new Date().toISOString()
    };
    agg.apply(event);
    return agg;
  }

  apply(event) {
    switch (event.type) {
      case 'TransactionCreated':
        this.state       = 'PENDING_KYC';
        this.totalAmount = event.payload.amount;
        this.currency    = event.payload.currency;
        this.payerId     = event.payload.payerId;
        this.payeeId     = event.payload.payeeId;
        break;

      case 'TransactionSettled':
        this.state = 'SETTLED';
        break;

      case 'TransactionDeclined':
        this.state = 'DECLINED';
        break;

      default:
        throw new Error(`Unknown event ${event.type}`);
    }
    this.version = event.metadata.version;
    this.events.push(event);
  }
}

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

const ajv = new Ajv({ coerceTypes: true, removeAdditional: 'all' });

const createTxSchema = {
  type: 'object',
  required: ['payerId', 'payeeId', 'amount', 'currency'],
  properties: {
    payerId : { type: 'string', minLength: 1 },
    payeeId : { type: 'string', minLength: 1 },
    amount  : { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    note    : { type: 'string', maxLength: 255 }
  }
};

const validateCreateTx = ajv.compile(createTxSchema);

// ---------------------------------------------------------------------------
// Outbound Integrations (Risk, KYC, Compliance) – simplified HTTP mocks
// ---------------------------------------------------------------------------

async function callRiskEngine(tx) {
  // In real life, RPC/HTTP or queue integration
  logger.debug('Calling risk engine');
  // Fake risk score
  return { score: Math.random() * 100, flagged: false };
}

async function requestKYCVerification(userId) {
  logger.debug('Dispatching KYC verification');
  // Fake KYC job id
  return { kycJobId: uuid(), status: 'PENDING' };
}

async function reportCompliance(event) {
  logger.debug('Reporting to compliance service', { eventType: event.type });
}

// ---------------------------------------------------------------------------
// HTTP API (Command / Query façade)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// ------- Commands ----------------------------------------------------------

app.post('/transactions', async (req, res) => {
  if (!validateCreateTx(req.body)) {
    return res.status(400).json({ error: ajv.errorsText(validateCreateTx.errors) });
  }

  try {
    const { payerId, payeeId, amount, currency, note } = req.body;

    // field-level encryption for note
    const encryptedNote = note ? encryptField(note) : null;

    // Aggregate & initial Domain Event
    const txAggregate = TransactionAggregate.create({
      payerId, payeeId, amount, currency
    });

    if (encryptedNote) {
      txAggregate.events[0].payload.encryptedNote = encryptedNote;
    }

    // Side-effects (run in parallel, but we need their results)
    const [ risk, kyc ] = await Promise.all([
      callRiskEngine(txAggregate),
      requestKYCVerification(payerId)
    ]);

    txAggregate.events[0].metadata.risk  = risk;
    txAggregate.events[0].metadata.kyc   = kyc;
    txAggregate.events[0].metadata.note  = encryptedNote && 'ENCRYPTED';

    // Persist & Publish
    await eventStore.append(txAggregate.events[0]);
    eventBus.publish(txAggregate.events[0]);

    res.status(202).json({ id: txAggregate.id, state: txAggregate.state });
  } catch (err) {
    logger.error('Unable to create transaction', { err });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ------- Queries -----------------------------------------------------------

app.get('/transactions/:id', async (req, res) => {
  try {
    const stream = await eventStore.loadStream(req.params.id);
    if (!stream.length) {
      return res.status(404).json({ error: 'Not Found' });
    }
    // Rehydrate aggregate from events
    const tx = new TransactionAggregate(req.params.id);
    stream.forEach(e => tx.apply(e));

    res.json({
      id     : tx.id,
      state  : tx.state,
      amount : tx.totalAmount,
      currency: tx.currency,
      payerId: tx.payerId,
      payeeId: tx.payeeId,
      version: tx.version
    });
  } catch (err) {
    logger.error('Failed to fetch transaction', { err });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ---------------------------------------------------------------------------
// Saga Listener  (Settlement / Decline)  – reacts to upstream events
// ---------------------------------------------------------------------------

async function handleSettlementSaga(event) {
  try {
    switch (event.type) {
      case 'KycVerificationCompleted': {
        // Only care if success
        if (event.payload.status !== 'PASSED') return;
        const txId = event.payload.metadata.aggregateId;

        // Create Settlement event
        const settlementEvent = {
          id   : uuid(),
          type : 'TransactionSettled',
          payload: {
            settlementId: uuid(),
            settledAt  : new Date().toISOString()
          },
          metadata: {
            aggregateId: txId,
            version    : event.metadata.version + 1
          },
          timestamp: new Date().toISOString()
        };
        await eventStore.append(settlementEvent);
        eventBus.publish(settlementEvent);
        await reportCompliance(settlementEvent);
        break;
      }
      case 'RiskFlagged': {
        const txId = event.payload.aggregateId;

        const declineEvent = {
          id: uuid(),
          type: 'TransactionDeclined',
          payload: { reason: event.payload.reason },
          metadata: {
            aggregateId: txId,
            version: event.metadata.version + 1
          },
          timestamp: new Date().toISOString()
        };
        await eventStore.append(declineEvent);
        eventBus.publish(declineEvent);
        await reportCompliance(declineEvent);
        break;
      }
      default:
        // ignore
    }
  } catch (err) {
    logger.error('Error in settlement saga', { err });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const pool     = new Pool(CONFIG.pg);
const eventStore = new EventStore(pool);
const eventBus   = new EventBus(CONFIG.amqp.url);

(async () => {
  try {
    await eventStore.init();
    await eventBus.connect();

    // Subscribe to saga events
    await eventBus.subscribe(
      ['KycVerificationCompleted', 'RiskFlagged'],
      handleSettlementSaga
    );

    // HTTP server
    const server = http.createServer(app);
    server.listen(CONFIG.port, () => {
      logger.info(`${CONFIG.serviceName} listening on ${CONFIG.port}`);
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Graceful shutdown');
      await eventBus.conn.close();
      await pool.end();
      server.close(err => {
        process.exit(err ? 1 : 0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    logger.error('Failed to bootstrap service', { err });
    process.exit(1);
  }
})();
```