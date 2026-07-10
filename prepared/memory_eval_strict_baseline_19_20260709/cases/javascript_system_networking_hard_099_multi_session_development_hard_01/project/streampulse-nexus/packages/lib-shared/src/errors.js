```javascript
/**
 * StreamPulse Nexus – Shared Error Library
 *
 * Centralised collection of strongly-typed Error classes that are consumed by
 * every runtime package (ingress, egress, edge-cache, analytics, etc.).  Besides
 * the domain-specific subclasses, the module also exposes utilities for
 * serialising, deserialising and uniformly wrapping async functions so that
 * telemetry and retry semantics remain consistent throughout the platform.
 *
 * NOTE:  This file must stay dependency-free except for `uuid`, which is small
 *        and already part of the global deployment bundle.
 */

import { v4 as uuidv4 } from 'uuid';
import os from 'os';

/* -------------------------------------------------------------------------- */
/* Helpers & Constants                                                        */
/* -------------------------------------------------------------------------- */

const HOSTNAME = os.hostname();

/**
 * Registry that maps error codes to classes so that deserialisation can pick
 * the correct prototype chain regardless of module boundaries.
 * @type {Map<string, typeof NexusError>}
 */
const _classRegistry = new Map();

/**
 * Tiny assert helper for internal invariants.
 * @param {boolean} condition
 * @param {string} msg
 */
function _invariant(condition, msg) {
  if (!condition) {
    throw new Error(`[NexusErrorInvariant] ${msg}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Base Error Class                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Base class extended by *every* custom error in the Nexus codebase.  Includes
 * rich metadata for observability and standardises shape across boundaries
 * (worker-threads, micro-services, browser <-> server, etc.).
 */
export class NexusError extends Error {
  /**
   * @param {string}  message                     Human-readable description
   * @param {object}  [options]
   * @param {string}  [options.code='UNKNOWN']    Stable machine-parseable code
   * @param {object}  [options.details={}]        Arbitrary serialisable meta
   * @param {Error}   [options.cause]             Original lower-level error
   * @param {boolean} [options.retryable=false]   Hint for Retry policies
   */
  constructor(
    message,
    {
      code = 'UNKNOWN',
      details = {},
      cause = undefined,
      retryable = false,
    } = {},
  ) {
    super(message, { cause });

    // Force correct prototype when transpiling
    Object.setPrototypeOf(this, new.target.prototype);

    this.name = this.constructor.name;
    this.code = code;
    this.details = { ...details };
    this.cause = cause;
    this.retryable = Boolean(retryable);
    this.traceId = this.details.traceId || uuidv4();
    this.hostname = HOSTNAME;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Serialise error to plain object so it can cross process-boundaries.
   * @returns {SerializedNexusError}
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      details: this.details,
      retryable: this.retryable,
      traceId: this.traceId,
      hostname: this.hostname,
      timestamp: this.timestamp,
      stack: this.stack,
      cause: this.cause
        ? typeof this.cause.toJSON === 'function'
          ? this.cause.toJSON()
          : {
              name: this.cause.name,
              message: this.cause.message,
              stack: this.cause.stack,
            }
        : undefined,
    };
  }

  /**
   * Register subclass in global registry; executed once per class definition.
   * @private
   */
  static _register() {
    // Allow subclasses without code (abstract). Skip them.
    if (this === NexusError) return;
    _invariant(
      typeof this.CODE === 'string' && this.CODE.length > 0,
      `${this.name} must declare static CODE`,
    );

    if (_classRegistry.has(this.CODE)) {
      /* eslint-disable-next-line no-console */
      console.warn(
        `[NexusError] Overriding duplicate code '${this.CODE}' ` +
          `with class '${this.name}'.`,
      );
    }
    _classRegistry.set(this.CODE, this);
  }

  /**
   * Recreates an Error instance from its JSON representation.
   * Falls back to NexusError if code is unknown in current process.
   * @param {SerializedNexusError} payload
   * @returns {NexusError}
   */
  static fromJSON(payload) {
    const {
      name,
      message,
      code,
      details,
      retryable,
      traceId,
      hostname,
      timestamp,
      stack,
      cause,
    } = payload;

    const ErrorClass = _classRegistry.get(code) || NexusError;

    const err = new ErrorClass(message, {
      code,
      details: { ...details, traceId }, // Preserve original traceId
      retryable,
      cause: cause ? NexusError.fromJSON(cause) : undefined,
    });

    err.hostname = hostname;
    err.timestamp = timestamp;
    err.stack = stack; // Preserve original stack trace (string)
    return err;
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete Error Subclasses                                                  */
/* -------------------------------------------------------------------------- */

export class NetworkError extends NexusError {
  static CODE = 'NETWORK_ERROR';
  constructor(message = 'Network error', options = {}) {
    super(message, { ...options, code: NetworkError.CODE });
  }
}
NetworkError._register();

export class TimeoutError extends NetworkError {
  static CODE = 'TIMEOUT';
  constructor(message = 'Operation timed out', options = {}) {
    super(message, { ...options, code: TimeoutError.CODE, retryable: true });
  }
}
TimeoutError._register();

export class ValidationError extends NexusError {
  static CODE = 'VALIDATION_ERROR';
  constructor(message = 'Validation failed', options = {}) {
    super(message, { ...options, code: ValidationError.CODE });
  }
}
ValidationError._register();

export class SecurityError extends NexusError {
  static CODE = 'SECURITY_ERROR';
  constructor(message = 'Security violation', options = {}) {
    super(message, { ...options, code: SecurityError.CODE });
  }
}
SecurityError._register();

export class ConfigurationError extends NexusError {
  static CODE = 'CONFIGURATION_ERROR';
  constructor(message = 'Invalid system configuration', options = {}) {
    super(message, { ...options, code: ConfigurationError.CODE });
  }
}
ConfigurationError._register();

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Quick type guard.
 * @param {unknown} err
 * @returns {err is NexusError}
 */
export function isNexusError(err) {
  return (
    typeof err === 'object' &&
    err !== null &&
    ('code' in err || err instanceof NexusError)
  );
}

/**
 * Convenience: check if an error is retryable.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  return isNexusError(err) ? Boolean(err.retryable) : false;
}

/**
 * Serialises *any* error into something that can safely cross the wire.
 * For unknown types, it captures best-effort information.
 * @param {unknown} err
 * @returns {SerializedNexusError}
 */
export function serializeError(err) {
  if (isNexusError(err)) {
    return err.toJSON();
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      code: 'GENERIC_ERROR',
      details: {},
      retryable: false,
      traceId: uuidv4(),
      hostname: HOSTNAME,
      timestamp: new Date().toISOString(),
      stack: err.stack,
    };
  }
  // Non-Error throwables (numbers, strings, objects, etc.)
  return {
    name: 'NonErrorThrow',
    message: String(err),
    code: 'NON_ERROR_THROW',
    details: {},
    retryable: false,
    traceId: uuidv4(),
    hostname: HOSTNAME,
    timestamp: new Date().toISOString(),
    stack: undefined,
  };
}

