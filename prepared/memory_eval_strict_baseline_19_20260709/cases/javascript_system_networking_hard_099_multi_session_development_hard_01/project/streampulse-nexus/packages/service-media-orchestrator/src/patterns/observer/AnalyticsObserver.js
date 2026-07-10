```javascript
/******************************************************************************************
 *  StreamPulse Nexus — Media Orchestrator
 *  File: packages/service-media-orchestrator/src/patterns/observer/AnalyticsObserver.js
 *
 *  Description:
 *  ----------------------------------------------------------------------------
 *  AnalyticsObserver implements the Observer pattern, attaching itself to the
 *  system-wide event bus in order to collect operational telemetry (router
 *  stats, security events, etc.). The class aggregates these events and
 *  periodically flushes them to the central analytics service using an
 *  adaptive back-off strategy for resiliency.
 *
 *  Responsibilities:
 *    • Subscribe to high-volume runtime events emitted by the orchestrator
 *    • Buffer & aggregate metrics in memory
 *    • Flush metrics to analytics back-end at a configurable cadence
 *    • Provide exponential back-off and jitter on failed deliveries
 *    • Re-emit internal observer events for optional downstream consumers
 *
 *  Public API:
 *    • constructor(options)
 *    • start()            – start accepting events & scheduled flushing
 *    • shutdown()         – flush remaining metrics & detach listeners
 *
 *  ---------------------------------------------------------------------------
 *  Copyright © StreamPulse Inc. – All rights reserved.
 ******************************************************************************************/

import { EventEmitter } from 'events';
import { setTimeout as delay } from 'timers/promises';
import crypto from 'crypto';
import pino from 'pino';

// Use global fetch for Node >=18, otherwise fall back to node-fetch
// eslint-disable-next-line import/no-extraneous-dependencies
import fetch from 'node-fetch';

/**
 * Generates a cryptographically-strong random jitter in milliseconds
 * to avoid sync-flush “thundering herd” problems across nodes.
 */
const randomJitter = (max = 250) => crypto.randomInt(0, max);

/**
 * Simple exponential back-off helper.
 */
class ExponentialBackoff {
  constructor(baseDelayMs = 500, maxDelayMs = 30_000) {
    this.base = baseDelayMs;
    this.max = maxDelayMs;
  }

  /**
   * Returns the delay for a given attempt, including random jitter.
   * @param {number} attempt – 0-based retry attempt.
   * @returns {number} delay in ms.
   */
  getDelay(attempt) {
    const exp = this.base * 2 ** attempt;
    const capped = Math.min(exp, this.max);
    return capped + randomJitter();
  }
}

/**
 * AnalyticsObserver – attaches to orchestrator bus and pushes telemetry to remote.
 */
export default class AnalyticsObserver extends EventEmitter {
  /**
   * @typedef {Object} AnalyticsObserverOptions
   * @property {EventEmitter} bus               – System-wide event bus (required)
   * @property {string}        endpoint         – HTTP endpoint for analytics ingest
   * @property {number}        flushIntervalMs  – Window before automatic flush
   * @property {number}        maxRetries       – Max retries per flush cycle
   * @property {pino.Logger}   logger           – Pino logger instance
   * @property {string}        nodeId           – Identifier for the running node
   */

  /**
   * @param {AnalyticsObserverOptions} opts
   */
  constructor(opts = {}) {
    super();

    const {
      bus,
      endpoint = process.env.ANALYTICS_ENDPOINT || 'http://analytics:8080/v1/metrics/batch',
      flushIntervalMs = 5_000,
      maxRetries = 5,
      logger = pino().child({ scope: 'AnalyticsObserver' }),
      nodeId = process.env.NODE_ID || `node-${crypto.randomUUID().slice(0, 8)}`,
    } = opts;

    if (!bus || !(bus instanceof EventEmitter)) {
      throw new TypeError('AnalyticsObserver expects a valid EventEmitter "bus"');
    }

    this._bus = bus;
    this._endpoint = endpoint;
    this._flushIntervalMs = flushIntervalMs;
    this._maxRetries = maxRetries;
    this._logger = logger;
    this._nodeId = nodeId;

    this._buffer = [];
    this._isStarted = false;
    this._flushTimer = null;
    this._backoff = new ExponentialBackoff();
  }

  /* -----------------------------------------------------------------------
   * Lifecycle Control
   * --------------------------------------------------------------------- */

  /**
   * Begin listening to events and schedule periodic flushes.
   */
  start() {
    if (this._isStarted) {
      this._logger.warn('start() invoked but observer is already running');
      return;
    }

    this._attachListeners();

    // Flush on an interval with slight jitter to avoid sync bursts.
    const initialDelay = this._flushIntervalMs + randomJitter();
    this._flushTimer = setInterval(
      () => this._flushSafely(),
      initialDelay,
    ).unref(); // Allow the process to exit if this is the only active timer.

    this._isStarted = true;
    this._logger.info({ nodeId: this._nodeId }, 'AnalyticsObserver started');
  }

  /**
   * Flush remaining metrics, detach listeners and stop timers.
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this._isStarted) return;

    clearInterval(this._flushTimer);
    this._detachListeners();

    // Ensure outstanding metrics are delivered before shutdown.
    await this._flushSafely(true);
    this._isStarted = false;
    this._logger.info('AnalyticsObserver stopped');
  }

  /* -----------------------------------------------------------------------
   * Event Collection
   * --------------------------------------------------------------------- */

  /**
   * Attach bus listeners for relevant events.
   * Bindings are hoisted to allow removal later.
   */
  _attachListeners() {
    this._onRouterStats = (payload) => this._enqueue('router.stats', payload);
    this._onStreamStarted = (payload) => this._enqueue('stream.started', payload);
    this._onStreamStopped = (payload) => this._enqueue('stream.stopped', payload);
    this._onSecurityEvent = (payload) => this._enqueue('security.event', payload);
    this._onRouterError = (payload) => this._enqueue('router.error', payload);

    // Register listeners.
    this._bus.on('router.stats', this._onRouterStats);
    this._bus.on('stream.started', this._onStreamStarted);
    this._bus.on('stream.stopped', this._onStreamStopped);
    this._bus.on('security.event', this._onSecurityEvent);
    this._bus.on('error', this._onRouterError);
  }

  /**
   * Detach previously attached listeners.
   */
  _detachListeners() {
    this._bus.off('router.stats', this._onRouterStats);
    this._bus.off('stream.started', this._onStreamStarted);
    this._bus.off('stream.stopped', this._onStreamStopped);
    this._bus.off('security.event', this._onSecurityEvent);
    this._bus.off('error', this._onRouterError);
  }

  /**
   * Push a normalised entry onto the buffer.
   * @param {string} type
   * @param {Object} payload
   */
  _enqueue(type, payload) {
    const now = Date.now();
    const record = {
      nodeId: this._nodeId,
      type,
      ts: payload?.ts ?? now,
      data: payload,
    };

    this._buffer.push(record);

    // Emit internally so other observers can daisy-chain if desired
    this.emit('queued', record);
  }

  /* -----------------------------------------------------------------------
   * Flushing Logic
   * --------------------------------------------------------------------- */

  /**
   * Flush wrapper that catches and logs all errors, preventing
   * unhandled rejections from crashing the node process.
   * @param {boolean} [force=false] – Force flush even if buffer is empty.
   * @returns {Promise<void>}
   */
  async _flushSafely(force = false) {
    try {
      await this._flushBatch(force);
    } catch (err) {
      this._logger.error({ err }, 'Fatal error while flushing analytics batch');
    }
  }

  /**
   * Flush collected metrics to the analytics service.
   * @param {boolean} [force=false] – Force flush even if buffer empty.
   * @returns {Promise<void>}
   */
  async _flushBatch(force = false) {
    if (!force && this._buffer.length === 0) {
      return; // Nothing to do
    }

    // Snapshot & clear buffer early to minimise contention.
    const batch = this._buffer.splice(0, this._buffer.length);
    const payload = {
      nodeId: this._nodeId,
      sentAt: Date.now(),
      metrics: batch,
    };

    this._logger.debug({ size: batch.length }, 'Flushing analytics batch');

    let attempt = 0;
    let success = false;

    while (attempt <= this._maxRetries && !success) {
      try {
        const res = await fetch(this._endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true, // Allow browsers/workers to send even on unload
        });

        if (!res.ok) {
          throw new Error(
            `analytics service responded with HTTP ${res.status} – ${await res.text()}`,
          );
        }

        success = true;
        this._logger.info({ attempt, count: batch.length }, 'Analytics batch delivered');

        // Re-emit to local listeners (e.g., dashboards, devtools)
        this.emit('flushed', { count: batch.length, attempt });
      } catch (err) {
        attempt += 1;
        if (attempt > this._maxRetries) {
          this._logger.error(
            { err, attempts: attempt },
            'Max retries reached – persisting batch for next interval',
          );
          // Prepend failed batch back onto buffer; eligibility for future retry.
          this._buffer.unshift(...batch);
          break;
        }

        const wait = this._backoff.getDelay(attempt);
        this._logger.warn(
          { err, attempt, wait },
          'Failed to deliver analytics batch – retrying after back-off',
        );

        // Wait before retrying
        await delay(wait);
      }
    }
  }
}

/* ----------------------------------------------------------------------------
 * Convenience factory – allows simple one-liner initialisation:
 *   import AnalyticsObserver from './AnalyticsObserver.js';
 *   AnalyticsObserver.bootstrap({ bus });
 * -------------------------------------------------------------------------- */
export function bootstrap(options) {
  const observer = new AnalyticsObserver(options);
  observer.start();
  return observer;
}
```