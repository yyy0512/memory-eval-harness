```typescript
/**
 * src/utils.ts
 *
 * A collection of strongly-typed, production-grade utility helpers that are shared
 * across the SocialPulse Gateway code-base.  The helpers in this file are kept
 * framework-agnostic (i.e. they should NOT import NestJS/Express/Apollo, etc.) so
 * that they can be safely consumed from any layer—presentation, application,
 * domain or infrastructure—without introducing additional coupling.
 */

import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import createHttpError from 'http-errors';
import ms from 'ms';
import pRetry, { FailedAttemptError, AbortError, Options as RetryOptions } from 'p-retry';
import pTimeout from 'p-timeout';
import winston, { Logger } from 'winston';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                               🛠  Type Helpers                              */
/* -------------------------------------------------------------------------- */

/**
 * Type-guard that removes `null` and `undefined` from a union.
 */
export function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Utility function for exhaustive checks in discriminated unions.
 * Usage: `default: assertUnreachable(x)` in switch statements.
 */
export function assertUnreachable(_: never): never {
  throw new Error('Reached Unreachable Code Path');
}

/* -------------------------------------------------------------------------- */
/*                              📜 Environment                               */
/* -------------------------------------------------------------------------- */

/**
 * Centralised, schema-validated access to process.env.
 * Validation occurs once on first call and the result is memoised to prevent
 * expensive work for subsequent invocations.
 */
const EnvSchema = z
  .object({
    NODE_ENV   : z.enum(['development', 'test', 'production']).default('development'),
    PORT       : z.string().regex(/^\d+$/).default('8080').transform(Number),
    REDIS_URL  : z.string().url(),
    LOG_LEVEL  : z
      .enum(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly'])
      .default('info'),
    REQUEST_TIMEOUT : z.string().default('30s'), // human-readable duration
  })
  .strict();

export type Env = z.infer<typeof EnvSchema>;

let _envCache: Env | null = null;

/**
 * Lazily validated & memoised environment loader.
 */
export function env(): Env {
  if (_envCache) return _envCache;
  const parsed = EnvSchema.parse(process.env);
  _envCache = parsed;
  return parsed;
}

/* -------------------------------------------------------------------------- */
/*                                📝  Logging                                 */
/* -------------------------------------------------------------------------- */

/**
 * Singleton logger instance shared by the entire gateway.
 * Winston is used because it has broad ecosystem support & async safety.
 */
const _logger: Logger = winston.createLogger({
  level   : env().LOG_LEVEL,
  format  : winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'socialpulse-gateway' },
  transports  : [new winston.transports.Console()],
});

export const logger = _logger;

/* -------------------------------------------------------------------------- */
/*                          🆔  Request-scoped Values                         */
/* -------------------------------------------------------------------------- */

/**
 * Generates an RFC-4122 v4 compliant identifier that can be stitched into
 * request/trace headers, log entries, etc.
 */
export function generateRequestId(): string {
  return randomUUID();
}

/* -------------------------------------------------------------------------- */
/*                                ⏱  Timing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Measures the wall-clock time (high-resolution) it takes to execute an async
 * function.  The result and the duration in milliseconds are returned.
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
  label?: string,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  try {
    const result = await fn();
    return { result, durationMs: performance.now() - start };
  } finally {
    const total = performance.now() - start;
    if (label) {
      logger.debug(`⏱  [${label}] executed in ${total.toFixed(2)} ms`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                            💥  Retry & Timeout                             */
/* -------------------------------------------------------------------------- */

/**
 * Wraps a promise with a timeout.  If the timeout elapses the promise is
 * rejected with a 504 (Gateway Timeout) HTTP error.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeout: string | number = env().REQUEST_TIMEOUT,
  message = 'Upstream service did not respond in time',
): Promise<T> {
  const milliseconds = typeof timeout === 'number' ? timeout : ms(timeout);
  return pTimeout(promise, {
    milliseconds,
    message,
    customTimers: {
      setTimeout,
      clearTimeout,
    },
  }).catch(err => {
    // Re-wrap with http-errors so that upstream handlers can differentiate.
    throw createHttpError(504, err);
  });
}

/**
 * Generic, opinionated retry helper that implements exponential back-off
 * with full-jitter (AWS-style) between attempts.
 *
 * Example:
 *   const data = await retry(() => fetchUserFeed(userId));
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const baseOptions: RetryOptions = {
    retries      : 3,
    factor       : 2,
    minTimeout   : 250,
    maxTimeout   : 2_000,
    randomize    : true,
    onFailedAttempt(error: FailedAttemptError<T>) {
      logger.warn(
        `Retrying (${error.attemptNumber}/${error.retriesLeft}) after error: ${error.message}`,
        { attempt: error.attemptNumber, retriesLeft: error.retriesLeft },
      );
    },
    ...opts,
  };

  return pRetry(fn, baseOptions).catch(error => {
    if (error instanceof AbortError) {
      // p-retry signals non-retriable errors with AbortError.
      throw error.originalError;
    }
    throw error;
  });
}

/* -------------------------------------------------------------------------- */
/*                          🗄  Cache-Key Utilities                           */
/* -------------------------------------------------------------------------- */

export interface CacheKeyParts {
  /** Namespace segment, e.g. 'timeline' | 'profile' */
  ns: string;
  /** Primary resource identifier */
  id?: string | number;
  /** Optional bag of query parameters (will be serialised) */
  params?: Record<string, unknown>;
}

/**
 * Builds a deterministic cache-key for Redis et al.
 *
 * Example:
 *   buildCacheKey({ ns: 'timeline', id: userId, params: { limit: 50 } });
 *   // > "timeline:12345|limit=50"
 */
export function buildCacheKey({ ns, id, params }: CacheKeyParts): string {
  const parts: string[] = [ns];

  if (isDefined(id)) parts.push(String(id));

  if (params && Object.keys(params).length > 0) {
    const search = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    parts.push(search.toString());
  }

  return parts.join(':');
}

/* -------------------------------------------------------------------------- */
/*                              🔐  Safe JSON                                */
/* -------------------------------------------------------------------------- */

/**
 * Safer JSON.parse that never throws.
 */
export function safeJSONParse<T = unknown>(
  value: string,
  fallback?: T,
): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch (err) {
    logger.debug('safeJSONParse failed', { error: (err as Error).message });
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/*                            🔄  Deferred Promise                            */
/* -------------------------------------------------------------------------- */

/**
 * A small helper that exposes the resolve & reject functions of a Promise so
 * that it can be resolved externally (think: event buses, cancellable tasks...)
 */
export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject  = rej;
  });

  return { promise, resolve, reject };
}

/* -------------------------------------------------------------------------- */
/*                       📄  Pagination Parameter Parser                      */
/* -------------------------------------------------------------------------- */

export interface Pagination {
  limit: number;
  offset: number;
}

/**
 * Parses typical ?limit=xx&offset=yy query params and sanitises them.
 */
export function parsePagination(
  params: Partial<Record<'limit' | 'offset', string | number>>,
  options: { maxLimit?: number } = {},
): Pagination {
  const max = options.maxLimit ?? 100;

  const limit  = Math.min(Number(params.limit ?? 20), max);
  const offset = Math.max(Number(params.offset ?? 0), 0);

  return { limit, offset };
}
```