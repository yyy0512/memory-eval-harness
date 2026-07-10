```javascript
/**
 * PayPalsphere – API Gateway
 *
 * Central entry point that fronts all internal micro-services
 * (Accounts, KYC, Risk, Transactions, Compliance, Settlement, SocialGraph).
 *
 * Responsibilities
 *  - TLS termination and HTTP handling
 *  - AuthN/AuthZ (JWT / RBAC)
 *  - Request validation & schema enforcement
 *  - Rate-limiting, circuit-breaking & timeouts
 *  - Correlation-ID propagation + structured logging
 *  - Service discovery & smart routing
 *
 * NOTE: Meant to be deployed as a stateless container behind a cloud LB.
 */

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { v4 as uuid } from 'uuid';
import morgan from 'morgan';
import winston from 'winston';
import rateLimit from 'express-rate-limit';
import { celebrate, Joi, errors as celebrateErrors, Segments } from 'celebrate';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import createHttpError from 'http-errors';
import CircuitBreaker from 'opossum';

const {
  NODE_ENV = 'development',
  PORT = 8080,
  // Service endpoints – typically injected by the orchestrator
  ACCOUNTS_URL,
  KYC_URL,
  RISK_URL,
  TX_URL,
  COMPLIANCE_URL,
  SETTLEMENT_URL,
  SOCIAL_URL,
  JWT_PUBLIC_KEY,
  LOG_LEVEL = 'info',
  RATE_LIMIT_WINDOW_MS = 60_000,
  RATE_LIMIT_MAX = 100,
  REQUEST_TIMEOUT_MS = 10_000,
  CB_ERROR_THRESHOLD_PERCENTAGE = 50,
  CB_RESET_TIMEOUT_MS = 30_000,
} = process.env;

/* -------------------------------------------------------------------------- */
/*                             Logger configuration                           */
/* -------------------------------------------------------------------------- */
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

/* -------------------------------------------------------------------------- */
/*                           Express & middleware                             */
/* -------------------------------------------------------------------------- */
const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

/* --------------------------- Correlation-ID -------------------------------- */
app.use((req, res, next) => {
  const id = req.headers['x-correlation-id'] || uuid();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
});

/* ------------------------------- Logging ----------------------------------- */
morgan.token('id', req => req.correlationId);
app.use(
  morgan(
    ':id :method :url :status :response-time ms - :res[content-length]',
    {
      stream: { write: msg => logger.http(msg.trim()) },
    }
  )
);

/* ------------------------------ Rate Limit --------------------------------- */
const limiter = rateLimit({
  windowMs: +RATE_LIMIT_WINDOW_MS,
  max: +RATE_LIMIT_MAX,
  keyGenerator: req => req.user?.sub || req.ip,
  handler: (_req, _res, next) =>
    next(createHttpError(429, 'Too many requests, please try again later.')),
});
app.use(limiter);

/* ----------------------------- Auth Middleware ----------------------------- */
app.use(async (req, _res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return next(createHttpError(401, 'Missing Bearer Token'));
  }

  const token = auth.substring(7);
  try {
    const payload = jwt.verify(token, JWT_PUBLIC_KEY, {
      algorithms: ['RS256'],
    });
    req.user = payload;
    return next();
  } catch (err) {
    return next(createHttpError(401, 'Invalid or expired token'));
  }
});

/**
 * RBAC helper – restricts routes to particular roles.
 * @param {...string} allowedRoles
 */
function requireRoles(...allowedRoles) {
  return (req, _res, next) => {
    const userRoles = req.user?.roles || [];
    if (allowedRoles.some(r => userRoles.includes(r))) return next();
    return next(createHttpError(403, 'Insufficient privileges'));
  };
}

/* -------------------------------------------------------------------------- */
/*                             Circuit-breaker                                */
/* -------------------------------------------------------------------------- */
const breakerOptions = {
  timeout: +REQUEST_TIMEOUT_MS,
  errorThresholdPercentage: +CB_ERROR_THRESHOLD_PERCENTAGE,
  resetTimeout: +CB_RESET_TIMEOUT_MS,
  rollingCountTimeout: 10_000,
};
const breakers = new Map();

/**
 * Returns or creates a circuit breaker for a given service base URL.
 * @param {string} baseURL
 */
function getBreaker(baseURL) {
  if (breakers.has(baseURL)) return breakers.get(baseURL);
  const axiosInstance = axios.create({
    baseURL,
    timeout: +REQUEST_TIMEOUT_MS,
  });
  const breaker = new CircuitBreaker(
    (options) => axiosInstance(options),
    breakerOptions
  );
  breaker
    .on('open', () => logger.warn(`CB: OPEN for ${baseURL}`))
    .on('close', () => logger.info(`CB: CLOSED for ${baseURL}`))
    .on('halfOpen', () => logger.info(`CB: HALF_OPEN for ${baseURL}`))
    .fallback(() => {
      throw createHttpError(
        503,
        `Service at ${baseURL} unavailable (circuit open)`
      );
    });

  breakers.set(baseURL, breaker);
  return breaker;
}

/**
 * Proxy helper that forwards validated traffic to the target service.
 * Adds correlation-id + auth headers for downstream tracing.
 */
async function proxy(req, res, next, baseURL, config = {}) {
  const breaker = getBreaker(baseURL);

  try {
    const { data, status, headers } = await breaker.fire({
      method: req.method,
      url: req.path.replace(/^\/[^/]+/, ''), // strip service prefix
      headers: {
        ...req.headers,
        'x-correlation-id': req.correlationId,
      },
      data: req.body,
      params: req.query,
      ...config,
    });
    // Pass-through headers that matter (pagination, etc.)
    Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
    res.status(status).json(data);
  } catch (err) {
    next(err.isAxiosError ? createHttpError(err.response?.status || 502, err.message) : err);
  }
}

/* -------------------------------------------------------------------------- */
/*                                Routes                                      */
/* -------------------------------------------------------------------------- */
const validateId = celebrate({
  [Segments.PARAMS]: Joi.object({ id: Joi.string().uuid().required() }),
});

// Accounts
app.get(
  '/accounts/:id',
  requireRoles('USER', 'ADMIN'),
  validateId,
  (req, res, next) => proxy(req, res, next, ACCOUNTS_URL)
);

app.post(
  '/accounts',
  celebrate({
    [Segments.BODY]: Joi.object({
      email: Joi.string().email().required(),
      phone: Joi.string().required(),
      fullName: Joi.string().required(),
    }),
  }),
  (req, res, next) => proxy(req, res, next, ACCOUNTS_URL)
);

// KYC
app.post(
  '/kyc/verify',
  requireRoles('USER'),
  celebrate({
    [Segments.BODY]: Joi.object({
      userId: Joi.string().uuid().required(),
      documentType: Joi.string().valid('PASSPORT', 'NID', 'DL').required(),
      documentImage: Joi.string().base64().required(),
    }),
  }),
  (req, res, next) => proxy(req, res, next, KYC_URL, { method: 'POST' })
);

// Transactions
app.post(
  '/transactions',
  requireRoles('USER'),
  celebrate({
    [Segments.BODY]: Joi.object({
      sourceAccountId: Joi.string().uuid().required(),
      targetAccountId: Joi.string().uuid().required(),
      amount: Joi.number().positive().required(),
      currency: Joi.string().length(3).uppercase().required(),
      note: Joi.string().max(240).allow(''),
    }),
  }),
  (_req, _res, next) => proxy(_req, _res, next, TX_URL)
);

app.get(
  '/transactions/:id',
  requireRoles('USER'),
  validateId,
  (req, res, next) => proxy(req, res, next, TX_URL)
);

// Compliance
app.get(
  '/compliance/report/:id',
  requireRoles('ADMIN', 'COMPLIANCE'),
  validateId,
  (req, res, next) => proxy(req, res, next, COMPLIANCE_URL)
);

// Settlement
app.post(
  '/settlements/trigger',
  requireRoles('ADMIN'),
  celebrate({
    [Segments.BODY]: Joi.object({
      groupId: Joi.string().uuid().required(),
      currency: Joi.string().length(3).uppercase().required(),
    }),
  }),
  (req, res, next) => proxy(req, res, next, SETTLEMENT_URL)
);

// Social
app.get(
  '/feed',
  requireRoles('USER'),
  (req, res, next) => proxy(req, res, next, SOCIAL_URL)
);

/* -------------------------------------------------------------------------- */
/*                            Error handling                                  */
/* -------------------------------------------------------------------------- */
app.use(celebrateErrors());

app.use((err, req, res, _next) => {
  // Normalise error
  const status = err.statusCode || err.status || 500;
  logger.error({
    message: err.message,
    stack: err.stack,
    correlationId: req.correlationId,
    path: req.path,
  });

  res.status(status).json({
    error: {
      message:
        NODE_ENV === 'production' && status === 500
          ? 'Internal Server Error'
          : err.message,
      correlationId: req.correlationId,
    },
  });
});

/* -------------------------------------------------------------------------- */
/*                               Start server                                 */
/* -------------------------------------------------------------------------- */
if (process.env.JEST_WORKER_ID === undefined) {
  app.listen(PORT, () => {
    logger.info(`API Gateway running on :${PORT} [${NODE_ENV}]`);
  });
}

export default app;
```