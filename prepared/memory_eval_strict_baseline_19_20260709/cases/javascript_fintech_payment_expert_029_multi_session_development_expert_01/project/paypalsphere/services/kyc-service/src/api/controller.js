```javascript
/**
 * PayPalsphere – KYC Service
 * File: services/kyc-service/src/api/controller.js
 *
 * REST controller exposing KYC-related capabilities.
 * Routes are mounted under `/v1/kyc`.
 *
 * Responsibilities:
 *  • Orchestrate request validation & response shaping.
 *  • Delegate domain logic to the KycService layer.
 *  • Emit domain events to the EventBus for eventual consistency
 *    (Risk, Compliance, AuditTrail, Notifications, etc.).
 *  • Enforce Security-by-Design best-practices: field-level encryption
 *    (handled by KycService), correlation-id propagation, structured logs.
 */

'use strict';

/* ───────────────────────────────────────  Node / 3rd-party Deps ───────────── */
const express           = require('express');
const httpStatus        = require('http-status');
const Joi               = require('joi');
const { v4: uuidv4 }    = require('uuid');

/* ─────────────────────────────────────────────  Internal Deps ─────────────── */
const KycService        = require('../domain/kyc.service');
const EventBus          = require('../infra/event-bus');
const logger            = require('../infra/logger');
const { ApiError }      = require('../common/errors');

/* ───────────────────────────────────────────  Router & Middleware ─────────── */
const router = express.Router();

/**
 * Middleware: Propagate/Generate a correlation-id for end-to-end tracing.
 */
router.use((req, res, next) => {
  const incomingId = req.header('x-correlation-id');
  const correlationId = incomingId || uuidv4();

  req.correlationId = correlationId;
  res.setHeader('x-correlation-id', correlationId);

  logger.addContext({ correlationId });
  next();
});

/* ─────────────────────────────────────────────  Validation Schemas ────────── */
const kycSubmissionSchema = Joi.object({
  userId:        Joi.string().uuid({ version: 'uuidv4' }).required(),
  firstName:     Joi.string().max(100).required(),
  lastName:      Joi.string().max(100).required(),
  dob:           Joi.date().iso().required().less('now'),
  address:       Joi.object({
    line1:     Joi.string().max(255).required(),
    line2:     Joi.string().max(255).allow(''),
    city:      Joi.string().max(100).required(),
    state:     Joi.string().max(100).required(),
    postal:    Joi.string().max(20).required(),
    country:   Joi.string().length(2).required()
  }).required(),
  document:      Joi.object({
    type:       Joi.string().valid('PASSPORT', 'NATIONAL_ID', 'DRIVER_LICENSE').required(),
    number:     Joi.string().max(50).required(),
    issuedAt:   Joi.date().iso().required(),
    expiresAt:  Joi.date().iso().required()
  }).required()
}).required();

const statusQuerySchema = Joi.object({
  userId: Joi.string().uuid({ version: 'uuidv4' }).required()
}).required();

/* ─────────────────────────────────────────────────  Controllers ───────────── */

/**
 * POST /v1/kyc/verify
 * Accepts a KYC submission and triggers the verification workflow.
 */
router.post('/verify', async (req, res, next) => {
  try {
    /* Validate payload */
    const payload = await kycSubmissionSchema.validateAsync(req.body, { abortEarly: false });

    /* Delegate to domain service */
    const verificationResult = await KycService.initiateVerification(
      payload,
      { correlationId: req.correlationId }
    );

    /* Emit Event for downstream services (Risk, Compliance, etc.) */
    await EventBus.publish('KYC_VERIFICATION_REQUESTED', {
      correlationId: req.correlationId,
      data: {
        userId:      payload.userId,
        submissionId: verificationResult.submissionId,
        timestamp:   new Date().toISOString()
      }
    });

    /* Respond to client */
    res
      .status(httpStatus.ACCEPTED)
      .json({
        status:      'PENDING',
        submissionId: verificationResult.submissionId,
        message:     'Verification initiated successfully.'
      });

  } catch (err) {
    /* Joi validation errors → 400 */
    if (err.isJoi) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Invalid KYC submission.', err.details));
    }
    next(err); // Forward to global error handler
  }
});

/**
 * GET /v1/kyc/:userId/status
 * Retrieves current KYC verification status for a user.
 */
router.get('/:userId/status', async (req, res, next) => {
  try {
    /* Validate params */
    await statusQuerySchema.validateAsync(req.params, { abortEarly: false });

    const { userId } = req.params;

    const status = await KycService.fetchStatus(userId, { correlationId: req.correlationId });

    if (!status) {
      throw new ApiError(httpStatus.NOT_FOUND, `No KYC record found for userId: ${userId}`);
    }

    res
      .status(httpStatus.OK)
      .json({
        userId,
        kycStatus: status.state,
        lastUpdated: status.updatedAt
      });

  } catch (err) {
    if (err.isJoi) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Invalid userId supplied.', err.details));
    }
    next(err);
  }
});

/**
 * PATCH /v1/kyc/:userId/retry
 * Allows reprocessing of a previously FAILED verification.
 */
router.patch('/:userId/retry', async (req, res, next) => {
  try {
    await statusQuerySchema.validateAsync(req.params, { abortEarly: false });

    const { userId } = req.params;

    const retryResult = await KycService.retryVerification(userId, { correlationId: req.correlationId });

    if (!retryResult) {
      throw new ApiError(httpStatus.NOT_FOUND, `No failed KYC record to retry for userId: ${userId}`);
    }

    /* Emit Event */
    await EventBus.publish('KYC_VERIFICATION_RETRY_REQUESTED', {
      correlationId: req.correlationId,
      data: {
        userId,
        submissionId: retryResult.submissionId,
        timestamp: new Date().toISOString()
      }
    });

    res
      .status(httpStatus.ACCEPTED)
      .json({
        status: 'PENDING',
        submissionId: retryResult.submissionId,
        message: 'KYC verification retry initiated.'
      });

  } catch (err) {
    if (err.isJoi) {
      return next(new ApiError(httpStatus.BAD_REQUEST, 'Invalid userId supplied.', err.details));
    }
    next(err);
  }
});

/* ────────────────────────────────────────────  Health Check ──────────────── */
/**
 * GET /v1/kyc/health
 * Lightweight liveness & readiness probe.
 */
router.get('/health', (_req, res) => {
  res.status(httpStatus.OK).json({ status: 'UP', service: 'kyc-service' });
});

/* ─────────────────────────────────────────────  Export Router ────────────── */
module.exports = router;
```