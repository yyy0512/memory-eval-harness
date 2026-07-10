```javascript
/**
 * @file query.controller.js
 * HTTP layer responsible for read-side (query) operations concerning
 * transactions and social payment timelines. All routes are **read-only**
 * and leverage the CQRS read-model stored in MongoDB.
 *
 * Every request propagates a correlation-id for observability and pushes an
 * `access_log` event to the Audit Trail service for compliance purposes.
 */

'use strict';

const { Router }                 = require('express');
const httpStatus                 = require('http-status-codes');
const createError                = require('http-errors');
const asyncHandler               = require('express-async-handler');
const { validate }               = require('express-validation');

const authMiddleware             = require('../middlewares/auth.middleware');
const correlationIdMiddleware    = require('../middlewares/correlation-id.middleware');
const auditTrailProducer         = require('../messaging/audit-trail.producer');
const TransactionQueryService    = require('../services/transaction-query.service');
const {
  getTransactionSchema,
  getUserFeedSchema,
  getCircleLedgerSchema,
} = require('../validators/query.validation');

const router = Router();

/**
 * GET /v1/transactions/:transactionId
 * Returns a single transaction projection including privacy-aware
 * metadata for the requesting principal.
 */
router.get(
  '/v1/transactions/:transactionId',
  correlationIdMiddleware(),                 // Must be first so downstream logs contain id
  authMiddleware(),                          // JWT / API key verification
  validate(getTransactionSchema, { keyByField: true }),
  asyncHandler(async (req, res) => {
    const { transactionId } = req.params;
    const principal         = req.user;      // hydrated by auth middleware

    const projection = await TransactionQueryService.getById({
      transactionId,
      principal,
    });

    if (!projection) {
      /* The user is either requesting a non-existent transaction or
       * one they do not have permission to view. We deliberately
       * return the same 404 to prevent enumeration (Security by Design).
       */
      throw createError.NotFound('Transaction not found');
    }

    // Attach strong validation-token for client-side cache revalidation
    res.set('ETag', projection.etag);
    res.set('Last-Modified', new Date(projection.updatedAt).toUTCString());

    // Fire-and-forget audit trail
    auditTrailProducer.publishAccessLog({
      principalId   : principal.id,
      action        : 'READ_TRANSACTION',
      resourceId    : projection.id,
      correlationId : req.correlationId,
    });

    return res.status(httpStatus.OK).json({ data: projection });
  })
);

/**
 * GET /v1/users/:userId/feed
 * Returns the public/private hybrid timeline for a given user.
 * The caller must be either the user themselves or a member within
 * visibility scope according to the Social-Graph service.
 */
router.get(
  '/v1/users/:userId/feed',
  correlationIdMiddleware(),
  authMiddleware(),
  validate(getUserFeedSchema, { keyByField: true }),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { limit, cursor } = req.query;
    const principal  = req.user;

    const page = await TransactionQueryService.getUserFeed({
      userId,
      limit,
      cursor,
      principal,
    });

    auditTrailProducer.publishAccessLog({
      principalId   : principal.id,
      action        : 'READ_USER_FEED',
      resourceId    : userId,
      correlationId : req.correlationId,
    });

    res
      .status(httpStatus.OK)
      .json({
        data        : page.items,
        pageInfo    : page.pageInfo,
      });
  })
);

/**
 * GET /v1/circles/:circleId/ledger
 * Provides a roll-up of financial commitments, paid and outstanding,
 * for a given circle over a date window.
 */
router.get(
  '/v1/circles/:circleId/ledger',
  correlationIdMiddleware(),
  authMiddleware(),
  validate(getCircleLedgerSchema, { keyByField: true }),
  asyncHandler(async (req, res) => {
    const { circleId }             = req.params;
    const { fromDate, toDate }     = req.query;
    const principal                = req.user;

    // RBAC check occurs in service layer; query side only needs principal context
    const ledger = await TransactionQueryService.getCircleLedger({
      circleId,
      fromDate,
      toDate,
      principal,
    });

    if (!ledger) {
      throw createError.NotFound('Circle not found or inaccessible');
    }

    auditTrailProducer.publishAccessLog({
      principalId   : principal.id,
      action        : 'READ_CIRCLE_LEDGER',
      resourceId    : circleId,
      correlationId : req.correlationId,
    });

    res.status(httpStatus.OK).json({ data: ledger });
  })
);

module.exports = router;
```