```typescript
/**
 * InsightHexaAI – Strategic ML Inference Suite
 * ------------------------------------------------
 * Shared utilities used across the entire code-base.
 *
 * This file purposefully contains *no business logic*;
 * only side-effect–free helpers that simplify day-to-day
 * programming chores such as logging, retry policies,
 * timeout control, deep cloning, hashing, etc.
 *
 * Because utilities are imported virtually everywhere,
 * KEEP THIS FILE LEAN and AVOID pulling heavy-weight
 * dependencies that would otherwise bloat the dependency
 * graph or introduce circular references.
 */

import fs from 'node:fs';
import { promises as fsAsync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { EventEmitter } from 'node:events';
import pino, { Logger } from 'pino';

/* -------------------------------------------------------------------------- */
/*                           LOGGER INITIALISATION                            */
/* -------------------------------------------------------------------------- */

/**
 * Returns a pino logger whose default configuration is
 * decided via environment variables:
 *   LOG_LEVEL   = (fatal|error|warn|info|debug|trace)
 *   LOG_PRETTY  = 1 | 0
 */
export function createLogger(serviceName = 'InsightHexaAI'): Logger {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  const pretty =
    process.env.LOG_PRETTY === '1' || process.env.NODE_ENV === 'development';

  const destination =
    pretty && process.stdout.isTTY
      ? pino.transport({
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        })
      : undefined;

  return pino(
    {
      name: serviceName,
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

export const logger = createLogger();

/* -------------------------------------------------------------------------- */
/*                              ENVIRONMENT HELPERS                           */
/* -------------------------------------------------------------------------- */

type EnvVarOptions<T> = {
  defaultValue?: T;
  parser?: (raw: string) => T;
  optional?: boolean;
};

/**
 * Reads and validates environment variables in a type-safe way.
 *
 * Example:
 *   const port = getEnvVar<number>('PORT', { parser: Number, defaultValue: 3000 });
 *
 * Throws if variable is missing and `optional` is not set or if parsing fails.
 */
export function getEnvVar<T = string>(
  key: string,
  options: EnvVarOptions<T> = {},
): T {
  const raw = process.env[key];

  if (raw === undefined || raw === '') {
    if ('defaultValue' in options) {
      return options.defaultValue as T;
    }
    if (options.optional) {
      return undefined as unknown as T;
    }
    throw new Error(`Environment variable "${key}" is required but was not set.`);
  }

  try {
    return options.parser ? options.parser(raw) : (raw as unknown as T);
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'unknown error during parsing';
    throw new Error(
      `Failed to parse environment variable "${key}": ${msg}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                               RETRY / BACKOFF                              */
/* -------------------------------------------------------------------------- */

export interface RetryOptions {
  attempts?: number; // default: 3
  initialDelayMs?: number; // default: 250
  maxDelayMs?: number; // default: 10_000
  jitter?: boolean; // default: true
  logger?: Logger; // default: global logger
  abortSignal?: AbortSignal;
}

/**
 * Generic async retry helper with exponential back-off.
 *
 * Example:
 *   await retry(() => fetch(...), { attempts: 5 });
 */
export async function retry<T>(
  fn: () => Promise<T>,
  {
    attempts = 3,
    initialDelayMs = 250,
    maxDelayMs = 10_000,
    jitter = true,
    logger: retryLogger = logger,
    abortSignal,
  }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Retry aborted via AbortSignal.');
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;
      retryLogger.warn(
        { err, attempt, attempts },
        'Retryable operation failed – attempt %d/%d',
        attempt,
        attempts,
      );

      if (attempt === attempts) {
        break;
      }

      // Exponential backoff
      const sleepMs = jitter
        ? Math.min(maxDelayMs, delay * (0.5 + Math.random()))
        : Math.min(maxDelayMs, delay);

      await new Promise((res) => setTimeout(res, sleepMs));

      delay = Math.min(maxDelayMs, delay * 2);
    }
  }
  // Exhausted attempts
  throw lastError;
}

