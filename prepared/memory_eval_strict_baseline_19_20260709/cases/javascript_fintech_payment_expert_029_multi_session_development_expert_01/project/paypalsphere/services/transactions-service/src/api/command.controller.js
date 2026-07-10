```javascript
/**
 * paypalsphere/services/transactions-service/src/api/command.controller.js
 *
 * Command-side HTTP controller for the Transactions bounded-context.
 * Translates imperative HTTP requests into domain commands that are dispatched
 * through the CommandBus. All write-side interactions with the aggregate root
 * (Transaction) should go through this controller.
 *
 * Architectural cross-cutting concerns addressed:
 *  • Security-by-Design (RBAC, field-level encryption stubs, idempotency keys)
 *  • Observability (correlation-id, structured logging, basic metrics)
 *  • CQRS – isolates mutations from read projections
 *
 * NOTE: This file purposefully does not expose read endpoints. Those belong to
 *       the query controller/projection gateway in accordance with CQRS.
 */

'use strict';

/* ────────────────────────────────────────────────────────────────────────── *\
 * External dependencies
\* ────────────────────────────────────────────────────────────────────────── */
const express = require('express');
const createError = require('http-errors');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

/* ────────────────────────────────────────────────────────────────────────── *\
 * Internal, domain-level dependencies
\* ────────────────────────────────────────────────────────────────────────── */
const {
  TransactionCreateCommand,
  TransactionCancelCommand,
  TransactionSplitCommand,
} = require('../domain/commands');
const CommandBus = require('../core/command-bus');
const { transactionCreateSchema, transactionSplitSchema } = require('../schemas/transaction-schemas');
const { validateBody } = require('../middleware/validate-body');
const logger = require('../utils/logger');
const { encryptPayload } = require('../utils/encryption');
const { requireScope } = require('../middleware/authorization');
const metrics = require('../utils/metrics');

/* ────────────────────────────────────────────────────────────────────────── *\
 * Constants & Configuration
\* ────────────────────────────────────────────────────────────────────────── */
const router = express.Router({ mergeParams: true });
const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // per minute
const RATE_LIMIT_MAX_REQUESTS = 120;

/* ────────────────────────────────────────────────────────────────────────── *\
 * Middleware stack
\* ────────────────────────────────────────────────────────────────────────── */

router.use(
  rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS,
    handler: () => createError(429, 'Too many requests to command API'),
  }),
);

/**
 * Injects/creates a correlation-id header for distributed tracing.
 */
router.use((req, _res, next) => {
  req.correlationId = req.get('X-Correlation-Id') || uuidv4();
  next();
});

/* ────────────────────────────────────────────────────────────────────────── *\
 * Helper functions
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * Returns a valid idempotency key for safe-retry semantics.
 * Falls back to a random UUID if client omitted the header.
 */
const getIdempotencyKey = (req) => req.get('Idempotency-Key') || uuidv4();

/**
 * Generic response shape for async command dispatching. Always HTTP 202.
 */
const acknowledge = (res, { commandId }) =>
  res.status(202).json({
    status: 'accepted',
    commandId,
  });

/* ────────────────────────────────────────────────────────────────────────── *\
 * Route definitions
\* ────────────────────────────────────────────────────────────────────────── */

/**
 * POST /api/v1/transactions
 * Creates a new social transaction (payment, charge-request, pledge, etc.).
 */
router.post(
  '/transactions',
  requireScope('transactions:create'),
  validateBody(transactionCreateSchema),
  asyncHandler(async (req, res) => {
    const idempotencyKey = getIdempotencyKey(req);
    const {
      body: { amount, currency, note, receivers, metadata },
      auth: { userId },
    } = req; // auth is injected upstream by gateway or auth-middleware

    const encryptedNote = encryptPayload(note); // field-level encryption stub

    const command = new TransactionCreateCommand({
      aggregateId: uuidv4(),
      payload: {
        initiatorId: userId,
        amount,
        currency,
        note: encryptedNote,
        receivers,
        metadata,
      },
      meta: {
        idempotencyKey,
        correlationId: req.correlationId,
        issuedAt: new Date().toISOString(),
      },
    });

    const start = Date.now();
    await CommandBus.dispatch(command);
    const elapsed = Date.now() - start;

    metrics.histogram('command_dispatch_duration_ms', elapsed, {
      command: 'TransactionCreateCommand',
    });

    logger.info(
      {
        commandId: command.id,
        initiatorId: userId,
        correlationId: req.correlationId,
      },
      'TransactionCreateCommand dispatched',
    );

    return acknowledge(res, { commandId: command.id });
  }),
);

/**
 * POST /api/v1/transactions/:transactionId/cancel
 * Sends a cancellation intent for a pending transaction.
 */
router.post(
  '/transactions/:transactionId/cancel',
  requireScope('transactions:cancel'),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;
    if (!transactionId) {
      throw createError(400, 'transactionId param is required');
    }

    const idempotencyKey = getIdempotencyKey(req);
    const {
      body: { reason },
      auth: { userId },
    } = req;

    const command = new TransactionCancelCommand({
      aggregateId: transactionId,
      payload: {
        requestedBy: userId,
        reason,
      },
      meta: {
        idempotencyKey,
        correlationId: req.correlationId,
        issuedAt: new Date().toISOString(),
      },
    });

    await CommandBus.dispatch(command);

    logger.warn(
      {
        commandId: command.id,
        transactionId,
        correlationId: req.correlationId,
      },
      'TransactionCancelCommand dispatched',
    );

    return acknowledge(res, { commandId: command.id });
  }),
);

/**
 * POST /api/v1/transactions/:transactionId/split
 * Adds members or updates ratio for a group split.
 */
router.post(
  '/transactions/:transactionId/split',
  requireScope('transactions:split'),
  validateBody(transactionSplitSchema),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;
    const idempotencyKey = getIdempotencyKey(req);
    const {
      body: { splits },
      auth: { userId },
    } = req;

    const command = new TransactionSplitCommand({
      aggregateId: transactionId,
      payload: {
        requestedBy: userId,
        splits, // e.g., [{ userId, ratio }]
      },
      meta: {
        idempotencyKey,
        correlationId: req.correlationId,
        issuedAt: new Date().toISOString(),
      },
    });

    await CommandBus.dispatch(command);

    logger.info(
      {
        commandId: command.id,
        transactionId,
        correlationId: req.correlationId,
      },
      'TransactionSplitCommand dispatched',
    );

    return acknowledge(res, { commandId: command.id });
  }),
);

/* ────────────────────────────────────────────────────────────────────────── *\
 * Error Handling (leaf-node, bubbles up to global handler)
\* ────────────────────────────────────────────────────────────────────────── */

router.use((err, _req, _res, next) => {
  // Convert non-http-errors (thrown from command handlers) to 500s
  if (!createError.isHttpError(err)) {
    logger.error({ err }, 'Unhandled command controller error');
    return next(createError(500, 'Internal command processing error'));
  }
  return next(err);
});

module.exports = router;
```