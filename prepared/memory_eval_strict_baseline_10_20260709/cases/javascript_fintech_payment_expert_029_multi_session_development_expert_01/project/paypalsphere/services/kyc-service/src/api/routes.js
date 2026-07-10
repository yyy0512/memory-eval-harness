/**
 * routes.js
 * ----------------------------------------------------------------------------
 * API Route definitions for the KYC Service
 *
 * Describes every HTTP entry-point exposed by the KYC bounded-context within
 * PayPalsphere.  All routes are guarded by:
 *   • Authentication (JWT bearer tokens – issued by Auth Service)
 *   • Role-based access control (RBAC middleware)
 *   • Schema validation (Joi) to protect against malformed payloads
 *   • Rate-limiting (per-user & per-IP) to mitigate brute-force attacks
 *   • Audit logging that streams structured events to the Audit-Trail Service
 *
 * Every handler is wrapped with `express-async-handler` so unhandled promise
 * rejections are automatically forwarded to the central error middleware.
 *
 * NOTE: The actual business logic lives in the /controllers folder; this file
 *       is intentionally slim and declarative.
 * ----------------------------------------------------------------------------
 */

'use strict';

const express             = require('express');
const asyncHandler        = require('express-async-handler');
const createError         = require('http-errors');
const { v4: uuid }        = require('uuid');

// Local imports ──────────────────────────────────────────────────────────────
const authMiddleware      = require('../middleware/auth');
const rbacMiddleware      = require('../middleware/rbac');
const rateLimitMiddleware = require('../middleware/rate-limit');
const validateRequest     = require('../middleware/validate-request');
const auditTrail          = require('../middleware/audit-trail');

const kycController       = require('../controllers/kyc-controller');
const vendorController    = require('../controllers/vendor-webhook-controller');

const {
  kycVerificationSchema,
  kycResubmissionSchema,
  userIdParamSchema,
} = require('../validators/kyc-schemas');

// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router({
  mergeParams : true,      // Preserve parent params if the router is mounted
  strict      : true,      // Enable “/path” and not “/path/”
  caseSensitive: false,
});

/**
 * Utility to ensure all 4xx/5xx are JSON-serialised when route not found.
 */
router.use((req, res, next) => {
  if (!req.route) {
    return next(createError.NotFound(`Unknown endpoint: ${req.originalUrl}`));
  }
  next();
});

// ──────────────────────────────  Public Webhooks  ───────────────────────────
/**
 * Incoming callbacks from the external KYC vendor (e.g., SumSub, OnFido).
 * These are IP-whitelisted & HMAC-signed; validation happens in controller.
 */
router.post(
  '/vendor/callback',
  rateLimitMiddleware({ windowMs: 60_000, max: 50, keyPrefix: 'vendor' }),
  auditTrail({ action: 'VENDOR_CALLBACK_RECEIVED' }),
  asyncHandler(vendorController.processCallback),
);

// ───────────────────────────────  Authenticated  ────────────────────────────

/**
 * Initiate a new KYC verification for the authenticated customer.
 */
router.post(
  '/verify',
  authMiddleware.verifyJwt,
  rateLimitMiddleware({ windowMs: 5 * 60_000, max: 10 }),
  rbacMiddleware.requireScopes(['kyc:write']),
  validateRequest.body(kycVerificationSchema),
  auditTrail({ action: 'KYC_VERIFICATION_INIT' }),
  asyncHandler(kycController.startVerification),
);

/**
 * Resubmit documents for an existing KYC case.
 */
router.post(
  '/resubmit',
  authMiddleware.verifyJwt,
  rateLimitMiddleware({ windowMs: 10 * 60_000, max: 5 }),
  rbacMiddleware.requireScopes(['kyc:write']),
  validateRequest.body(kycResubmissionSchema),
  auditTrail({ action: 'KYC_DOCUMENTS_RESUBMIT' }),
  asyncHandler(kycController.resubmitDocuments),
);

/**
 * Retrieve the status of a user’s KYC onboarding.
 * Endpoint supports both self-query (userId === token.sub) and
 * privileged query (admin/service token with `kyc:read:any` scope).
 */
router.get(
  '/:userId/status',
  authMiddleware.verifyJwt,
  rateLimitMiddleware({ windowMs: 1 * 60_000, max: 30 }),
  validateRequest.params(userIdParamSchema),
  rbacMiddleware.requireScopes(['kyc:read']),
  auditTrail({ action: 'KYC_STATUS_FETCH' }),
  asyncHandler(kycController.getStatus),
);

/**
 * Signed URL to download an already-uploaded verification document.
 */
router.get(
  '/:userId/documents/:docId',
  authMiddleware.verifyJwt,
  rateLimitMiddleware({ windowMs: 60_000, max: 20 }),
  validateRequest.params(userIdParamSchema.keys({
    docId: Joi.string().uuid().required(),
  })),
  rbacMiddleware.requireScopes(['kyc:read']),
  auditTrail({ action: 'KYC_DOCUMENT_DOWNLOAD_REQUEST' }),
  asyncHandler(kycController.getDocumentSignedUrl),
);

// ──────────────────────────────  Health Checks  ─────────────────────────────

/**
 * Liveness & readiness — used by Kubernetes probes.
 */
router.get('/health', (req, res) => {
  res.json({ status: 'OK', ts: new Date().toISOString(), instanceId: uuid() });
});

// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;