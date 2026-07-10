```javascript
/**
 * StreamPulse Nexus – Stream Key Authentication
 *
 * File: packages/service-ingress-gateway/src/auth/streamKey.auth.js
 * Author: StreamPulse Core Networking Team
 *
 * Responsibilities:
 *   •   Validate ingress requests that carry a stream key credential
 *   •   Cache look-ups for microsecond-level latency during handshake
 *   •   Expose an EventEmitter interface for security analytics, auditing,
 *       and dynamic incident response (e.g. revocation broadcasts)
 *   •   Wrap remote look-ups in a circuit-breaker for graceful degradation
 *
 * External dependencies are deliberately kept “infra-safe”; should any
 * package upgrade introduce a vulnerability, `security_scanning` CI job
 * will block the merge.
 */

'use strict';

const axios = require('axios').default;
const EventEmitter = require('events');
const NodeCache = require('node-cache');
const CircuitBreaker = require('opossum');
const { randomUUID, createHash } = require('crypto');
const { URL } = require('url');
const { context, trace, SpanStatusCode } = require('@opentelemetry/api');

// Local utilities — these live elsewhere in the code base
const logger = require('../utils/logger');
const config = require('../utils/config');

/**
 * Constants
 */
const CACHE_TTL_SEC = 30;              // Auth response cache TTL
const CACHE_CHECK_PERIOD_SEC = 60;     // How often to purge expired keys
const CB_FAILURE_THRESHOLD = 5;        // Trip circuit after N failures
const CB_TIMEOUT_MS = 1_500;           // Upstream auth SLA
const CB_RESET_TIMEOUT_MS = 10_000;    // Sleep before re-try upstream
const RATE_LIMIT_WINDOW_MS = 5_000;    // Rate-limit brute force per IP
const MAX_ATTEMPTS_PER_WINDOW = 10;

const tracer = trace.getTracer('ingress-gateway-auth');

/**
 * In-memory rate limiter for brute-force detection (per IP).
 * In large clusters, this would be pushed to a distributed store.
 */
class SlidingWindowCounter {
    constructor(windowSizeMs, maxEvents) {
        this.windowSizeMs = windowSizeMs;
        this.maxEvents = maxEvents;
        this.buckets = new Map(); /* Map<key, Array<number>> */
    }

    add(ip) {
        const now = Date.now();
        const events = this.buckets.get(ip) || [];
        // remove stale timestamps
        while (events.length && (now - events[0]) > this.windowSizeMs) {
            events.shift();
        }
        events.push(now);
        this.buckets.set(ip, events);
        return events.length <= this.maxEvents;
    }
}

/**
 * StreamKeyAuth – main export
 */
class StreamKeyAuth extends EventEmitter {
    constructor() {
        super();

        // Cheap in-process cache; evicts keys that expire or are revoked
        this._cache = new NodeCache({
            stdTTL: CACHE_TTL_SEC,
            checkperiod: CACHE_CHECK_PERIOD_SEC,
            useClones: false,
        });

        // Sliding window brute-force limiter
        this._rateLimiter = new SlidingWindowCounter(
            RATE_LIMIT_WINDOW_MS,
            MAX_ATTEMPTS_PER_WINDOW,
        );

        // Configure circuit-breaker around _remoteLookup (wrapped as promise)
        this._breaker = new CircuitBreaker(
            this._remoteLookup.bind(this),
            {
                timeout: CB_TIMEOUT_MS,
                errorThresholdPercentage: 50, // fail ratio
                resetTimeout: CB_RESET_TIMEOUT_MS,
                rollingCountTimeout: RATE_LIMIT_WINDOW_MS,
                rollingCountBuckets: 5,
            },
        );

        this._breaker.on('open', () => {
            logger.warn('Auth service circuit breaker tripped: OPEN');
            this.emit('circuit_open');
        });

        this._breaker.on('halfOpen', () => {
            logger.info('Auth service circuit breaker state: HALF_OPEN');
            this.emit('circuit_half_open');
        });

        this._breaker.on('close', () => {
            logger.info('Auth service circuit breaker recovered: CLOSED');
            this.emit('circuit_closed');
        });

        this._breaker.on('fallback', (data) => {
            logger.warn('Auth service fallback triggered', data);
        });
    }

    /**
     * Public API – verify a given streamKey for an incoming connection
     *
     * @param {string} streamKey – unmodified credential from client
     * @param {Object} meta – contextual metadata (ip, userAgent, etc.)
     * @returns {Promise<AuthResult>}
     */
    async verify(streamKey, meta = {}) {
        const span = tracer.startSpan('streamKey.verify', {
            attributes: {
                'auth.streamKey.length': streamKey?.length || 0,
                'auth.request.ip': meta.ip || 'unknown',
            },
        });

        return context.with(trace.setSpan(context.active(), span), async () => {
            if (!streamKey || typeof streamKey !== 'string') {
                span.setStatus({ code: SpanStatusCode.ERROR, message: 'Missing streamKey' });
                span.end();
                return this._deny('INVALID_CREDENTIAL', 'Stream key missing or malformed');
            }

            // Lightweight brute-force protection
            if (!this._rateLimiter.add(meta.ip || 'unknown')) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: 'Rate limit exceeded' });
                span.end();
                logger.warn(`Rate limit exceeded for IP ${meta.ip}`);
                return this._deny('RATE_LIMIT', 'Too many failed attempts');
            }

            // Check local cache first
            const cached = this._cache.get(streamKey);
            if (cached) {
                span.addEvent('auth.cache_hit');
                span.end();
                // do not spread internal flags
                return { ...cached, cache: true };
            }

            try {
                const response = await this._breaker.fire(streamKey, meta);
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                this._cache.set(streamKey, response); // cache happy path
                return { ...response, cache: false };
            } catch (error) {
                span.recordException(error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: 'Upstream auth failed' });
                span.end();
                logger.error('Stream key verification failed', { error });
                return this._deny('AUTH_SERVICE_UNAVAILABLE', 'Unable to verify stream key');
            }
        });
    }

    /**
     * PRIVATE – actual HTTP call to Auth-Service.
     * Note: Wrapped by circuit-breaker.
     *
     * @param {string} streamKey
     * @param {Object} meta
     * @returns {Promise<AuthResult>}
     * @throws {Error} when upstream rejects or we receive non-200 response
     */
    async _remoteLookup(streamKey, meta) {
        const { authServiceUrl, authServiceToken } = config.get('ingressGateway');
        const reqId = randomUUID();

        const url = new URL('/v1/stream-keys/validate', authServiceUrl).href;
        const start = Date.now();
        try {
            const response = await axios.post(url, {
                streamKey,
                metadata: meta,
            }, {
                headers: {
                    Authorization: `Bearer ${authServiceToken}`,
                    'X-Request-Id': reqId,
                },
                timeout: CB_TIMEOUT_MS,
                validateStatus: (status) => status >= 200 && status < 500,
            });

            const latency = Date.now() - start;

            if (response.status !== 200) {
                // Upstream handled but denied the request (e.g. 401)
                logger.info(`Auth denied [${response.status}] ${latency}ms`);
                throw new Error(`AuthDenied:${response.status}`);
            }

            logger.debug(`Auth OK (${latency}ms) channel=${response.data.channelId}`);

            // Shape the successful payload
            return {
                authorized: true,
                channelId: response.data.channelId,
                ownerId: response.data.ownerId,
                scopes: response.data.scopes || [],
                expiresAt: response.data.expiresAt,
                reason: 'AUTHORIZED',
            };
        } catch (err) {
            logger.error('Auth service request failed', { err });
            throw err;
        }
    }

    /**
     * PUBLIC – revoke a streamKey (e.g., moderation action)
     *
     * @param {string} streamKey
     */
    revoke(streamKey) {
        if (!streamKey) return;
        this._cache.del(streamKey);
        this.emit('revoked', { streamKey, ts: Date.now() });
    }

    /**
     * UTIL – build a denial response
     * @param {string} code
     * @param {string} msg
     * @returns {AuthResult}
     */
    _deny(code, msg) {
        return {
            authorized: false,
            reason: code,
            message: msg,
        };
    }
}

/**
 * @typedef {Object} AuthResult
 * @property {boolean} authorized
 * @property {string} [channelId] – which ingest channel to push packets
 * @property {string} [ownerId] – user who owns the channel
 * @property {Array<string>} [scopes] – auth scopes granted
 * @property {string} [expiresAt] – ISO timestamp from upstream
 * @property {string} reason – machine-readable reason
 * @property {boolean} [cache] – whether result came from the fast cache
 * @property {string} [message] – human-friendly reason for denial
 */

module.exports = new StreamKeyAuth();
```