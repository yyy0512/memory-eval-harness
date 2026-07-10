```javascript
/**
 * PayPalsphere – Accounts-Service
 * routes.js
 *
 * Centralised definition of all HTTP routes exposed by the Accounts-Service.
 * Only lightweight orchestration logic should live here—heavy lifting is
 * delegated to controllers / services.
 *
 * NOTE:
 *  • All route-specific input validation is handled via celebrate/Joi.
 *  • The router is intentionally unaware of transport details (Kafka, NATS,
 *    etc.) used for CQRS write events—those concerns live in the service layer.
 */

'use strict';

const express                     = require('express');
const { celebrate, Joi, Segments } = require('celebrate');
const asyncHandler                = require('../middleware/asyncHandler');
const { authenticate }            = require('../middleware/authenticate');
const { authorize }               = require('../middleware/authorize');
const rateLimiter                 = require('../middleware/rateLimiter');
const requestTracker              = require('../middleware/requestTracker');
const AccountController           = require('../controllers/AccountController');
const { Roles }                   = require('../constants/roles');

const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                               Public Endpoints                             */
/* -------------------------------------------------------------------------- */

/**
 * Health check used by orchestration / load balancers.
 */
router.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

/**
 * Register a brand-new account.
 *
 * Although this is a “public” route it is still throttled to stop abuse.
 */
router.post(
  '/v1/accounts',
  rateLimiter.public, // lightweight IP-based limit
  celebrate({
    [Segments.BODY]: Joi.object({
      email         : Joi.string().email().max(320).required(),
      phone         : Joi.string().pattern(/^\+\d{7,15}$/).required(),
      fullName      : Joi.string().min(2).max(120).required(),
      password      : Joi.string().min(8).max(128).required(),
      referralCode  : Joi.string().max(50).optional(),
    }),
  }),
  asyncHandler(AccountController.register),
);

/* -------------------------------------------------------------------------- */
/*                           Authenticated Endpoints                          */
/* -------------------------------------------------------------------------- */

/**
 * Apply global middlewares required for _all_ authenticated calls.
 *  • requestTracker injects ctx.requestId for observability.
 *  • authenticate verifies the JWT / API key & sets req.user.
 *  • rateLimiter.authenticated provides per-user quotas.
 */
router.use(requestTracker);
router.use(authenticate);
router.use(rateLimiter.authenticated);

/* ------------------------------ Account CRUD ------------------------------ */

/**
 * Get profile of the currently authenticated user.
 */
router.get('/v1/accounts/me', asyncHandler(AccountController.me));

/**
 * Patch (partial update) authenticated user profile.
 */
router.patch(
  '/v1/accounts/me',
  celebrate({
    [Segments.BODY]: Joi.object({
      fullName         : Joi.string().min(2).max(120),
      preferredCurrency: Joi.string().length(3).uppercase(), // ISO-4217
      bio              : Joi.string().max(240),
      avatarUrl        : Joi.string().uri(),
    }).min(1),
  }),
  asyncHandler(AccountController.updateProfile),
);

/**
 * Retrieve the *public* profile for a given account UUID.
 */
router.get(
  '/v1/accounts/:accountId',
  celebrate({
    [Segments.PARAMS]: Joi.object({
      accountId: Joi.string().uuid().required(),
    }),
  }),
  asyncHandler(AccountController.publicProfile),
);

/**
 * Follow another account’s social timeline.
 */
router.post(
  '/v1/accounts/:accountId/follow',
  celebrate({
    [Segments.PARAMS]: Joi.object({
      accountId: Joi.string().uuid().required(),
    }),
  }),
  asyncHandler(AccountController.followAccount),
);

/* ---------------------------- KYC Verification ---------------------------- */

/**
 * Get the logged-in user’s KYC status/progress.
 */
router.get('/v1/accounts/me/kyc', asyncHandler(AccountController.getKycStatus));

/**
 * Submit KYC documents for the authenticated account.
 */
router.post(
  '/v1/accounts/me/kyc',
  celebrate({
    [Segments.BODY]: Joi.object({
      documentType   : Joi.string().valid('passport', 'id_card', 'driver_license').required(),
      documentFrontUrl: Joi.string().uri().required(),
      documentBackUrl : Joi.string().uri().optional(),
      selfieUrl       : Joi.string().uri().required(),
    }),
  }),
  asyncHandler(AccountController.submitKyc),
);

/* -------------------------------------------------------------------------- */
/*                               Admin Endpoints                              */
/* -------------------------------------------------------------------------- */

/**
 * List / filter all accounts (admin-only). Supports pagination.
 */
router.get(
  '/v1/admin/accounts',
  authorize(Roles.ADMIN),
  celebrate({
    [Segments.QUERY]: Joi.object({
      status : Joi.string().valid('ACTIVE', 'SUSPENDED', 'PENDING_KYC', 'CLOSED'),
      page   : Joi.number().integer().positive().default(1),
      perPage: Joi.number().integer().min(1).max(100).default(25),
    }),
  }),
  asyncHandler(AccountController.listAllAccounts),
);

/**
 * Change the operational status of a given account (admin action).
 */
router.patch(
  '/v1/admin/accounts/:accountId/status',
  authorize(Roles.ADMIN),
  celebrate({
    [Segments.PARAMS]: Joi.object({
      accountId: Joi.string().uuid().required(),
    }),
    [Segments.BODY]: Joi.object({
      status: Joi.string().valid('ACTIVE', 'SUSPENDED', 'CLOSED').required(),
      reason: Joi.string().min(5).max(255).required(),
    }),
  }),
  asyncHandler(AccountController.changeAccountStatus),
);

/* -------------------------------------------------------------------------- */
/*                               Error Handling                               */
/* -------------------------------------------------------------------------- */

const { errors } = require('celebrate'); // celebrate error handler
router.use(errors());

/**
 * Fallback 404 for any unknown route.
 * Placed last to avoid overriding valid endpoints.
 */
router.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

module.exports = router;
```