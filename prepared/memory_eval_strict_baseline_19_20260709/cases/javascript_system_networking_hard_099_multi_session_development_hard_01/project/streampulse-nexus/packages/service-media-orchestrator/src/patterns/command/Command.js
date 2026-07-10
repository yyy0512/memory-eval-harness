```javascript
/**
 * StreamPulse Nexus – Media Orchestrator
 * --------------------------------------
 * Base “Command” implementation shared by all disaster-recovery
 * and orchestration commands in the platform.  Encapsulates an
 * executable action as well as the bookkeeping required for
 * monitoring, retries, timeouts, cancellations, and auditing.
 *
 * Commands are executed by the CommandBus which may run them
 * locally or forward them to another node in the cluster using
 * the Chain-of-Responsibility pattern.
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │              Command  (this module)                         │
 *  │                  ▲          ▲                              │
 *  │                  │          │                              │
 *  │          ┌───────┘          └────────┐                     │
 *  │          │                           │                     │
 *  │   TranscodeSegmentCmd        FlushCacheCmd   …             │
 *  └─────────────────────────────────────────────────────────────┘
 *
 *  – Abstract methods:
 *      _execute(context)   : Promise<any>
 *      _rollback(context)  : Promise<void> | void  (optional)
 *
 *  – Public API:
 *      execute(context)    : Promise<any>
 *      abort(reason?)      : void
 *      toJSON()            : Serialized command state
 *
 *  – Typical lifecycle:
 *      PENDING → RUNNING → (SUCCEEDED | FAILED | ABORTED | TIMED_OUT)
 */

import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js'; // local thin wrapper around pino/winston

/**
 * @typedef {import('../types').ExecutionContext} ExecutionContext
 * An opaque object passed in by the orchestrator containing services,
 * secrets, cluster topology, etc.  The exact shape is intentionally
 * hidden from the command so that it cannot violate bounded contexts.
 */

const log = createLogger({ module: 'command' });

/**
 * Enumeration of command statuses.
 * @readonly
 * @enum {string}
 */
export const STATUS = Object.freeze({
  PENDING:    'PENDING',
  RUNNING:    'RUNNING',
  SUCCEEDED:  'SUCCEEDED',
  FAILED:     'FAILED',
  ABORTED:    'ABORTED',
  TIMED_OUT:  'TIMED_OUT',
});

/**
 * Custom error base-class used by commands.
 */
export class CommandError extends Error {
  constructor(message, metadata = {}) {
    super(message);
    this.name = 'CommandError';
    this.metadata = { ...metadata };
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class TimeoutError extends CommandError {
  constructor(timeoutMs) {
    super(`Command timed out after ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
  }
}

export class AbortError extends CommandError {
  constructor(reason = 'Command aborted by caller') {
    super(reason);
    this.name = 'CommandAbortError';
  }
}

/**
 * Base Command class.
 */
export class Command extends EventEmitter {

  /**
   * @param {object} [options]
   * @param {string} [options.name]        Human-friendly name for logging.
   * @param {number} [options.timeout]     Hard timeout (ms) before the command is force-failed.
   * @param {number} [options.maxRetries]  Number of retry attempts before giving up.
   * @param {boolean} [options.retriable]  If false, the command will never be retried.
   */
  constructor(options = {}) {
    super();

    const {
      name        = /** @type {string} */ (this.constructor.name),
      timeout     = 30_000, // default 30s
      maxRetries  = 0,
      retriable   = true,
    } = options;

    /** @readonly */ this.id          = uuidv4();
    /** @readonly */ this.name        = name;
    /** @readonly */ this.timeoutMs   = Math.max(0, timeout);
    /** @readonly */ this.maxRetries  = Math.max(0, maxRetries);
                  this.retriable     = retriable;

    this._status     = STATUS.PENDING;
    this._startTs    = null;
    this._endTs      = null;
    this._duration   = null;
    this._attempt    = 0;
    this._abortCtl   = new AbortController();
    this._abortReason = undefined;
    this._result     = undefined;
    this._error      = undefined;
  }

  /**
   * Public getter exposing current status.
   * @returns {STATUS}
   */
  get status() {
    return this._status;
  }

  /**
   * Whether the command is finished (succeeded, failed, aborted or timed out).
   * @returns {boolean}
   */
  get isFinal() {
    return [
      STATUS.SUCCEEDED,
      STATUS.FAILED,
      STATUS.ABORTED,
      STATUS.TIMED_OUT,
    ].includes(this._status);
  }

