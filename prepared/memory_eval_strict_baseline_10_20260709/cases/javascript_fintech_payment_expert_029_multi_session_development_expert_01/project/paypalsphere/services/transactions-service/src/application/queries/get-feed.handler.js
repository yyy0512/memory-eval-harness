```javascript
'use strict';

/**
 * transactions-service :: application :: queries :: get-feed.handler.js
 *
 * Production-grade CQRS query handler that resolves a user-scoped social
 * transaction feed.  The handler is designed to be stateless and easily
 * testable by relying on explicit dependencies passed via constructor
 * injection (a pattern aligned with Inversion-of-Control containers such as
 * Awilix, Inversify, BottleJS, etc.).
 *
 * Responsibilities
 *   • Leverage an optional in-memory / Redis cache for hot paths
 *   • Respect the caller’s AbortSignal for cooperative cancellation
 *   • Enforce privacy / compliance rules before returning the payload
 *   • Surface defensive error handling and structured logging
 *
 * NOTE: All externally-facing DTOs must remain free of confidential fields
 * (e.g., raw PANs, bank account numbers, or internal risk scores).  Those are
 * stripped in the sanitization phase, in accordance with our
 * Security-by-Design policy.
 */

// ───────────────────────────────────────────────────────────────────────────────
// Imports
// ───────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const pino = require('pino');
const { TimeoutError } = require('p-timeout');
const pTimeout = require('p-timeout');
const { serializeError } = require('serialize-error');

// Custom application errors
class OperationCanceledError extends Error {
  constructor(message = 'The operation was canceled') {
    super(message);
    this.name = 'OperationCanceledError';
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Handler
// ───────────────────────────────────────────────────────────────────────────────
class GetFeedHandler {
  /**
   * @param {Object} deps
   * @param {import('../ports/feed-read.repository').FeedReadRepository} deps.feedRepository
   * @param {import('../ports/cache.provider').CacheProvider}              deps.cacheProvider
   * @param {import('../ports/compliance.service').ComplianceService}      deps.complianceService
   * @param {import('../ports/privacy.engine').PrivacyEngine}              deps.privacyEngine
   * @param {import('../ports/tracing').Tracing}                           [deps.tracing]
   * @param {import('pino').Logger}                                        [deps.logger]
   */
  constructor({
    feedRepository,
    cacheProvider,
    complianceService,
    privacyEngine,
    tracing = { startSpan: () => ({ end: () => {} }) },
    logger = pino().child({ ctx: 'GetFeedHandler' }),
  }) {
    if (!feedRepository || !cacheProvider || !complianceService || !privacyEngine) {
      throw new TypeError('Missing mandatory dependency for GetFeedHandler');
    }

    this._feedRepository = feedRepository;
    this._cache = cacheProvider;
    this._compliance = complianceService;
    this._privacy = privacyEngine;
    this._tracing = tracing;
    this._logger = logger;
  }

  /**
   * Executes the query.
   *
   * @param {GetFeedQuery}  query
   * @param {AbortSignal}  [abortSignal] – optional cooperative cancellation
   * @returns {Promise<GetFeedResult>}
   */
  async execute(query, abortSignal) {
    const span = this._tracing.startSpan('transactions.getFeed');
    const timerStart = process.hrtime.bigint();

    try {
      this._validate(query);

      // Support cooperative cancellation
      if (abortSignal?.aborted)
        throw new OperationCanceledError();

      const cacheKey = buildCacheKey(query);

      // 1ᵃ – Attempt cache retrieval
      const cached = await this._cache.get(cacheKey);
      if (cached) {
        this._logger.debug({ cacheKey }, 'Cache hit');
        return cached;
      }

      // 1ᵇ – Set an upper-bound on DB latency (defensive programming)
      const result = await pTimeout(
        this._resolveFeed(query, abortSignal),
        { milliseconds: 4_000, message: 'Feed query timed out' },
      );

      // 2. Persist to cache (fire-and-forget)
      void this._cache
        .set(cacheKey, result, /* ttlInSeconds = */ 30)
        .catch((err) => this._logger.warn({ err }, 'Failed to prime cache'));

      return result;
    } catch (err) {
      // Log and bubble up custom application errors only
      this._logger.error({ err: serializeError(err), query }, 'Failed to resolve GetFeedQuery');
      throw err;
    } finally {
      span.end();
      const elapsedMs = Number(process.hrtime.bigint() - timerStart) / 1_000_000;
      this._logger.debug({ tookMs: elapsedMs.toFixed(2) }, 'GetFeedHandler completed');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  _validate(query) {
    if (!query || typeof query !== 'object')
      throw new TypeError('query must be a non-null object');

    const { userId, circleIds, limit } = query;

    if (!userId) throw new TypeError('userId is required');
    if (!Array.isArray(circleIds) || circleIds.length === 0)
      throw new TypeError('circleIds must be a non-empty array');
    if (limit && (isNaN(limit) || limit < 1 || limit > 100))
      throw new RangeError('limit must be between 1 and 100');
  }

  async _resolveFeed(query, abortSignal) {
    if (abortSignal?.aborted)
      throw new OperationCanceledError();

    const { userId, circleIds, limit = 30, cursor } = query;

    // 1. Retrieve raw feed data from the read model
    const rawFeed = await this._feedRepository.fetchFeed({
      userId,
      circleIds,
      limit,
      cursor,
      abortSignal,
    });

    if (abortSignal?.aborted)
      throw new OperationCanceledError();

    // 2. Enforce compliance redaction (e.g., GDPR / AML / sanctions)
    const compliantFeed = await this._compliance.redactForUser(rawFeed, userId);

    // 3. Apply privacy filters (e.g., hidden comment text, muted users)
    const sanitizedFeed = await this._privacy.applyPolicies({
      userId,
      feed: compliantFeed,
    });

    // 4. Compute the next cursor (opaque to clients)
    const nextCursor =
      sanitizedFeed.length === limit
        ? computeCursor(sanitizedFeed[sanitizedFeed.length - 1])
        : null;

    return { items: sanitizedFeed, nextCursor };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a deterministic, collision-resistant cache key.
 * We purposely avoid exposing user-level PII in the key name.
 *
 * @param {GetFeedQuery} query
 * @returns {string}
 */
function buildCacheKey({ userId, circleIds, limit = 30, cursor }) {
  // The digest obfuscates the user / circle IDs while still producing
  // identical keys for identical inputs.
  const data = JSON.stringify({ userId, circleIds, limit, cursor });
  const digest = crypto.createHash('sha256').update(data).digest('base64url');
  return `feed:${digest}`;
}

/**
 * Serializes a feed item into a cursor string.
 * The algorithm is intentionally opaque to clients and may evolve.
 *
 * @param {Object} lastItem
 * @returns {string}
 */
function computeCursor(lastItem) {
  const payload = {
    id: lastItem.id,
    ts: lastItem.createdAt,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
module.exports = { GetFeedHandler, OperationCanceledError };

/* ─────────────────────────────────────────────────────────────────────────────
 * @typedef  {Object}  GetFeedQuery
 * @property   {string}  userId                 – Authenticated user requesting the feed
 * @property   {string[]} circleIds             – List of circle IDs to scope
 * @property   {number}  [limit=30]             – Page size (max = 100)
 * @property   {string}  [cursor]               – Opaque pagination cursor
 *
 * @typedef  {Object}  GetFeedResult
 * @property   {Array<Object>}  items           – Sanitized feed entries
 * @property   {string|null}    nextCursor      – Cursor for the next page (or null)
 * ─────────────────────────────────────────────────────────────────────────── */
```