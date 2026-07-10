```javascript
/**************************************************************************
 *  payment-gateway.client.js                                             *
 *                                                                        *
 *  PayPalsphere – Settlement Service                                     *
 *                                                                        *
 *  A hardened, circuit-broken wrapper around the external Payment        *
 *  Gateway. Implements idempotent, signed requests with tiered retries,  *
 *  telemetry hooks, correlation-ID propagation, and field-level          *
 *  encryption for sensitive payloads.                                    *
 **************************************************************************/

'use strict';

// ──────────────────────────────────────────────────────────────────────────
// External Dependencies
// ──────────────────────────────────────────────────────────────────────────
const axios = require('axios');
const axiosRetry = require('axios-retry');
const CircuitBreaker = require('opossum');
const crypto = require('crypto');
const pino = require('pino');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');
const { AsyncLocalStorage } = require('async_hooks');

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// (In production, injected via env vars or a secure config vault.)
// ──────────────────────────────────────────────────────────────────────────
const {
  PAYMENT_GATEWAY_BASE_URL = 'https://api.payment-provider.example/v1',
  PAYMENT_GATEWAY_API_KEY = '',
  PAYMENT_GATEWAY_API_SECRET = '',
  PAYMENT_GATEWAY_ENCRYPTION_KEY = '', // 32 bytes base64 for AES-256-GCM
  PAYMENT_GATEWAY_TIMEOUT_MS = 10_000,
  NODE_ENV = 'development',
} = process.env;

// ──────────────────────────────────────────────────────────────────────────
// Logger & Telemetry
// ──────────────────────────────────────────────────────────────────────────
const logger = pino({
  name: 'payment-gateway-client',
  level: NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['apiKey', 'apiSecret', 'payload.cardNumber'],
});

// ──────────────────────────────────────────────────────────────────────────
// Async Local Storage for Correlation ID propagation across async hops
// ──────────────────────────────────────────────────────────────────────────
const als = new AsyncLocalStorage();

/**
 * Retrieves the active correlation id or generates a new one.
 */
function getCorrelationId() {
  const store = als.getStore();
  if (store && store.corrId) return store.corrId;
  return uuidv4();
}

// ──────────────────────────────────────────────────────────────────────────
// Custom Error Types
// ──────────────────────────────────────────────────────────────────────────
class GatewayError extends Error {
  constructor(message, { code, cause, response } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.cause = cause;
    this.response = response;
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    Error.captureStackTrace(this, this.constructor);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Helper Utilities
// ──────────────────────────────────────────────────────────────────────────
/**
 * Encrypts a string using AES-256-GCM.
 * Returns base64 encoded ciphertext:iv:tag.
 */
function encrypt(text) {
  if (!PAYMENT_GATEWAY_ENCRYPTION_KEY) {
    throw new Error('PAYMENT_GATEWAY_ENCRYPTION_KEY is not configured');
  }

  const key = Buffer.from(PAYMENT_GATEWAY_ENCRYPTION_KEY, 'base64');
  const iv = crypto.randomBytes(12); // AES GCM recommended IV length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([encrypted, iv, tag]).toString('base64');
}

/**
 * Computes an HMAC-SHA256 signature for the given payload and timestamp.
 */
function signPayload(payloadStr, ts) {
  return crypto
    .createHmac('sha256', PAYMENT_GATEWAY_API_SECRET)
    .update(`${ts}.${payloadStr}`)
    .digest('hex');
}

/**
 * Creates a canonical JSON representation of an object.
 * Ensures deterministic key ordering for signature reproducibility.
 */
function canonicalize(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ──────────────────────────────────────────────────────────────────────────
// Axois HTTP Client Configuration with retry and interceptors
// ──────────────────────────────────────────────────────────────────────────
const http = axios.create({
  baseURL: PAYMENT_GATEWAY_BASE_URL,
  timeout: Number(PAYMENT_GATEWAY_TIMEOUT_MS),
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  maxContentLength: 10 * 1024 * 1024, // 10MB
});

// Exponential back-off retry for transient network/server errors.
axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: err =>
    axiosRetry.isNetworkError(err) ||
    axiosRetry.isRetryableError(err) ||
    (err.response && err.response.status >= 500),
});

// Request/Response interceptors for tracing
http.interceptors.request.use(config => {
  const corrId = getCorrelationId();
  config.headers['X-Correlation-Id'] = corrId;
  logger.debug({ corrId, url: config.url, method: config.method }, '← HTTP Request');
  return config;
});

http.interceptors.response.use(
  response => {
    logger.debug(
      { corrId: response.config.headers['X-Correlation-Id'], status: response.status },
      '→ HTTP Response',
    );
    return response;
  },
  err => {
    const corrId = err.config?.headers?.['X-Correlation-Id'] || getCorrelationId();
    logger.warn({ corrId, err }, 'HTTP Response Error');
    return Promise.reject(err);
  },
);

// ──────────────────────────────────────────────────────────────────────────
// Circuit Breaker Setup
// ──────────────────────────────────────────────────────────────────────────
const breakerOptions = {
  timeout: PAYMENT_GATEWAY_TIMEOUT_MS + 2_000, // allow for internal latency
  errorThresholdPercentage: 50, // open when 50% of requests fail
  resetTimeout: 30_000, // half-open state after 30s
};

const breaker = new CircuitBreaker(
  reqConfig => http.request(reqConfig),
  breakerOptions,
);

breaker
  .on('open', () => logger.error('Payment Gateway circuit breaker: OPEN'))
  .on('halfOpen', () => logger.warn('Payment Gateway circuit breaker: HALF-OPEN'))
  .on('close', () => logger.info('Payment Gateway circuit breaker: CLOSED'));

// ──────────────────────────────────────────────────────────────────────────
// PaymentGatewayClient Implementation
// ──────────────────────────────────────────────────────────────────────────
class PaymentGatewayClient extends EventEmitter {
  constructor() {
    super();
    if (!PAYMENT_GATEWAY_API_KEY || !PAYMENT_GATEWAY_API_SECRET) {
      throw new Error('Payment gateway credentials are not configured');
    }
  }

  /**
   * Initiates a payout / settlement transfer.
   * Encrypts sensitive fields before egress.
   *
   * @param {Object} params
   * @param {String} params.settlementId – Internal Settlement UUID.
   * @param {Number} params.amount – Decimal amount (e.g., 42.50).
   * @param {String} params.currency – ISO-4217 currency code.
   * @param {String} params.destinationBankAccount – Tokenized bank account id.
   * @param {String} [params.memo] – Optional transfer memo.
   */
  async initiateSettlement(params) {
    validateParams(params, ['settlementId', 'amount', 'currency', 'destinationBankAccount']);

    const payload = {
      settlementId: params.settlementId,
      amount: params.amount,
      currency: params.currency,
      destinationBankAccount: encrypt(params.destinationBankAccount),
      memo: params.memo || '',
    };

    return this._invokeGateway('/settlements', 'POST', payload);
  }

  /**
   * Finalizes a previous settlement (capture of an authorized transaction).
   */
  async finalizeSettlement({ settlementId, gatewayTransactionId }) {
    validateParams({ settlementId, gatewayTransactionId }, ['settlementId', 'gatewayTransactionId']);

    return this._invokeGateway(
      `/settlements/${encodeURIComponent(settlementId)}/finalize`,
      'POST',
      { gatewayTransactionId },
    );
  }

  /**
   * Cancels an outstanding settlement.
   */
  async cancelSettlement({ settlementId, reason }) {
    validateParams({ settlementId, reason }, ['settlementId', 'reason']);

    return this._invokeGateway(
      `/settlements/${encodeURIComponent(settlementId)}`,
      'DELETE',
      { reason },
    );
  }

  /**
   * Retrieves the current status of a settlement.
   */
  async fetchSettlementStatus(settlementId) {
    if (!settlementId) throw new ValidationError('settlementId is required');

    return this._invokeGateway(
      `/settlements/${encodeURIComponent(settlementId)}`,
      'GET',
    );
  }

  /**
   * Health check / ping for readiness and liveness probes.
   */
  async healthCheck() {
    try {
      const { status } = await breaker.fire({ url: '/health', method: 'GET' });
      return { ok: status === 200 };
    } catch (err) {
      logger.error({ err }, 'Payment gateway health check failed');
      return { ok: false, err };
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Wraps outbound HTTP calls with signing, correlation ID propagation,
   * circuit breaker resilience, and unified error shaping.
   *
   * @private
   */
  async _invokeGateway(path, method, body = null) {
    const ts = Date.now().toString();
    const payloadStr = body ? canonicalize(body) : '';
    const signature = signPayload(payloadStr, ts);

    const reqConfig = {
      url: path,
      method,
      headers: {
        'X-Api-Key': PAYMENT_GATEWAY_API_KEY,
        'X-Signature': signature,
        'X-Timestamp': ts,
      },
      data: body,
    };

    const corrId = getCorrelationId();
    // ensure correlation id passed down the chain
    reqConfig.headers['X-Correlation-Id'] = corrId;

    // Emit outbound event for observability plugins.
    this.emit('request', { corrId, reqConfig });

    let res;
    try {
      res = await breaker.fire(reqConfig);
    } catch (err) {
      logger.error({ corrId, err }, 'Gateway invocation error');
      throw mapToGatewayError(err);
    }

    this.emit('response', { corrId, res });
    return res.data;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Validation Helper
// ──────────────────────────────────────────────────────────────────────────
function validateParams(params, requiredFields = []) {
  for (const f of requiredFields) {
    if (params[f] === undefined || params[f] === null || params[f] === '') {
      throw new ValidationError(`${f} is required`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Error Mapping
// ──────────────────────────────────────────────────────────────────────────
function mapToGatewayError(err) {
  // Already shaped as GatewayError?
  if (err instanceof GatewayError) return err;

  // Axios errors have response
  if (err.isAxiosError) {
    const {
      response: { status, data } = { status: undefined, data: undefined },
    } = err;

    const message = `Gateway responded with status ${status || 'N/A'}`;
    return new GatewayError(message, {
      code: status,
      cause: err,
      response: data,
    });
  }

  // Circuit breaker open
  if (CircuitBreaker.isOurError(err)) {
    return new GatewayError('Circuit breaker open', { code: 'CIRCUIT_OPEN', cause: err });
  }

  // Fallback
  return new GatewayError('Unknown gateway error', { cause: err });
}

// ──────────────────────────────────────────────────────────────────────────
// Factory / Export
// ──────────────────────────────────────────────────────────────────────────
const paymentGatewayClient = new PaymentGatewayClient();

module.exports = paymentGatewayClient;
module.exports.PaymentGatewayClient = PaymentGatewayClient; // for DI / unit tests
module.exports.getCorrelationId = getCorrelationId;

// Allow downstream code to run inside ALS context and propagate corr-id.
module.exports.withCorrelationContext = async function withCorrelationContext(fn, corrId = uuidv4()) {
  return als.run({ corrId }, fn);
};
```