  /**
   * Execute the command.
   * @param {ExecutionContext} context – Provided by orchestrator.
   * @returns {Promise<any>}           – Whatever the command decides to return.
   */
  async execute(context = Object.freeze({})) {
    if (this._status !== STATUS.PENDING) {
      throw new CommandError(`Cannot execute command in ${this._status} state`);
    }

    this._attempt++;
    this._startTs = performance.now();
    this._status  = STATUS.RUNNING;
    this.emit('status', this._status);

    log.debug({ cmdId: this.id, name: this.name }, 'Command started');

    try {
      // Setup timeout enforcement
      const { signal } = this._abortCtl;
      const runPromise = this._execute(context, { signal });

      const timeoutPromise = this.timeoutMs
        ? delay(this.timeoutMs, null, { signal }).then(() => {
            throw new TimeoutError(this.timeoutMs);
          })
        : new Promise(() => {}); // never resolves

      // race between task and timeout/abort
      this._result = await Promise.race([runPromise, timeoutPromise]);

      this._status = STATUS.SUCCEEDED;
      log.debug({ cmdId: this.id, name: this.name }, 'Command succeeded');
      return this._result;
    } catch (err) {
      if (err instanceof TimeoutError) {
        this._status = STATUS.TIMED_OUT;
      } else if (err instanceof AbortError) {
        this._status = STATUS.ABORTED;
      } else {
        this._status = STATUS.FAILED;
      }

      this._error = err;
      log.warn({ cmdId: this.id, name: this.name, err }, 'Command failed');

      // Retry logic
      if (this._shouldRetry(err)) {
        log.info({ cmdId: this.id, attempt: this._attempt }, 'Retrying command');
        return this.execute(context);
      }

      throw err;
    } finally {
      this._endTs  = performance.now();
      this._duration = this._endTs - this._startTs;
      this.emit('status', this._status);
    }
  }

  /**
   * Cancel execution (idempotent).
   * @param {string|Error} [reason]
   */
  abort(reason) {
    if (this.isFinal) return;
    this._abortReason = reason ?? 'Abort requested';
    this._abortCtl.abort(new AbortError(this._abortReason));
  }

  /**
   * Undo/rollback the command if supported.
   * Best-effort – failures are logged but not rethrown so that callers
   * have freedom to ignore rollbacks.
   * @param {ExecutionContext} context
   * @returns {Promise<void>}
   */
  async rollback(context = Object.freeze({})) {
    if (typeof this._rollback !== 'function') {
      log.debug({ cmdId: this.id, name: this.name }, 'Rollback not implemented – skipping');
      return;
    }

    try {
      await this._rollback(context);
      log.info({ cmdId: this.id, name: this.name }, 'Rollback completed');
    } catch (e) {
      log.error({ cmdId: this.id, name: this.name, err: e }, 'Rollback failed');
    }
  }

  /**
   * JSON serialization (for logging, persistence, etc.).
   * @returns {object}
   */
  toJSON() {
    return {
      id:           this.id,
      name:         this.name,
      status:       this._status,
      attempt:      this._attempt,
      durationMs:   this._duration,
      timeoutMs:    this.timeoutMs,
      startedAt:    this._startTs,
      completedAt:  this._endTs,
      result:       this._result,
      error:        this._error ? { name: this._error.name, message: this._error.message } : null,
    };
  }

  /* ---------------------------------------------------------------------- */
  /*                     ABSTRACT / OVERRIDABLE METHODS                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Concrete command implementation MUST override this.
   * @abstract
   * @param {ExecutionContext} context
   * @param {{ signal: AbortSignal }} opts
   * @returns {Promise<any>}
   */
  // eslint-disable-next-line no-unused-vars
  async _execute(context, { signal }) {
    throw new CommandError('"_execute" method has to be implemented in subclass');
  }

  /**
   * Optionally override to support rollback.
   * @param {ExecutionContext} context
   * @returns {Promise<void>|void}
   */
  // eslint-disable-next-line no-unused-vars
  async _rollback(context) {} // noop default

  /* ---------------------------------------------------------------------- */
  /*                             PRIVATE HELPERS                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Determine whether the command should be retried.
   * @param {Error} err
   * @returns {boolean}
   */
  _shouldRetry(err) {
    if (!this.retriable) return false;
    if (this._attempt > this.maxRetries) return false;
    if (err instanceof AbortError) return false; // explicit abort should not retry

    // Add pattern-based or error-type-based retry logic as needed
    return true;
  }
}

/**
 * Type guard.
 * @param {any} maybeCmd
 * @returns {maybeCmd is Command}
 */
export function isCommand(maybeCmd) {
  return maybeCmd instanceof Command;
}

```