```javascript
/*************************************************************************
 * StreamPulse Nexus – Media Orchestrator
 * CommandInvoker
 *
 * This module is the heart of the Command-pattern implementation that
 * powers operational actions across media clusters (e.g. fail-over,
 * drain-node, bootstrap-edge-cache, request-backup, etc.).
 *
 *  – Provides:
 *      • Concurrency-aware execution queue
 *      • Automatic retries & per-command timeouts
 *      • Undo/rollback support
 *      • EventEmitter interface for observability (metrics / alerting)
 *
 *  – Each command *must* expose at minimum:
 *      • execute(context):   Promise<any>
 *      • undo?(context):     Promise<any>  ← optional but strongly advised
 *
 * Production-quality concerns baked in:
 *      • Proper error handling + stack preservation
 *      • Metrics hooks
 *      • Pluggable logging implementation (defaults to console)
 *************************************************************************/

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';

/**
 * @typedef {Object} CommandInvokerOptions
 * @property {number} [concurrency=5]            Max parallel executions.
 * @property {number} [defaultTimeout=15_000]    ms before a command is aborted.
 * @property {number} [maxRetries=2]             Attempts after initial failure.
 * @property {import('winston').Logger|Console}  [logger=console]  Logging impl.
 */

/**
 * @typedef {Object} InvokeOptions
 * @property {number} [timeout]      Override defaultTimeout (ms).
 * @property {number} [retries]      Override maxRetries.
 * @property {boolean} [undoOnError] When true, undo() is auto-invoked on error.
 */

export default class CommandInvoker extends EventEmitter {
  /**
   * @param {CommandInvokerOptions} [options]
   */
  constructor(options = {}) {
    super();

    const {
      concurrency = 5,
      defaultTimeout = 15_000,
      maxRetries = 2,
      logger = console,
    } = options;

    this.concurrency = concurrency;
    this.defaultTimeout = defaultTimeout;
    this.maxRetries = maxRetries;
    this.logger = logger;

    /** @type {Array<QueuedCommand>} */
    this._queue = [];
    /** @type {Set<QueuedCommand>} */
    this._inFlight = new Set();
    /** @type {Array<QueuedCommand>} */
    this._history = []; // for undo()
  }

  /**
   * Enqueues and eventually executes a single command.
   * @template T
   * @param {{ execute(context: any): Promise<T>, undo?(context:any):Promise<any>}} command
   * @param {any} context    Arbitrary contextual data (e.g. node descriptor).
   * @param {InvokeOptions} [options]
   * @returns {Promise<T>}
   */
  invoke(command, context = {}, options = {}) {
    const task = this._wrapCommand(command, context, options);
    this._queue.push(task);
    this._next(); // kick off if capacity available
    return task.completionPromise;
  }

  /**
   * Bulk enqueue multiple commands preserving order.
   * @param {Array<any>} commands
   * @param {any} context
   * @param {InvokeOptions} [options]
   * @returns {Promise<Array<any>>}
   */
  async invokeBatch(commands, context = {}, options = {}) {
    const results = [];
    for (const cmd of commands) {
      results.push(this.invoke(cmd, context, options));
    }
    return Promise.all(results);
  }

  /**
   * Attempts to rollback the most recently executed command that supports undo().
   * @returns {Promise<void>}
   */
  async undoLast() {
    const last = [...this._history].reverse().find(c => typeof c.command.undo === 'function');
    if (!last) {
      this.logger.warn('[CommandInvoker] No command with undo() in history');
      return;
    }
    await this._attemptUndo(last);
  }

  /**
   * Undoes *all* executed commands in reverse order (best effort).
   * @returns {Promise<void>}
   */
  async undoAll() {
    for (const task of [...this._history].reverse()) {
      if (typeof task.command.undo === 'function') {
        await this._attemptUndo(task);
      }
    }
  }

  /* ────────────────────────────── Private helpers ────────────────────────── */

  /**
   * Wrap a raw command object into QueuedCommand with full bookkeeping.
   * @param {any} command
   * @param {any} context
   * @param {InvokeOptions} options
   * @returns {QueuedCommand}
   */
  _wrapCommand(command, context, options) {
    if (!command || typeof command.execute !== 'function') {
      throw new TypeError('[CommandInvoker] Invalid command supplied (missing execute())');
    }

    const taskId = uuidv4();
    const {
      timeout = this.defaultTimeout,
      retries = this.maxRetries,
      undoOnError = true,
    } = options;

    /** @type {QueuedCommand} */
    const task = {
      id: taskId,
      command,
      context,
      timeout,
      retries,
      undoOnError,
      attempts: 0,
      status: 'queued',
      result: undefined,
      error: undefined,
    };

    task.completionPromise = new Promise((resolve, reject) => {
      task._resolve = resolve;
      task._reject = reject;
    });

    return task;
  }

  /**
   * Process queue if capacity is available.
   */
  _next() {
    while (this._inFlight.size < this.concurrency && this._queue.length) {
      const task = this._queue.shift();
      this._executeTask(task);
    }
  }

  /**
   * Execute individual QueuedCommand with retries and timeout.
   * @param {QueuedCommand} task
   */
  async _executeTask(task) {
    this._inFlight.add(task);
    task.attempts += 1;
    task.status = 'running';

    const { command, context, timeout } = task;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeout);

    try {
      const execution = command.execute(context, { signal: timeoutController.signal });

      // Ensure execute() returns a promise
      if (typeof execution?.then !== 'function') {
        throw new TypeError('execute() must return a Promise');
      }

      task.result = await execution;
      task.status = 'completed';
      this._history.push(task);
      task._resolve(task.result);
      this.emit('executed', { id: task.id, result: task.result });
    } catch (err) {
      task.error = err;
      task.status = 'failed';

      // Retry logic
      if (task.attempts <= task.retries) {
        this.logger.warn(
          `[CommandInvoker] Command ${task.id} failed (attempt ${task.attempts}). Retrying…`
        );
        this._queue.unshift(task); // requeue at front for immediate retry
      } else {
        // Exhausted retries
        this.logger.error(
          `[CommandInvoker] Command ${task.id} failed permanently after ${task.attempts} attempts`
        );
        if (task.undoOnError && typeof command.undo === 'function') {
          try {
            await command.undo(context);
            this.emit('undone', { id: task.id });
          } catch (undoErr) {
            this.logger.error(
              `[CommandInvoker] Undo for command ${task.id} failed: ${undoErr.message}`
            );
            // swallow undo error (original error is more important)
          }
        }

        task._reject(err);
        this.emit('failed', { id: task.id, error: err });
      }
    } finally {
      clearTimeout(timer);
      this._inFlight.delete(task);
      // continue processing queue
      this._next();
    }
  }

  /**
   * Attempts to undo a command and logs result.
   * @param {QueuedCommand} task
   */
  async _attemptUndo(task) {
    if (task.status !== 'completed') {
      this.logger.warn(`[CommandInvoker] Cannot undo command in status ${task.status}`);
      return;
    }
    try {
      await task.command.undo(task.context);
      this.logger.info(`[CommandInvoker] Undo successful for command ${task.id}`);
      this.emit('undone', { id: task.id });
    } catch (err) {
      this.logger.error(`[CommandInvoker] Undo failed for command ${task.id}: ${err.message}`);
      this.emit('undo_failed', { id: task.id, error: err });
      throw err;
    }
  }
}

/* ──────────────────────────────── Type defs ─────────────────────────────── */

/**
 * @typedef {Object} QueuedCommand
 * @property {string} id
 * @property {any} command
 * @property {any} context
 * @property {number} timeout
 * @property {number} retries
 * @property {boolean} undoOnError
 * @property {number} attempts
 * @property {'queued'|'running'|'completed'|'failed'} status
 * @property {any} result
 * @property {Error} [error]
 * @property {Promise<any>} completionPromise
 * @property {(value:any)=>void} _resolve
 * @property {(reason:any)=>void} _reject
 */
```