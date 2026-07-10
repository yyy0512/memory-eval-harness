```javascript
/**
 * PayPalsphere – Notification Service
 * -----------------------------------
 * Responsible for:
 *  – Consuming domain-events from the Event-Bus (RabbitMQ)
 *  – Persisting user-facing notifications
 *  – Exposing a REST API for clients to fetch / update notifications
 *
 * Architectural notes:
 *  – Designed as a stateless micro-service; all state is in MongoDB
 *  – Consumes immutable events emitted by other bounded-contexts
 *  – Emits its own domain-events for audit-trail / projection pipelines
 *
 * Author: PayPalsphere Engineering
 */

'use strict';

require('dotenv').config();

const express           = require('express');
const helmet            = require('helmet');
const bodyParser        = require('body-parser');
const mongoose          = require('mongoose');
const amqplib           = require('amqplib');
const { v4: uuid }      = require('uuid');
const winston           = require('winston');
const morgan            = require('morgan');

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
const CONFIG = Object.freeze({
  PORT                 : process.env.PORT               || 4006,
  MONGO_URI            : process.env.MONGO_URI          || 'mongodb://localhost:27017/notifications',
  RABBITMQ_URI         : process.env.RABBITMQ_URI       || 'amqp://localhost',
  RABBITMQ_EXCHANGE    : process.env.RABBITMQ_EXCHANGE  || 'paypalsphere.events',
  NOTIFICATION_QUEUE   : process.env.NOTIFICATION_QUEUE || 'notification.service.queue',
  LOG_LEVEL            : process.env.LOG_LEVEL          || 'info'
});

// -----------------------------------------------------------------------------
// Logger
// -----------------------------------------------------------------------------
const logger = winston.createLogger({
  level   : CONFIG.LOG_LEVEL,
  format  : winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

// -----------------------------------------------------------------------------
// MongoDB (Mongoose) Setup
// -----------------------------------------------------------------------------
mongoose.connect(CONFIG.MONGO_URI, {
  useNewUrlParser   : true,
  useUnifiedTopology: true
}).then(() => {
  logger.info('MongoDB connected');
}).catch(err => {
  logger.error('MongoDB connection error', { err });
  process.exit(1);
});

// Notification Schema
const notificationSchema = new mongoose.Schema({
  _id       : { type: String, default: uuid },
  userId    : { type: String, index: true, required: true },
  type      : { type: String, required: true },    // e.g. PAYMENT_INITIATED
  payload   : { type: Object, default: {} },       // additional context
  read      : { type: Boolean, default: false },
  createdAt : { type: Date, default: () => new Date() }
}, { versionKey: false });

const Notification = mongoose.model('Notification', notificationSchema);

// -----------------------------------------------------------------------------
// Event Bus (RabbitMQ) Consumer
// -----------------------------------------------------------------------------
/**
 * Translates a domain-event to a user-facing notification.
 * Extend this map as new domain-events are introduced.
 */
function domainEventToNotification(evt) {
  const { type, data } = evt;

  switch (type) {
    case 'PaymentInitiated':
      return {
        userId : data.recipientId,
        type   : 'PAYMENT_INITIATED',
        payload: {
          amount     : data.amount,
          currency   : data.currency,
          senderId   : data.senderId,
          circleId   : data.circleId
        }
      };

    case 'PaymentSettled':
      return {
        userId : data.payerId,
        type   : 'PAYMENT_SETTLED',
        payload: {
          amount     : data.amount,
          currency   : data.currency,
          payeeId    : data.payeeId,
          circleId   : data.circleId
        }
      };

    case 'KYCVerified':
      return {
        userId : data.userId,
        type   : 'KYC_VERIFIED',
        payload: {}
      };

    case 'RiskAlert':
      return {
        userId : data.userId,
        type   : 'RISK_ALERT',
        payload: {
          severity : data.severity,
          reason   : data.reason
        }
      };

    default:
      return null; // Unknown / non-user-facing event
  }
}

async function initEventConsumer() {
  const connection = await amqplib.connect(CONFIG.RABBITMQ_URI);
  const channel    = await connection.createChannel();

  await channel.assertExchange(CONFIG.RABBITMQ_EXCHANGE, 'topic', { durable: true });
  const { queue } = await channel.assertQueue(CONFIG.NOTIFICATION_QUEUE, { durable: true });

  // Bind to all events (*) – could be limited to only relevant routing keys
  await channel.bindQueue(queue, CONFIG.RABBITMQ_EXCHANGE, '#');

  channel.consume(queue, async msg => {
    if (!msg) return;
    try {
      const evt = JSON.parse(msg.content.toString());
      logger.debug('Domain-event received', { evt });

      const notif = domainEventToNotification(evt);
      if (notif) {
        await Notification.create(notif);
        logger.info('Notification created', { userId: notif.userId, type: notif.type });
      } else {
        logger.debug('Event ignored (no notification mapping)', { evtType: evt.type });
      }

      channel.ack(msg);
    } catch (err) {
      logger.error('Failed to process domain-event', { err });
      channel.nack(msg, false, false); // Drop or send to DLQ in production
    }
  });

  logger.info('RabbitMQ consumer started');
}

// -----------------------------------------------------------------------------
// Express REST API
// -----------------------------------------------------------------------------
const app = express();
app.use(helmet());
app.use(bodyParser.json());
app.use(morgan('combined', { stream: { write: msg => logger.http(msg.trim()) } }));

/**
 * GET /health
 * Simple health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /users/:userId/notifications
 * Fetch notifications for a user.
 * Query params:
 *    – unread=true   => only unread
 *    – limit=n       => page size (default 50)
 */
app.get('/users/:userId/notifications', async (req, res) => {
  const { userId } = req.params;
  const { unread, limit = 50 } = req.query;

  try {
    const query = { userId };
    if (unread === 'true') query.read = false;

    const notifications = await Notification
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit), 100));

    res.json(notifications);
  } catch (err) {
    logger.error('Failed to fetch notifications', { err });
    res.status(500).json({ error: 'internal_error' });
  }
});

/**
 * POST /users/:userId/notifications/:notifId/read
 * Mark a notification as read.
 */
app.post('/users/:userId/notifications/:notifId/read', async (req, res) => {
  const { userId, notifId } = req.params;

  try {
    const result = await Notification.updateOne(
      { _id: notifId, userId },
      { $set: { read: true } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'notification_not_found' });
    }

    res.json({ status: 'updated' });
  } catch (err) {
    logger.error('Failed to mark notification read', { err });
    res.status(500).json({ error: 'internal_error' });
  }
});

// -----------------------------------------------------------------------------
// Startup & Graceful-Shutdown
// -----------------------------------------------------------------------------
const server = app.listen(CONFIG.PORT, () => {
  logger.info(`Notification-Service listening on port ${CONFIG.PORT}`);
  initEventConsumer().catch(err => {
    logger.error('Failed to initialize event consumer', { err });
    process.exit(1);
  });
});

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down...`);
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  } catch (err) {
    logger.warn('Error during MongoDB disconnect', { err });
  }

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force-exit after 10s
  setTimeout(() => {
    logger.error('Force exiting after graceful shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => {
  process.on(sig, () => shutdown(sig));
});
```