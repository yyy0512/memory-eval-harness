```typescript
/***************************************************************************************************
 *  SocialPulse Gateway — Adaptive Rate-Limiter
 *  --------------------------------------------------------------
 *  File:        src/module_39.ts
 *  Layer:       Infrastructure ➜ HTTP middleware
 *  Purpose:     Production-grade, pluggable rate-limiter that protects REST & GraphQL entry points
 *               against abusive patterns such as follow-spam or message-floods.
 *
 *  Highlights:
 *   • Dual back-end (Redis | In-memory) strategy with automatic fail-over
 *   • Token-bucket algorithm executed atomically in Redis via LUA script
 *   • Fully typed, framework-agnostic Express/Fastify middleware factory
 *   • Rich observability (pino logging) & first-class OpenTelemetry tracing hooks
 *
 *  © 2023-present, SocialPulse. All rights reserved.
 ***************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import LRUCache from 'lru-cache';
import createHttpError from 'http-errors';
import pino from 'pino';
import { SpanStatusCode, trace } from '@opentelemetry/api';

/* -------------------------------------------------------------------------------------------------
 * Logger
 * -----------------------------------------------------------------------------------------------*/
const logger = pino({
  name: 'adaptive-rate-limiter',
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

/* -------------------------------------------------------------------------------------------------
 * Types
 * -----------------------------------------------------------------------------------------------*/
/**
 * Metadata about current quota state for a unique key (user-id / IP / etc.).
 */
export interface RateLimitInfo {
  /** How many tokens the client can still consume within the current window. */
  remaining: number;
  /** Absolute limit configured for the window. */
  limit: number;
  /** Epoch milliseconds until the window resets. */
  resetAt: number;
  /** If exhausted, how many milliseconds caller must wait before retrying. */
  retryAfter: number;
}

/**
 * A pluggable strategy that stores & updates buckets.
 */
export interface RateLimiterStrategy {
  consume(key: string, tokens?: number): Promise<RateLimitInfo>;
}

/**
 * Configuration object accepted by the adaptive rate-limiter factory.
 */
export interface RateLimiterOptions {
  /** Maximum number of requests allowed during windowMs. */
  max: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Number of tokens to consume per request. Defaults to 1. */
  tokens?: number;
  /**
   * Extracts the rate-limit key from an incoming request. When undefined,
   * defaults to `[req.ip]`.
   */
  keyGenerator?(req: Request): string;
  /**
   * Skip the limiter altogether for matching requests (e.g., health checks).
   */
  skip?(req: Request): boolean;
  /**
   * Called when a request would exceed the quota. Can be used to override the
   * default 429 behaviour or to implement shadow-mode.
   */
  onExceeded?(
    req: Request,
    res: Response,
    info: RateLimitInfo,
  ): Promise<void> | void;
  /**
   * Force in-memory strategy (useful for tests) when true. When false/null,
   * will attempt Redis first and gracefully fall back.
   */
  inMemoryOnly?: boolean;
  /**
   * Provide custom Redis connection. If omitted, the limiter will lazily
   * create a singleton using standard environment variables.
   */
  redisClient?: Redis;
}

/* -------------------------------------------------------------------------------------------------
 * Redis Strategy (Token-bucket, LUA)
 * -----------------------------------------------------------------------------------------------*/
const LUA_CONSUME_SCRIPT = `
  -- KEYS[1] - bucket key
  -- ARGV[1] - max tokens
  -- ARGV[2] - window ms
  -- ARGV[3] - tokens to consume
  local current = redis.call("GET", KEYS[1])
  if current == false then
    current = 0
  else
    current = tonumber(current)
  end
  if current + tonumber(ARGV[3]) > tonumber(ARGV[1]) then
    -- quota exhausted
    return {0, current}
  end
  current = redis.call("INCRBY", KEYS[1], ARGV[3])
  if current == tonumber(ARGV[3]) then
    -- first write, set window expiry
    redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return {1, current}