/**
 * Opposite of `serializeError`.
 * @param {SerializedNexusError} payload
 * @returns {NexusError}
 */
export function deserializeError(payload) {
  return NexusError.fromJSON(payload);
}

/**
 * Higher-order function that wraps async operations.  Any thrown values are
 * converted to NexusErrors (if needed) and optionally passed to a reporting
 * callback (e.g., Sentry, Datadog, Prometheus).
 *
 * Example:
 *    const safeFetch = wrapAsync(fetchWithRetry, { reporter: err => logger.error(err) });
 *
 * @template T
 * @param {(...args: any[]) => Promise<T>} fn
 * @param {object}  [options]
 * @param {(err: NexusError) => void} [options.reporter]  Hook for telemetry
 * @param {boolean} [options.rethrow=true]                Whether to rethrow
 * @returns {(...args: any[]) => Promise<T | undefined>}
 */
export function wrapAsync(fn, { reporter, rethrow = true } = {}) {
  return async function wrapped(...args) {
    try {
      return await fn(...args);
    } catch (raw) {
      const error = isNexusError(raw)
        ? raw
        : new NexusError('Unhandled error', { cause: raw });

      if (typeof reporter === 'function') {
        try {
          reporter(error);
        } catch (reportErr) {
          /* eslint-disable-next-line no-console */
          console.error('[NexusError] Reporter threw:', reportErr);
        }
      }

      if (rethrow) throw error;
      return undefined;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Type Declarations (JSDoc)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} SerializedNexusError
 * @property {string} name
 * @property {string} message
 * @property {string} code
 * @property {object} details
 * @property {boolean} retryable
 * @property {string} traceId
 * @property {string} hostname
 * @property {string} timestamp
 * @property {string} [stack]
 * @property {SerializedNexusError} [cause]
 */
```