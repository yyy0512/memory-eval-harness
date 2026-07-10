```javascript
/**
 * StreamPulse Nexus – Media Orchestrator
 * --------------------------------------
 * Chain-of-Responsibility | Backup & Disaster Recovery
 *
 * AbstractRecoveryHandler.js
 *
 * All concrete recovery handlers (e.g. S3ReplicaHandler,
 * RtmpFailoverHandler, WebRtcDrainHandler) must extend this class.
 *
 * Responsibilities
 *  • Provide a common entry-point (`handle`) that orchestrates
 *    ‑ validation
 *    ‑ timings / metrics
 *    ‑ error bubbling
 *    ‑ delegation to the next handler in the chain
 *  • Expose a fluent API (`setNext`) to wire handlers together.
 *  • Offer an overridable `canHandle` predicate so handlers may
 *    short-circuit when the request isn’t relevant to them.
 *
 * Usage Example
 *  const chain = AbstractRecoveryHandler.buildChain([
 *      new PrimaryDatacenterFailoverHandler(cfg),
 *      new ColdStorageRestoreHandler(cfg),
 *      new NotifyPagerDutyHandler(cfg),
 *  ]);
 *
 *  await chain.handle(recoveryContext);
 */

'use strict';

const { performance } = require('node:perf_hooks');
const { EventEmitter } = require('node:events');
const { v4: uuid } = require('uuid');
const pino = require('pino');

/**
 * Discrete error type used by recovery handlers so that
 * caller can differentiate between recoverable vs. fatal.
 */
class RecoveryError extends Error {
  constructor(message, { cause, fatal = false } = {}) {
    super(message);
    this.name = 'RecoveryError';
    this.cause = cause;
    this.fatal = fatal;
    Error.captureStackTrace(this, RecoveryError);
  }
}

/**
 * RecoveryContext is the envelope object that flows through
 * the chain. It contains metadata about the failing component
 * alongside mutable response/progress data that downstream
 * handlers may inspect & amend.
 *
 * @typedef {Object} RecoveryContext
 * @property {string} jobId              – Correlated across handlers
 * @property {Date}   timestamp          – When the recovery was requested
 * @property {string} component          – e.g. ‘ingress-edge-21’
 * @property {string} failureMode        – e.g. ‘primary_down’
 * @property {Object} [payload]          – Additional, type-specific data
 * @property {Array.<string>} log        – Human-readable steps
 * @property {boolean} resolved          – Marked true when any handler finishes recovery
 * @property {EventEmitter} bus          – Event bus shared across handlers
 */

/**
 * @abstract
 */
class AbstractRecoveryHandler {
  /**
   * @param {Object} options
   * @param {pino.Logger} [options.logger]  - Injected application logger
   */
  constructor({ logger } = {}) {
    if (new.target === AbstractRecoveryHandler) {
      throw new TypeError('Cannot instantiate AbstractRecoveryHandler directly');
    }

    /** @type {AbstractRecoveryHandler|null} */
    this._next = null;

    this.logger = logger || pino({ name: this.constructor.name });
  }

  /**
   * Attach next handler in the chain.
   * Returns the next handler to support fluent wiring.
   *
   * @param {AbstractRecoveryHandler} next
   * @returns {AbstractRecoveryHandler}
   */
  setNext(next) {
    if (!(next instanceof AbstractRecoveryHandler)) {
      throw new TypeError('next must extend AbstractRecoveryHandler');
    }
    this._next = next;
    return next;
  }

  /**
   * Entry-point consumed by the client.
   *
   * @param {RecoveryContext} ctx
   * @returns {Promise<RecoveryContext>}
   */
  async handle(ctx) {
    if (!ctx || typeof ctx !== 'object') {
      throw new TypeError('RecoveryContext object required');
    }

    if (!ctx.jobId) ctx.jobId = uuid();
    if (!ctx.timestamp) ctx.timestamp = new Date();
    if (!ctx.log) ctx.log = [];
    if (!ctx.bus) ctx.bus = new EventEmitter();
    if (ctx.resolved) {
      // Somebody up-stream has already resolved the failure;
      // nothing more to do.
      return ctx;
    }

    // Performance metric
    const start = performance.now();

    try {
      // Determine if this handler is relevant
      if (await this.canHandle(ctx)) {
        await this._handle(ctx);

        // If the handler claims responsibility for resolving the issue,
        // mark it so downstream handlers can bail early.
        if (ctx.resolved) {
          this.logger.info(
            { jobId: ctx.jobId },
            `${this.constructor.name} resolved recovery`
          );
        }
      } else {
        this.logger.debug(
          { jobId: ctx.jobId },
          `${this.constructor.name} skipped – canHandle returned false`
        );
      }
    } catch (err) {
      // Wrap unknown exceptions into RecoveryError for uniformity
      if (!(err instanceof RecoveryError)) {
        err = new RecoveryError(err.message, { cause: err, fatal: true });
      }

      ctx.log.push(
        `[${this.constructor.name}] ERROR: ${err.message}`
      );
      this.logger.error(
        { jobId: ctx.jobId, err },
        `${this.constructor.name} encountered error`
      );

      // Re-throw fatal errors, bubble non-fatal downstream
      if (err.fatal) {
        throw err;
      }
    } finally {
      const end = performance.now();
      ctx.log.push(
        `[${this.constructor.name}] duration=${(end - start).toFixed(2)}ms`
      );
      this.logger.debug(
        { jobId: ctx.jobId, duration: end - start },
        `${this.constructor.name} finished`
      );
    }

    // Continue chain if not yet resolved and next handler exists
    if (!ctx.resolved && this._next) {
      return this._next.handle(ctx);
    }

    return ctx;
  }

  /**
   * Predicate indicating whether this handler should run.
   * Sub-classes can override for domain-specific routing.
   *
   * @param {RecoveryContext} _ctx
   * @returns {boolean|Promise<boolean>}
   */
  async canHandle(_ctx) {
    return true; // default – always handle
  }

  /**
   * Concrete classes must implement recovery logic here.
   *
   * @abstract
   * @param {RecoveryContext} ctx
   * @returns {Promise<void>}
   * @throws {RecoveryError} to signal domain-specific failure
   */
  /* eslint-disable-next-line no-unused-vars */
  async _handle(ctx) {
    throw new Error('_handle(ctx) must be implemented by subclass');
  }

  // ------------------------------------------------------------------ //
  //  Utility helpers                                                   //
  // ------------------------------------------------------------------ //

  /**
   * Build chain in a single call
   *
   * @param {Array<AbstractRecoveryHandler>} handlers
   * @returns {AbstractRecoveryHandler} – Head of the chain
   */
  static buildChain(handlers) {
    if (!Array.isArray(handlers) || handlers.length === 0) {
      throw new Error('handlers array must be non-empty');
    }
    return handlers.reduce((prev, curr, idx) => {
      if (idx === 0) return curr;
      handlers[idx - 1].setNext(curr);
      return handlers[0];
    }, null);
  }
}

// Export symbols for consumers
module.exports = {
  AbstractRecoveryHandler,
  RecoveryError,
};
```