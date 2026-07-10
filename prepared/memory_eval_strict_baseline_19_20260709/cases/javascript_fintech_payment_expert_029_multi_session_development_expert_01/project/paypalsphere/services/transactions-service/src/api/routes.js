```javascript
/**
 * PayPalsphere – Transactions Service
 * File: services/transactions-service/src/api/routes.js
 *
 * Centralised definition of HTTP routes exposed by the Transactions
 * micro-service.  Each endpoint delegates intent to a CommandBus or
 * QueryBus in alignment with CQRS.  Business validation (KYC, risk,
 * compliance) is handled by domain-specific command handlers and sagas,
 * keeping the route layer focused on transport-level concerns only.
 *
 * NOTE: In production this file would be tree-shaken and compiled by
 * Babel/TS with explicit typings.  For brevity, plain ES-modules are
 * transpiled by Node (>18) at runtime.
 */

"use strict";

import express from "express";
import { celebrate, Joi, Segments, errors as celebrateErrors } from "celebrate";
import createError from "http-errors";

import logger from "../utils/logger.js";
import CommandBus from "../cqrs/command-bus.js";
import QueryBus from "../cqrs/query-bus.js";
import { encryptPayload } from "../security/encryption.js";
import requiresAuth from "../middleware/auth.js";
import hasRole from "../middleware/roles.js";
import attachRequestId from "../middleware/request-id.js";

import CreateTransactionCommand from "../domain/commands/create-transaction.command.js";
import RefundTransactionCommand from "../domain/commands/refund-transaction.command.js";
import FindTransactionQuery from "../domain/queries/find-transaction.query.js";
import ListCircleTransactionsQuery from "../domain/queries/list-circle-transactions.query.js";

const router = express.Router();

/**
 * Small helper to bubble async/await errors to the
 * centralised error-handling middleware stack.
 */
const wrapAsync =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// --- Global middleware ---------------------------------------------------- //
router.use(attachRequestId); // attaches X-Request-Id header to every response
router.use(requiresAuth); // validates JWT + session cookies

// --- Validators ----------------------------------------------------------- //

const moneySchema = Joi.object({
  amount: Joi.number().positive().precision(2).required(),
  currency: Joi.string().uppercase().length(3).required(),
}).required();

const transactionBodySchema = {
  [Segments.BODY]: Joi.object({
    fromAccountId: Joi.string().uuid().required(),
    toAccountId: Joi.string().uuid().required(),
    circleId: Joi.string().uuid().optional().allow(null),
    narrative: Joi.string().max(280).optional().allow(""),
    money: moneySchema,
    metadata: Joi.object().unknown(true).optional(), // arbitrary social tags
  }).required(),
};

const paginationQuerySchema = {
  [Segments.QUERY]: Joi.object({
    after: Joi.string().uuid().optional(),
    limit: Joi.number().integer().min(1).max(100).default(25),
  }),
};

// --- Routes ---------------------------------------------------------------- //

/**
 * POST /transactions
 * Creates a brand-new payment transaction.  A KYC / Risk saga will be
 * triggered downstream by the command handler.  The client receives an
 * immediate 202 Accepted with the aggregateId for polling / SSE updates.
 */
router.post(
  "/transactions",
  hasRole("USER"), // can also be ADMIN, SERVICE
  celebrate(transactionBodySchema),
  wrapAsync(async (req, res) => {
    const {
      fromAccountId,
      toAccountId,
      circleId,
      narrative,
      money,
      metadata,
    } = req.body;

    const command = new CreateTransactionCommand({
      initiatedBy: req.user.id,
      fromAccountId,
      toAccountId,
      circleId,
      narrative,
      money,
      metadata,
      requestId: req.id,
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    // Encrypt personally-identifiable metadata before shipping to bus
    command.secureContext = encryptPayload({
      fromAccountId,
      toAccountId,
      initiatedBy: req.user.id,
    });

    const aggregateId = await CommandBus.dispatch(command);

    logger.info(
      { aggregateId, command: "CreateTransaction", reqId: req.id },
      "CreateTransactionCommand dispatched"
    );

    res.status(202).json({
      status: "accepted",
      transactionId: aggregateId,
    });
  })
);

/**
 * POST /transactions/:id/refund
 * Issues a refund request for a given transaction.
 */
router.post(
  "/transactions/:id/refund",
  hasRole("USER"),
  celebrate({
    [Segments.PARAMS]: Joi.object({
      id: Joi.string().uuid().required(),
    }),
  }),
  wrapAsync(async (req, res) => {
    const { id } = req.params;

    const command = new RefundTransactionCommand({
      transactionId: id,
      initiatedBy: req.user.id,
      requestId: req.id,
    });

    await CommandBus.dispatch(command);

    res.status(202).json({
      status: "accepted",
      refundFor: id,
    });
  })
);

/**
 * GET /transactions/:id
 * Materialised view read side.  Strongly-consistent because the read
 * model is eventually consistent; streaming replication latency <100ms.
 */
router.get(
  "/transactions/:id",
  hasRole("USER"),
  celebrate({
    [Segments.PARAMS]: Joi.object({
      id: Joi.string().uuid().required(),
    }),
  }),
  wrapAsync(async (req, res, next) => {
    const { id } = req.params;

    const query = new FindTransactionQuery({
      transactionId: id,
      requestId: req.id,
    });

    const dto = await QueryBus.execute(query);

    if (!dto) {
      return next(createError(404, "Transaction not found"));
    }

    res.json(dto);
  })
);

/**
 * GET /circles/:circleId/transactions
 * Paginates over a circle’s social payment timeline.
 */
router.get(
  "/circles/:circleId/transactions",
  hasRole("USER"),
  celebrate({
    [Segments.PARAMS]: Joi.object({
      circleId: Joi.string().uuid().required(),
    }),
    ...paginationQuerySchema,
  }),
  wrapAsync(async (req, res) => {
    const { circleId } = req.params;
    const { after, limit } = req.query;

    const query = new ListCircleTransactionsQuery({
      circleId,
      pagination: { after, limit },
      requestId: req.id,
    });

    const page = await QueryBus.execute(query);

    res.json(page);
  })
);

// --- Error handling (validation) ------------------------------------------ //
router.use(celebrateErrors());

// --- Fallback 404 ---------------------------------------------------------- //
router.use((req, _res, next) => {
  next(createError(404, "Endpoint does not exist"));
});

export default router;
```

