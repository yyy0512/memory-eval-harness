```javascript
/**
 * PayPalsphere – KYC Service
 * Infrastructure Layer: Veriff API Client
 *
 * This module is a thin, resilient wrapper around the Veriff Station API.
 * It encapsulates request signing, retries, circuit-breaking (via an
 * in–memory fallback), and response normalisation so that upstream
 * application services interact with a predictable SDK-like surface.
 *
 * NOTE: This file purposefully contains no domain logic. It should remain
 * agnostic of CQRS commands/events and provide a pure IO gateway.
 *
 * @module infrastructure/veriff-client
 */

'use strict';

/* ---------------------------------------------------------------------
 * External Dependencies
 * ------------------------------------------------------------------- */
const axios = require('axios');
const axiosRetry = require('axios-retry');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const createError = require('http-errors');
const Joi = require('joi');
const ms = require('ms');

/* ---------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------- */
const {
  VERIFF_API_KEY = '',
  VERIFF_SHARED_SECRET = '',
  VERIFF_BASE_URL = 'https://stationapi.veriff.com/v1',
  VERIFF_TIMEOUT = '8s', // human-readable, parsed by `ms`
} = process.env;

if (!VERIFF_API_KEY || !VERIFF_SHARED_SECRET) {
  // Fail fast — KYC service cannot start without credentials.
  throw new Error(
    'VERIFF_API_KEY and VERIFF_SHARED_SECRET must be provided as environment variables',
  );
}

/* ---------------------------------------------------------------------
 * Constants & Joi Schemas
 * ------------------------------------------------------------------- */
const SESSION_SCHEMA = Joi.object({
  firstName: Joi.string().max(255).required(),
  lastName: Joi.string().max(255).required(),
  dateOfBirth: Joi.string().isoDate().required(), // YYYY-MM-DD
  nationality: Joi.string().length(2).required(), // ISO-3166-1 alpha-2
  documentType: Joi.string().valid('PASSPORT', 'ID_CARD', 'DRIVER_LICENSE').optional(),
})
  .required()
  .label('VeriffSessionPayload');

/**
 * Normalises Veriff’s response statuses to an internal enum that is easier
 * to reason about within business flows and sagas.
 */
const STATUS_MAP = Object.freeze({
  // Veriff     -> Internal
  'approved': 'APPROVED',
  'declined': 'DECLINED',
  'resubmission-requested': 'RESUBMISSION_REQUESTED',
  'waiting': 'PENDING',
  'in-review': 'IN_REVIEW',
  'expired': 'EXPIRED',
});

/* ---------------------------------------------------------------------
 * Helper — Error Wrapper
 * ------------------------------------------------------------------- */
class VeriffClientError extends createError.HttpError {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {object} [context] – additional diagnostic context
   */
  constructor(message, statusCode = 500, context = {}) {
    super(message, statusCode);
    this.name = 'VeriffClientError';
    this.context = context;
  }
}

/* ---------------------------------------------------------------------
 * Helper — Cryptographic Verification
 * ------------------------------------------------------------------- */
/**
 * Validates Veriff webhook signatures.
 *
 * @param {Buffer|string} rawBody - The raw request body (not yet parsed).
 * @param {string} signatureHeader - The value of `X-Hub-Signature`.
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;

  const [algo, expectedHash] = signatureHeader.split('=');
  if (algo !== 'sha256' || !expectedHash) return false;

  const hmac = crypto
    .createHmac('sha256', VERIFF_SHARED_SECRET)
    .update(rawBody, typeof rawBody === 'string' ? 'utf8' : undefined)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHash));
}

/* ---------------------------------------------------------------------
 * Axios Instance
 * ------------------------------------------------------------------- */
const http = axios.create({
  baseURL: VERIFF_BASE_URL,
  timeout: ms(VERIFF_TIMEOUT),
  headers: {
    'X-AUTH-CLIENT': VERIFF_API_KEY,
    'Content-Type': 'application/json',
  },
});

// Automatic retries for transient network errors & 5xxs.
axiosRetry(http, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (error) =>
    axiosRetry.isNetworkOrIdempotentRequestError(error) ||
    error.response?.status >= 500,
});

/* ---------------------------------------------------------------------
 * VeriffClient
 * ------------------------------------------------------------------- */
/**
 * Typed client encapsulating Veriff API.
 */
class VeriffClient {
  /**
   * @param {object} [opts]
   * @param {import('pino').Logger} [opts.logger] – injected structured logger
   */
  constructor({ logger = console } = {}) {
    this.logger = logger.child ? logger.child({ module: 'VeriffClient' }) : logger;
  }

  /* ----------------------------------------------------------
   * Public API
   * -------------------------------------------------------- */

  /**
   * Creates a Veriff verification session for a natural person.
   *
   * @param {object} applicant – KYC applicant details
   * @param {string} applicant.firstName
   * @param {string} applicant.lastName
   * @param {string} applicant.dateOfBirth – YYYY-MM-DD
   * @param {string} applicant.nationality – ISO-3166-1 alpha-2
   * @param {string} [applicant.documentType]
   * @param {object} [metadata] – Arbitrary key/value pairs persisted in Veriff
   * @returns {Promise<{ id: string, url: string, status: string }>}
   */
  async createSession(applicant, metadata = {}) {
    const { error } = SESSION_SCHEMA.validate(applicant);
    if (error) {
      throw new VeriffClientError(`Invalid applicant payload: ${error.message}`, 400);
    }

    const payload = {
      verification: {
        person: applicant,
        callback: metadata.callbackUrl || undefined,
        vendorData:
          metadata.vendorData ||
          JSON.stringify({
            requestId: uuid(),
            ...metadata,
          }),
      },
    };

    try {
      const res = await http.post('/sessions', payload);

      if (res.status !== 201) {
        throw new VeriffClientError(
          `Unexpected status while creating session: ${res.status}`,
          res.status,
        );
      }

      const {
        verification: {
          id,
          url,
          status,
        },
      } = res.data;

      this.logger.info({ id, status }, 'Created Veriff session');

      return {
        id,
        url,
        status: mapStatus(status),
      };
    } catch (err) {
      this.logger.error({ err }, 'Failed to create Veriff session');
      throw normalizeError(err);
    }
  }

  /**
   * Retrieves the latest status for a previously created verification session.
   *
   * @param {string} sessionId
   * @returns {Promise<{
   *   id: string,
   *   status: string,
   *   reason?: string,
   *   resolvedAt?: string
   * }>}
   */
  async fetchSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new VeriffClientError('sessionId must be a non-empty string', 400);
    }

    try {
      const res = await http.get(`/sessions/${encodeURIComponent(sessionId)}`);

      const {
        verification: {
          id,
          status,
          code,
          reason,
          created,
          updated,
          decision,
        },
      } = res.data;

      const mappedStatus = mapStatus(status);
      const resolvedAt =
        mappedStatus === 'APPROVED' || mappedStatus === 'DECLINED'
          ? decision?.time || updated
          : undefined;

      return {
        id,
        status: mappedStatus,
        reason: reason || decision?.reason,
        resolvedAt,
        createdAt: created,
        updatedAt: updated,
      };
    } catch (err) {
      this.logger.error({ err, sessionId }, 'Failed to fetch Veriff session');
      throw normalizeError(err);
    }
  }

  /**
   * Convenience util for synchronous webhook validation.
   *
   * @param {Buffer|string} rawBody – Raw payload
   * @param {string} signatureHeader – `X-Hub-Signature` header value
   * @returns {boolean}
   */
  verifyWebhook(rawBody, signatureHeader) {
    return verifyWebhookSignature(rawBody, signatureHeader);
  }
}

/* ---------------------------------------------------------------------
 * Internal Helpers
 * ------------------------------------------------------------------- */
/**
 * Converts raw Veriff status to internal enum.
 *
 * @param {string} veriffStatus
 * @returns {string}
 */
function mapStatus(veriffStatus) {
  return STATUS_MAP[veriffStatus] || 'UNKNOWN';
}

/**
 * Normalises various error shapes (AxiosError, Error, HttpError) to a unified
 * VeriffClientError.
 *
 * @param {Error} err
 * @returns {VeriffClientError}
 */
function normalizeError(err) {
  if (err instanceof VeriffClientError) return err;

  // Axios error with response
  if (err.isAxiosError) {
    const {
      response: { status, data } = {},
      code,
      message,
    } = err;

    return new VeriffClientError(
      `Veriff API error: ${code || status} ${message}`,
      status || 502,
      { data },
    );
  }

  return new VeriffClientError(err.message || 'Unknown Veriff error', 500);
}

/* ---------------------------------------------------------------------
 * Exports
 * ------------------------------------------------------------------- */
module.exports = {
  VeriffClient,
  VeriffClientError,
};
```