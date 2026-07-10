```typescript
/**
 * SocialPulse Gateway – Rate-Limiter Module
 * ----------------------------------------
 * File: src/module_43.ts
 *
 * Production-grade, Redis-backed rate-limiter with intelligent fall-back to
 * in-memory storage.  Designed to be consumed as an Express / Connect
 * middleware but can also be used programmatically.
 *
 * Key Characteristics
 *  • Token-bucket algorithm (fixed window with sliding reset)
 *  • Per-identity buckets (userId, sessionId or IP fallback)
 *  • Route-aware throttling (override global limits via `req.route.meta`)
 *  • Resilient: degrades gracefully if Redis is unavailable
 *  • Structured logging compatible with SocialPulse observability pipeline
 *
 * NOTE: Externalised configuration & DI (e.g. with Inversify / NestJS) is
 * strongly encouraged in production but omitted here for brevity.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis, { Redis as IRedis } from 'ioredis';

// ---------------------------------------------------------------------------
// Configuration & Contracts
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing which backing store is active.
 */
type BackingStore = 'redis' | 'memory';

interface RateLimiterOptions {
  /**
   * Maximum number of requests allowed per `windowMs`.  May be overridden
   * on a per-route basis by setting `req.route?.meta?.rateLimit`.
   */
  max: number;

  /**
   * Duration of the fixed window in milliseconds.
   */
  windowMs: number;

  /**
   * Redis connection options.  If undefined, an in-memory store is used.
   */
  redis?: Redis.RedisOptions;

  /**
   * Header name containing the authenticated user identifier.  Falls back
   * to IP address when absent.
   */
  userIdHeader?: string;

  /**
   * If true, X-RateLimit-* headers are returned to help clients understand
   * throttling status.
   */
  exposeHeaders?: boolean;

  /**
   * Logger implementation.  Minimum contract: `info`, `warn`, `error`.
   */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * The shape returned from an increment operation.
 */
interface IncrementResult {
  remaining: number;
  totalHits: number;
  resetMs: number;
}

// ---------------------------------------------------------------------------
// Logger (fallback implementation)
// ---------------------------------------------------------------------------

const defaultLogger: RateLimiterOptions['logger'] = {
  info: console.log.bind(console, '[info]'),
  warn: console.warn.bind(console, '[warn]'),
  error: console.error.bind(console, '[error]'),
};

// ---------------------------------------------------------------------------
// In-Memory Store (ephemeral fallback)
// ---------------------------------------------------------------------------

class MemoryStore {
  private buckets = new Map<string, { hits: number; reset: number }>();
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  increment(key: string, max: number): IncrementResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (bucket && bucket.reset > now) {
      bucket.hits++;
    } else {
      // New window
      this.buckets.set(key, { hits: 1, reset: now + this.windowMs });
    }

    const { hits, reset } = this.buckets.get(key)!;
    return {
      remaining: Math.max(max - hits, 0),
      totalHits: hits,
      resetMs: reset,
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.reset <= now) this.buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis Store
// ---------------------------------------------------------------------------

/**
 * Lua script for atomic increment / expiry.
 * Returns: {hits, ttl} packed as two integers.
 */
const LUA_SCRIPT = `
  local current
  current = redis.call("INCR", KEYS[1])
  if tonumber(current) == 1 then
    redis.call("PEXPIRE", KEYS[1], ARGV[1])
  end
  local ttl = redis.call("PTTL", KEYS[1])
  return {current, ttl}