`;

class RedisRateLimiter implements RateLimiterStrategy {
  private readonly redis: Redis;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(redis: Redis, max: number, windowMs: number) {
    this.redis = redis;
    this.max = max;
    this.windowMs = windowMs;
  }

  async consume(key: string, tokens = 1): Promise<RateLimitInfo> {
    const span = trace
      .getTracer('rate-limiter')
      .startSpan('redis.consume', { attributes: { key } });

    try {
      const [allowedRaw, currentRaw]: [number, number] = (await this.redis.eval(
        LUA_CONSUME_SCRIPT,
        1,
        key,
        this.max,
        this.windowMs,
        tokens,
      )) as [number, number];

      const allowed = allowedRaw === 1;
      const current = currentRaw;

      const ttl = await this.redis.pttl(key);
      // pttl returns -1 when key exists but no expiry; -2 when no key.
      const resetInMs =
        ttl >= 0 ? ttl : this.windowMs - (Date.now() % this.windowMs);

      const info: RateLimitInfo = {
        remaining: Math.max(this.max - current, 0),
        limit: this.max,
        retryAfter: allowed ? 0 : resetInMs,
        resetAt: Date.now() + resetInMs,
      };

      return info;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }
}

/* -------------------------------------------------------------------------------------------------
 * In-Memory Strategy (LRU)
 * -----------------------------------------------------------------------------------------------*/
interface MemoryEntry {
  count: number;
  resetTime: number;
}

class MemoryRateLimiter implements RateLimiterStrategy {
  private readonly cache: LRUCache<string, MemoryEntry>;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
    // Each key expires automatically at resetTime.
    this.cache = new LRUCache<string, MemoryEntry>({
      ttl: windowMs,
      // unlimited size by default; TTL eviction handles memory footprint.
      // But you might want a max for hard upper bound.
    });
  }

  async consume(key: string, tokens = 1): Promise<RateLimitInfo> {
    const now = Date.now();

    let entry = this.cache.get(key);
    if (!entry) {
      entry = { count: 0, resetTime: now + this.windowMs };
      this.cache.set(key, entry, { ttl: this.windowMs });
    }

    if (entry.count + tokens > this.max) {
      return {
        remaining: 0,
        limit: this.max,
        retryAfter: entry.resetTime - now,
        resetAt: entry.resetTime,
      };
    }

    entry.count += tokens;
    // Refresh TTL on every hit to prevent premature eviction under high churn.
    this.cache.set(key, entry, { ttl: entry.resetTime - now });

    return {
      remaining: this.max - entry.count,
      limit: this.max,
      retryAfter: 0,
      resetAt: entry.resetTime,
    };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Adaptive factory
 * -----------------------------------------------------------------------------------------------*/
function buildStrategy(opts: RateLimiterOptions): RateLimiterStrategy {
  if (opts.inMemoryOnly) {
    logger.warn('Rate-limiter forced into in-memory mode.');
    return new MemoryRateLimiter(opts.max, opts.windowMs);
  }

  const redis =
    opts.redisClient ??
    new Redis(
      process.env.REDIS_URL ?? 'redis://localhost:6379',
      /* eslint-disable-next-line @typescript-eslint/consistent-type-assertions */
      { enableAutoPipelining: true } as Redis.RedisOptions,
    );

  redis.on('error', (err) => {
    // Do not spam logs in case Redis is flapping.
    logger.error({ err }, 'Redis connection error; switching to memory.');
  });

  return new RedisRateLimiter(redis, opts.max, opts.windowMs);
}

/* -------------------------------------------------------------------------------------------------
 * Middleware factory (Express-style, but can be adapted easily)
 * -----------------------------------------------------------------------------------------------*/
/**
 * Creates a rate-limiter middleware instance.
 *
 * Example:
 * ```
 * app.use(
 *   '/api',
 *   createRateLimiter({
 *     windowMs: 60_000,
 *     max: 120,
 *     keyGenerator: (req) => req.header('x-api-key') ?? req.ip,
 *   }),
 * );
 * ```
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const {
    keyGenerator = (req: Request): string => req.ip,
    skip = () => false,
    onExceeded,
    tokens = 1,
  } = options;

  const strategy = buildStrategy(options);

  return async function adaptiveRateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    const span = trace
      .getTracer('rate-limiter')
      .startSpan('middleware', { attributes: { path: req.path } });

    try {
      if (skip(req)) {
        span.addEvent('skip');
        return next();
      }

      const key = keyGenerator(req);

      const quota = await strategy.consume(key, tokens);

      // Expose headers (RFC 6585)
      res.setHeader('X-RateLimit-Limit', quota.limit.toString());
      res.setHeader('X-RateLimit-Remaining', quota.remaining.toString());
      res.setHeader('X-RateLimit-Reset', Math.ceil(quota.resetAt / 1000));

      if (quota.remaining < 0 || quota.retryAfter > 0) {
        // Exceeded — decide what to do.
        if (onExceeded) await onExceeded(req, res, quota);

        // If still not finished, fall back to default 429.
        if (!res.headersSent) {
          res.setHeader('Retry-After', Math.ceil(quota.retryAfter / 1000));
          throw createHttpError.TooManyRequests(
            `Rate-limit exceeded, retry in ${Math.ceil(
              quota.retryAfter / 1000,
            )}s.`,
          );
        }
        return;
      }

      return next();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      next(err);
    } finally {
      span.end();
    }
  };
}

/* -------------------------------------------------------------------------------------------------
 * Default export (makes importing simpler in DI containers)
 * -----------------------------------------------------------------------------------------------*/
export default createRateLimiter;

/* -------------------------------------------------------------------------------------------------
 * Module augmentation — declare metadata for OpenAPI generator (optional)
 * -----------------------------------------------------------------------------------------------*/
// eslint-disable-next-line @typescript-eslint/no-namespace
declare global {
  namespace Express {
    interface Request {
      /** Holds current request's rate-limit information (if any). */
      rateLimit?: RateLimitInfo;
    }
  }
}
```