/* -------------------------------------------------------------------------- */
/*                                 TIMEOUT WRAP                               */
/* -------------------------------------------------------------------------- */

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out.') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps a Promise with a timeout.
 *
 * Example:
 *   await withTimeout(fetch(url), 5_000);
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  abortController?: AbortController,
): Promise<T> {
  if (ms <= 0) return promise;

  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController?.abort?.();
      reject(new TimeoutError(`Operation exceeded ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

/* -------------------------------------------------------------------------- */
/*                               DEFERRED PROMISE                             */
/* -------------------------------------------------------------------------- */

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/* -------------------------------------------------------------------------- */
/*                               DEEP CLONE / IMMUTABILITY                    */
/* -------------------------------------------------------------------------- */

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function deepFreeze<T>(object: T): Readonly<T> {
  function freeze(obj: any): any {
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj);
      for (const key of Object.getOwnPropertyNames(obj)) {
        freeze((obj as any)[key]);
      }
    }
    return obj;
  }
  return freeze(object);
}

/* -------------------------------------------------------------------------- */
/*                               CRYPTO / HASHING                             */
/* -------------------------------------------------------------------------- */

/**
 * Computes a SHA-256 hex digest from arbitrary data.
 * Useful when creating immutable addresses for model
 * artifacts, datasets, etc.
 */
export async function sha256(
  data: crypto.BinaryLike,
  encoding: crypto.HexBase64Latin1Encoding = 'hex',
): Promise<string> {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

/* -------------------------------------------------------------------------- */
/*                                FILE UTILITIES                              */
/* -------------------------------------------------------------------------- */

const jsonCache = new Map<string, unknown>();

/**
 * Loads a JSON file (sync). Automatically caches its content in memory to avoid
 * repeated disk IO in long-lived processes. To sidestep cache, pass `bustCache: true`.
 */
export function loadJsonSync<T = unknown>(
  filePath: string,
  bustCache = false,
): T {
  const absolute = path.resolve(filePath);
  if (!bustCache && jsonCache.has(absolute)) {
    return jsonCache.get(absolute) as T;
  }
  const raw = fs.readFileSync(absolute, 'utf-8');
  const parsed: T = JSON.parse(raw);

  jsonCache.set(absolute, parsed);
  return parsed;
}

/**
 * Writes an object as pretty-printed JSON to disk atomically
 * (using a temporary file + rename).
 */
export async function writeJsonAtomic<T>(
  filePath: string,
  data: T,
  spacing = 2,
): Promise<void> {
  const absolute = path.resolve(filePath);
  const dir = path.dirname(absolute);
  await fsAsync.mkdir(dir, { recursive: true });

  const tmpPath = absolute + '.tmp-' + crypto.randomUUID();
  await fsAsync.writeFile(tmpPath, JSON.stringify(data, null, spacing), 'utf-8');
  await fsAsync.rename(tmpPath, absolute);
}

/* -------------------------------------------------------------------------- */
/*                               CONCURRENCY LIMIT                            */
/* -------------------------------------------------------------------------- */

export class ConcurrencyLimiter {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new Error('ConcurrencyLimiter limit must be a positive integer.');
    }
  }

  /**
   * Executes an async function while respecting the concurrency limit.
   */
  public async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current >= this.limit) {
      await new Promise<void>((res) => this.queue.push(res));
    }

    this.current++;
    try {
      return await fn();
    } finally {
      this.current--;
      const next = this.queue.shift();
      next?.();
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                             EVENT EMITTER (TYPED)                          */
/* -------------------------------------------------------------------------- */

type ExtractListener<F> = F extends (...args: infer A) => any ? A : never;

export class TypedEventEmitter<Events extends Record<string, (...args: any) => void>> extends EventEmitter {
  on<K extends keyof Events>(event: K, listener: Events[K]): this {
    return super.on(event as string, listener as (...args: any[]) => void);
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): this {
    return super.once(event as string, listener as (...args: any[]) => void);
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): this {
    return super.off(event as string, listener as (...args: any[]) => void);
  }

  emit<K extends keyof Events>(
    event: K,
    ...args: ExtractListener<Events[K]>
  ): boolean {
    return super.emit(event as string, ...(args as any[]));
  }
}

/* -------------------------------------------------------------------------- */
/*                          AUXILIARY GUARDED UTILITIES                       */
/* -------------------------------------------------------------------------- */

/**
 * Exhaustiveness guard to satisfy the compiler.
 *
 * Example:
 *   switch(action.type) {
 *      case 'A': ...
 *      default:  assertUnreachable(action);
 *   }
 */
export function assertUnreachable(x: never): never {
  throw new Error(`Unexpected object: ${JSON.stringify(x)}`);
}

/**
 * Attempts to convert a string to an enum value.
 *
 *   enum Color { Red = 'red', Blue = 'blue' }
 *   const value = enumFromString(Color, 'red'); // Color.Red
 */
export function enumFromString<E>(
  enumObj: Record<string, string | number>,
  value: string | number,
): E | undefined {
  const values = new Set(Object.values(enumObj));
  return values.has(value) ? (value as E) : undefined;
}
```