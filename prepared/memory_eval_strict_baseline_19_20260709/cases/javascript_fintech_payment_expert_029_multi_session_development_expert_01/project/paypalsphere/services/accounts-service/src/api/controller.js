```javascript
/**
 * PayPalsphere – Accounts Service
 * API Controller
 *
 * This controller is intentionally thin: it delegates business logic to
 *   – Command Bus (write-side / CQRS)
 *   – Query  Bus (read–side  / CQRS)
 *   – Domain Services (enrichment, cross-cutting orchestration)
 *
 * The controller is responsible for:
 *   • HTTP/REST contract mapping
 *   • Payload validation & sanitisation
 *   • Observability (structured logging, metrics, tracing)
 *   • Correlation & Idempotency handling
 *   • Defensive error handling
 *
 * NOTE: Express 4.x is used as the minimal HTTP layer. The actual
 *       server/bootstrap lives elsewhere and wires dependencies in.
 *
 * @file  paypalsphere/services/accounts-service/src/api/controller.js
 * @author PayPalsphere
 */

import express from 'express';
import { celebrate, Joi, Segments, errors as celebrateErrors } from 'celebrate';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import asyncHandler from 'express-async-handler';
import { v4 as uuid } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                     Dependency Injection Type Definition                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} ControllerDeps
 * @property {import('../domain/command-bus').CommandBus} commandBus
 * @property {import('../domain/query-bus').QueryBus}   queryBus
 * @property {import('../services/account-service').AccountService} accountService
 * @property {import('../shared/logger').Logger}        logger
 * @property {import('../shared/metrics').Metrics}      metrics
 */

/* -------------------------------------------------------------------------- */
/*                 Constants & Validation Schemas (Joi/Celebrate)            */
/* -------------------------------------------------------------------------- */

const v = {
  accountId: Joi.string().guid({ version: 'uuidv4' }).required(),
  currency: Joi.string().length(3).uppercase().required(),
  isoDate: Joi.date().iso()
};

const createAccountSchema = {
  [Segments.BODY]: Joi.object({
    fullName: Joi.string().min(2).max(120).required(),
    email: Joi.string().email().required(),
    defaultCurrency: v.currency,
    acceptMarketingEmails: Joi.boolean().default(false)
  })
};

const updateAccountSchema = {
  [Segments.BODY]: Joi.object({
    fullName: Joi.string().min(2).max(120),
    defaultCurrency: v.currency,
    acceptMarketingEmails: Joi.boolean()
  }).min(1) // At least one field is required
};

const kycSchema = {
  [Segments.BODY]: Joi.object({
    documentType: Joi.string().valid('passport', 'id_card', 'driver_license').required(),
    documentNumber: Joi.string().max(32).required(),
    issuedCountry: Joi.string().length(2).uppercase().required(),
    expirationDate: v.isoDate.required()
  })
};

const paginationSchema = {
  [Segments.QUERY]: Joi.object({
    cursor: Joi.string().guid({ version: 'uuidv4' }).allow(null, ''),
    limit: Joi.number().integer().min(1).max(100).default(25)
  })
};

/* -------------------------------------------------------------------------- */
/*                           Express Router Factory                           */
/* -------------------------------------------------------------------------- */

/**
 * Builds the Accounts API router with injected dependencies.
 *
 * @param {ControllerDeps} deps
 * @returns {express.Router}
 */
export function buildAccountsController(deps) {
  const { commandBus, queryBus, accountService, logger, metrics } = deps;

  if (!commandBus || !queryBus || !accountService || !logger || !metrics) {
    throw new Error('Missing required controller dependencies');
  }

  const router = express.Router();

  /* ---------------------------------------------------------------------- */
  /*               Middleware: Correlation-ID & Structured Logging          */
  /* ---------------------------------------------------------------------- */

  router.use((req, res, next) => {
    const correlationId = req.headers['x-correlation-id'] || uuid();
    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    // Attach per-request logger
    req.log = logger.child({ correlationId, path: req.path, method: req.method });
    req.log.debug('Incoming request');

    // Collect metrics
    const endTimer = metrics.httpRequestDuration.startTimer({
      route: req.path,
      method: req.method
    });

    res.on('finish', () => {
      endTimer({ status: res.statusCode });
    });

    next();
  });

  /* ---------------------------------------------------------------------- */
  /*                                Routes                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * POST /accounts
   * Creates a new account (write-side, routed through Command Bus)
   */
  router.post(
    '/',
    celebrate(createAccountSchema),
    asyncHandler(async (req, res) => {
      const { body, correlationId, log } = req;

      const command = {
        name: 'CreateAccount',
        payload: { ...body },
        metadata: { correlationId, idempotencyKey: req.headers['idempotency-key'] || uuid() }
      };

      log.info({ command: command.name }, 'Dispatching command');

      const result = await commandBus.dispatch(command);

      // Translate DomainResult into HTTP response
      res.status(StatusCodes.CREATED).json({
        accountId: result.aggregateId,
        status: 'PENDING_KYC',
        links: {
          self: `/accounts/${result.aggregateId}`,
          kyc: `/accounts/${result.aggregateId}/kyc`
        }
      });
    })
  );

  /**
   * GET /accounts/:accountId
   * Query materialized view (read-side, Query Bus)
   */
  router.get(
    '/:accountId',
    celebrate({ [Segments.PARAMS]: Joi.object({ accountId: v.accountId }) }),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params;
      const { correlationId, log } = req;
      const query = { name: 'GetAccountById', payload: { accountId }, metadata: { correlationId } };

      log.debug({ query: query.name, accountId }, 'Executing query');

      const account = await queryBus.execute(query);

      if (!account) {
        res.status(StatusCodes.NOT_FOUND).json({
          error: 'ACCOUNT_NOT_FOUND',
          message: `Account ${accountId} was not found`
        });
        return;
      }

      res.json(account);
    })
  );

  /**
   * PATCH /accounts/:accountId
   * Update account mutable fields
   */
  router.patch(
    '/:accountId',
    celebrate({
      [Segments.PARAMS]: Joi.object({ accountId: v.accountId }),
      ...updateAccountSchema
    }),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params;
      const { body, correlationId, log } = req;

      const command = {
        name: 'UpdateAccountProfile',
        payload: { accountId, ...body },
        metadata: { correlationId }
      };

      log.info({ command: command.name, accountId }, 'Dispatching command');

      await commandBus.dispatch(command);

      res.status(StatusCodes.NO_CONTENT).send();
    })
  );

  /**
   * POST /accounts/:accountId/kyc
   * Initiates KYC verification flow
   */
  router.post(
    '/:accountId/kyc',
    celebrate({
      [Segments.PARAMS]: Joi.object({ accountId: v.accountId }),
      ...kycSchema
    }),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params;
      const { body, correlationId, log } = req;

      const command = {
        name: 'InitiateKyc',
        payload: { accountId, ...body },
        metadata: { correlationId }
      };

      log.info({ command: command.name, accountId }, 'Dispatching command');

      await commandBus.dispatch(command);

      res.status(StatusCodes.ACCEPTED).json({
        status: 'KYC_IN_REVIEW',
        links: { self: `/accounts/${accountId}` }
      });
    })
  );

  /**
   * GET /accounts/:accountId/timeline
   * Returns social payment timeline for an account (read-side)
   */
  router.get(
    '/:accountId/timeline',
    celebrate({
      [Segments.PARAMS]: Joi.object({ accountId: v.accountId }),
      ...paginationSchema
    }),
    asyncHandler(async (req, res) => {
      const { accountId } = req.params;
      const { cursor, limit } = req.query;
      const { correlationId, log } = req;

      const query = {
        name: 'GetAccountTimeline',
        payload: { accountId, cursor: cursor || null, limit: Number(limit) },
        metadata: { correlationId }
      };

      log.debug({ query: query.name, accountId }, 'Executing query');

      const timeline = await queryBus.execute(query);

      res.json(timeline);
    })
  );

  /* ---------------------------------------------------------------------- */
  /*                         Global Error & 404 Handler                     */
  /* ---------------------------------------------------------------------- */

  // Celebrate / Joi validation errors
  router.use(celebrateErrors());

  // Domain & generic error handler
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    req.log.error({ err }, 'Unhandled error in Accounts controller');

    let status = StatusCodes.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = getReasonPhrase(status);

    // Handle domain-specific errors
    switch (err.name) {
      case 'AccountAlreadyExistsError':
        status = StatusCodes.CONFLICT;
        code = 'ACCOUNT_ALREADY_EXISTS';
        message = err.message;
        break;
      case 'InvalidStateTransitionError':
        status = StatusCodes.UNPROCESSABLE_ENTITY;
        code = 'INVALID_STATE';
        message = err.message;
        break;
      case 'ValidationError':
        status = StatusCodes.BAD_REQUEST;
        code = 'VALIDATION_ERROR';
        message = err.message;
        break;
      // Fallthrough to default
      default:
        break;
    }

    res.status(status).json({ error: code, message });
  });

  // 404 – unmatched routes under /accounts
  router.use((req, res) => {
    res.status(StatusCodes.NOT_FOUND).json({
      error: 'NOT_FOUND',
      message: `Route ${req.originalUrl} not found`
    });
  });

  return router;
}

/* -------------------------------------------------------------------------- */
/*                Default Export (for environments without DI)                */
/* -------------------------------------------------------------------------- */

/**
 * When this module is required without explicit dependency injection,
 * it will fall back to the service locator. This is handy for unit tests
 * or legacy bootstrap code that doesn’t yet use the functional builder.
 *
 * @deprecated Prefer `buildAccountsController()` with explicit deps
 */
import { getLocator } from '../shared/service-locator.js';

export default (() => {
  try {
    const deps = {
      commandBus: getLocator('commandBus'),
      queryBus: getLocator('queryBus'),
      accountService: getLocator('accountService'),
      logger: getLocator('logger'),
      metrics: getLocator('metrics')
    };

    return buildAccountsController(deps);
  } catch (err) {
    // If service-locator is not ready, throw a helpful error.
    throw new Error(
      'Accounts Controller: missing dependencies. Use buildAccountsController(deps) or register components in the Service Locator.'
    );
  }
})();
```