`;

class RedisStore {
  private readonly redis: IRedis;
  private readonly windowMs: number;

  constructor(redis: IRedis, windowMs: number) {
    this.redis = redis;
    this.windowMs = windowMs;
  }

  async increment(key: string, max: number): Promise<IncrementResult> {
    const [hitsRaw, ttlRaw] = (await this.redis.eval(
      LUA_SCRIPT,
      1,
      key,
      this.windowMs
    )) as [number, number];

    const hits = typeof hitsRaw === 'number' ? hitsRaw : parseInt(hitsRaw, 10);
    const ttl = typeof ttlRaw === 'number' ? ttlRaw : parseInt(ttlRaw, 10);

    return {
      remaining: Math.max(max - hits, 0),
      totalHits: hits,
      resetMs: Date.now() + ttl,
    };
  }
}

// ---------------------------------------------------------------------------
// Middleware Factory
// ---------------------------------------------------------------------------

export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const {
    max,
    windowMs,
    redis: redisOptions,
    userIdHeader = 'x-sp-user-id',
    exposeHeaders = true,
    logger = defaultLogger,
  } = options;

  let store: MemoryStore | RedisStore;
  let backingStore: BackingStore;

  if (redisOptions) {
    const redis = new Redis(redisOptions);

    // Swap into in-memory mode on connection error
    redis.on('error', (err) => {
      logger.error('Redis connection lost. Falling back to memory store.', err);
      store = new MemoryStore(windowMs);
      backingStore = 'memory';
    });

    store = new RedisStore(redis, windowMs);
    backingStore = 'redis';

    logger.info('RateLimiter: Using Redis store');
  } else {
    store = new MemoryStore(windowMs);
    backingStore = 'memory';
    logger.info('RateLimiter: Using in-memory store');
  }

  /**
   * Express middleware implementing the token-bucket logic.
   */
  return async function rateLimiter(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    try {
      // Compute effective limit for this route if overridden
      const routeLimit: number | undefined =
        (req as any).route?.meta?.rateLimit;

      const limit = routeLimit ?? max;

      // Non-limited route (explicitly set to 0 or negative number)
      if (limit <= 0) return next();

      // Resolve client identity
      const userId = (req.headers[userIdHeader] as string) || '';
      const clientIp =
        req.ip ||
        (req.connection && (req.connection.remoteAddress as string)) ||
        'unknown';

      const identity = userId.trim() || clientIp;

      // Bucket key includes versioned route to prevent cross-route bleeding
      const routeId =
        (req as any).matchedVersion /* custom attribute set by router */ ||
        req.baseUrl ||
        req.path;

      const bucketKey = `rate:${routeId}:${identity}`;

      const incrementResult =
        backingStore === 'redis'
          ? await (store as RedisStore).increment(bucketKey, limit)
          : (store as MemoryStore).increment(bucketKey, limit);

      const { remaining, totalHits, resetMs } = incrementResult;

      // Expose RFC-compatible rate-limit headers
      if (exposeHeaders) {
        res.setHeader('X-RateLimit-Limit', limit.toString());
        res.setHeader('X-RateLimit-Remaining', remaining.toString());
        res.setHeader(
          'X-RateLimit-Reset',
          Math.ceil(resetMs / 1000).toString()
        );
      }

      // Over the limit?
      if (totalHits > limit) {
        const retrySec = Math.ceil((resetMs - Date.now()) / 1000);
        res.setHeader('Retry-After', retrySec.toString());
        logger.warn(
          `RateLimiter: Throttling identity=${identity} on route=${routeId} hits=${totalHits}/${limit}`
        );
        return res.status(429).json({
          status: 'error',
          message: 'Too many requests, please try again later.',
        });
      }

      return next();
    } catch (err) {
      // Never block requests on limiter failure, only warn
      logger.error('RateLimiter encountered an error', err);
      return next();
    }
  };
}

// ---------------------------------------------------------------------------
// Programmatic Usage Example (non-middleware)
// ---------------------------------------------------------------------------

/* 
import { createRateLimiter } from './module_43';
import express from 'express';

const app = express();
app.use(
  createRateLimiter({
    max: 120,
    windowMs: 60_000,
    redis: { host: 'redis.internal', port: 6379 }, // comment out to use memory
  })
);

app.get('/v1/timeline', (_, res) => res.send('🎉'));
app.listen(8080);
*/

// ---------------------------------------------------------------------------
// Utility Types (public)
// ---------------------------------------------------------------------------

export type { RateLimiterOptions, IncrementResult };
```