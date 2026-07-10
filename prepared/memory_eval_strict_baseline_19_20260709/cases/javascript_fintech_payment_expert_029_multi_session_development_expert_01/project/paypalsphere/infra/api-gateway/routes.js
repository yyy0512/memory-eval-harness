```javascript
/**
 * File: paypalsphere/infra/api-gateway/routes.js
 *
 * API-Gateway route definitions and cross-cutting middleware for the
 * PayPalsphere fintech ecosystem.  Each route encapsulates:
 *  • Zero-trust security (JWT, role-based policies, correlation-IDs)
 *  • Rate-limiting and basic hardening (helmet, express-rate-limit)
 *  • Input validation (express-validator)
 *  • Circuit-breaker-aware service proxying (opossum + http-proxy-middleware)
 *
 * The gateway is intentionally stateless; all business logic lives in the
 * downstream micro-services.  Think of this file as the programmable
 * “traffic-controller” for north-south traffic.
 */

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { body, param, validationResult } from 'express-validator';
import circuitBreaker from 'opossum';
import createError from 'http-errors';
import fetch from 'node-fetch'; // Used for circuit-breaker ping fallback
import config from '../config/index.js'; // centralised config (env, secrets, URLs)

/*
 * ---------------------------------------------------------------------------
 * Utilities
 * ---------------------------------------------------------------------------
 */

/**
 * Wrap a handler so that async errors propagate to Express’ error middleware.
 */
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Validate request w/ express-validator and throw 422 on failure.
 */
const validate = validations => [
  ...validations,
  (req, _res, next) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) {
      return next(createError(422, { message: 'Validation failed', details: errs.array() }));
    }
    return next();
  },
];

/**
 * JWT authentication & authorisation middleware.
 *
 * The gateway is trust-nothing; each request must carry a bearer token issued
 * by the AuthN micro-service.  The public RSA key is loaded from config.
 */
const authz = rolesAllowed => (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next(createError(401, 'Missing Authorization header'));

  const [, token] = authHeader.split(' ');
  jwt.verify(token, config.auth.publicKey, { algorithms: ['RS256'] }, (err, decoded) => {
    if (err) return next(createError(401, 'Invalid/expired token'));

    // Minimal RBAC enforcement
    if (rolesAllowed.length && !rolesAllowed.some(r => decoded.roles?.includes(r))) {
      return next(createError(403, 'Forbidden'));
    }

    req.user = decoded;
    return next();
  });
};

/**
 * Express-rate-limit shared instance—applies gateway-wide per IP throttling.
 */
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,            // 120 requests / minute
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Inject a correlation-ID (request scoped) so that logs across services can be
 * stitched together.
 */
const correlationId = (req, res, next) => {
  const cid = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = cid;
  res.setHeader('x-correlation-id', cid);
  next();
};

/**
 * Build a circuit-breaker-aware proxy for a given target service.
 */
const buildProxy = (serviceKey) => {
  const target = config.services[serviceKey];
  if (!target) throw new Error(`Unknown service "${serviceKey}"`);

  // Health ping used by circuit breaker fallback
  const healthPing = () => fetch(`${target}/health`).then(r => {
    if (!r.ok) throw new Error('Health ping failed');
    return true;
  });

  // Configure circuit breaker (opossum)
  const breaker = new circuitBreaker(healthPing, {
    timeout: 4_000,   // 4 seconds
    errorThresholdPercentage: 50,
    resetTimeout: 30_000, // 30 seconds
  });

  breaker.on('open', () => console.warn(`[CircuitBreaker] ${serviceKey} opened`));
  breaker.on('close', () => console.info(`[CircuitBreaker] ${serviceKey} closed`));

  // Actual forwarding proxy
  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    logLevel: 'warn',
    onProxyReq: (proxyReq, req) => {
      // Propagate auth & tracing headers downstream
      proxyReq.setHeader('x-correlation-id', req.correlationId);
      proxyReq.setHeader('x-user-id', req.user?.sub ?? 'anonymous');
    },
    onError: (err, _req, res) => {
      // Graceful fallback if circuit is open or proxy errors
      console.error(`[ProxyError] ${serviceKey}:`, err.message);
      if (breaker.opened) {
        return res
          .status(503)
          .json({ message: `${serviceKey} unavailable – circuit breaker open` });
      }
      return res.status(502).json({ message: `${serviceKey} unreachable` });
    },
  });

  return [breaker.middleware(), proxy];
};

/*
 * ---------------------------------------------------------------------------
 * Route factory
 * ---------------------------------------------------------------------------
 */

export default function createRoutes() {
  const router = express.Router();

  /* ---------- Global middleware (applied to all downstream routes) -------- */
  router.use(helmet());
  router.use(morgan('combined'));
  router.use(correlationId);
  router.use(limiter);

  /* ---------- Health endpoint (not proxied) ------------------------------- */
  router.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));

  /* ---------- Transaction Service ---------------------------------------- */
  router.post(
    '/api/v1/transactions',
    authz(['CUSTOMER', 'ADMIN']),
    validate([
      body('amount').isNumeric().isFloat({ gt: 0 }),
      body('currency').isISO4217(),
      body('circleId').isUUID(),
      body('note').optional().isString().isLength({ max: 140 }),
    ]),
    ...buildProxy('transactions'),
  );

  router.get(
    '/api/v1/transactions/:transactionId',
    authz(['CUSTOMER', 'ADMIN']),
    validate([param('transactionId').isUUID()]),
    ...buildProxy('transactions'),
  );

  /* ---------- Circle Feed (Social Graph Service) ------------------------- */
  router.get(
    '/api/v1/circles/:circleId/feed',
    authz(['CUSTOMER', 'ADMIN']),
    validate([param('circleId').isUUID()]),
    ...buildProxy('socialGraph'),
  );

  /* ---------- KYC Service ------------------------------------------------ */
  router.post(
    '/api/v1/kyc/verify',
    authz(['CUSTOMER']),
    validate([
      body('givenName').isString(),
      body('familyName').isString(),
      body('dob').isISO8601().toDate(),
      body('nationalId').isString(),
    ]),
    ...buildProxy('kyc'),
  );

  /* ---------- Compliance Reports (Admin only) ---------------------------- */
  router.get(
    '/api/v1/compliance/reports/:reportId',
    authz(['ADMIN', 'COMPLIANCE']),
    validate([param('reportId').isUUID()]),
    ...buildProxy('compliance'),
  );

  /*
   * -------------------------------------------------------------------------
   * 404 Handler – must be before error middleware
   * -------------------------------------------------------------------------
   */
  router.use((_req, _res, next) => next(createError(404, 'Not Found')));

  /*
   * -------------------------------------------------------------------------
   * Centralised error handler – last in chain
   * -------------------------------------------------------------------------
   */
  // eslint-disable-next-line no-unused-vars
  /* istanbul ignore next */
  router.use((err, req, res, _next) => {
    // Map unknown errors to 500
    const status = err.status || 500;
    const payload = {
      message: err.message || 'Internal Server Error',
      ...(config.env === 'development' && {
        stack: err.stack,
        details: err.details,
      }),
    };

    // In production, never leak stack traces
    res.status(status).json(payload);
  });

  return router;
}
```