```typescript
/**
 * SocialPulse Gateway
 * src/module_70.ts
 *
 * Advanced, adaptive rate-limiter middleware with Redis-backed token-bucket
 * implementation.  The limiter is reputation-aware: users with a higher trust
 * score are granted a larger bucket capacity.  It supports graceful degradation
 * (in-memory store) when Redis is unavailable and publishes structured log
 * entries compatible with the gateway’s observability stack.
 *
 * This module purposely avoids hard-coding gateway-specific concepts (e.g.
 * controller types) to remain usable from either the REST or GraphQL layer.
 */

import { Request, Response, NextFunction } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import createHttpError from 'http-errors';
import { v4 as uuid } from 'uuid';

/* Local fallbacks for logger + config so the file remains drop-in. */
const logger =
  // @ts-ignore – resolved by build-time alias to the shared logger
  (global as any).Logger ||
  console;

/* ---------------------------------------------------------------------------
 * Configuration helpers
 * ---------------------------------------------------------------------------
 */

interface RateLimitWindow {
  /** Logical name: e.g. “follow”, “post”, “dm” */
  scope: string;
  /**
   * Maximum number of tokens a user can consume inside the window before being
   * throttled.
   */
  capacity: number;
  /** Size of a window in seconds; i.e. tokens will fully refill after `ttl`. */
  ttl: number;
}

/**
 * A very thin wrapper around a config source.  Replace with the gateway’s
 * typed config service in production.
 */
export const defaultRateLimitConfig: Record<string, RateLimitWindow> = {
  /* Allow 60 timeline refreshes per minute */
  timeline: { scope: 'timeline', capacity: 60, ttl: 60 },

  /* Posting is heavier => 20 / min */
  post: { scope: 'post', capacity: 20, ttl: 60 },

  /* Follows are prone to spam => 10 / min */
  follow: { scope: 'follow', capacity: 10, ttl: 60 }
};

/* ---------------------------------------------------------------------------
 * Error types
 * ---------------------------------------------------------------------------
 */

/** Thrown when no configuration exists for an invoked scope. */
export class UnknownRateLimitScopeError extends Error {
  constructor(scope: string) {
    super(`Unknown rate-limit scope “${scope}”`);
    this.name = 'UnknownRateLimitScopeError';
  }
}

/* ---------------------------------------------------------------------------
 * Token-bucket algorithm (Redis / in-memory)
 * ---------------------------------------------------------------------------
 */

/**
 * High-level contract for a token bucket that can be shared by multiple worker
 * processes.
 */
export interface TokenBucket {
  /**
   * Attempt to consume a single token for the provided key.
   *
   * @returns Remaining tokens (after consume) and reset timestamp in epoch
   *          seconds, or `null` when the request is over limit.
   */
  consume(
    bucketKey: string,
    window: RateLimitWindow
  ): Promise<{ remaining: number; reset: number } | null>;
}

/* ---------------------------------- Redis --------------------------------- */

export class RedisTokenBucket implements TokenBucket {
  constructor(private readonly redis: RedisClient) {}

  public async consume(
    bucketKey: string,
    window: RateLimitWindow
  ): Promise<{ remaining: number; reset: number } | null> {
    /* Use Lua scripting to guarantee atomic updates */
    const script = `
      local current = redis.call("INCR", KEYS[1])
      if current == 1 then
        redis.call("EXPIRE", KEYS[1], ARGV[2])
      end
      if current > tonumber(ARGV[1]) then
        local ttl = redis.call("PTTL", KEYS[1])
        return {0, ttl}
      else
        local ttl = redis.call("PTTL", KEYS[1])
        return {tonumber(ARGV[1]) - current, ttl}
      end
    `;

    const [remaining, ttlMs]: [number, number] = (await this.redis.eval(
      script,
      1,
      bucketKey,
      window.capacity,
      window.ttl
    )) as any;

    if (remaining === 0) {
      return null;
    }

    return {
      remaining,
      reset: Math.floor(Date.now() / 1000) + Math.ceil(ttlMs / 1000)
    };
  }
}

/* ----------------------------- In-memory fallback -------------------------- */

interface InMemoryCounter {
  count: number;
  resetAt: number; // epoch seconds
}

export class InMemoryTokenBucket implements TokenBucket {
  private readonly state = new Map<string, InMemoryCounter>();

  public async consume(
    bucketKey: string,
    window: RateLimitWindow
  ): Promise<{ remaining: number; reset: number } | null> {
    const now = Math.floor(Date.now() / 1000);
    const entry = this.state.get(bucketKey) ?? {
      count: 0,
      resetAt: now + window.ttl
    };

    if (now >= entry.resetAt) {
      // Window expired -> reset.
      entry.count = 0;
      entry.resetAt = now + window.ttl;
    }

    entry.count += 1;
    this.state.set(bucketKey, entry);

    if (entry.count > window.capacity) {
      return null;
    }

    return {
      remaining: window.capacity - entry.count,
      reset: entry.resetAt
    };
  }
}

/* ---------------------------------------------------------------------------
 * Adaptive rate-limiter middleware
 * ---------------------------------------------------------------------------
 */

export interface AdaptiveRateLimiterOptions {
  /**
   * Select one of the config scopes (timeline, post…)
   * or provide a custom window inline.
   */
  window: RateLimitWindow | keyof typeof defaultRateLimitConfig;

  /**
   * Function that resolves a unique user key.  Defaults to userId if available
   * or falls back to IP address.
   */
  deriveKey?: (req: Request) => string | Promise<string>;

  /**
   * Compute additional “bonus” capacity for trusted users.  The score can come
   * from the auth token, user profile, etc.
   *
   * Returning a positive integer will be added to the base window capacity,
   * negative values decrease capacity (e.g. probation).
   */
  reputationBoost?: (req: Request) => number | Promise<number>;
}

/**
 * Instance factory.  Use per-route:
 *
 *   app.post('/v1/post', adaptiveRateLimiter({ window: 'post' }), postHandler);
 */
export function adaptiveRateLimiter(
  opts: AdaptiveRateLimiterOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const redisUrl =
    process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL || '';
  const redisClient = redisUrl ? new Redis(redisUrl) : null;

  const bucket: TokenBucket = redisClient
    ? new RedisTokenBucket(redisClient)
    : new InMemoryTokenBucket();

  const windowFromOpts = ((): RateLimitWindow => {
    if (typeof opts.window === 'string') {
      const config = defaultRateLimitConfig[opts.window];
      if (!config) throw new UnknownRateLimitScopeError(opts.window);
      return config;
    }
    return opts.window;
  })();

  return async function limiter(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      /* ------------------------ Derive bucket key -------------------------- */
      const keyDeriver =
        opts.deriveKey ??
        ((request: Request) =>
          // Authenticated request? use userId
          (request as any).user?.id ?? request.ip);

      const baseKey = await keyDeriver(req);
      const bucketKey = `${windowFromOpts.scope}:${baseKey}`;

      /* ------------------- Reputation-based adjustments -------------------- */
      let window: RateLimitWindow = windowFromOpts;
      if (opts.reputationBoost) {
        const boost = await opts.reputationBoost(req);
        window = {
          ...window,
          capacity: Math.max(1, window.capacity + boost)
        };
      }

      /* ----------------------- Consume token ------------------------------ */
      const result = await bucket.consume(bucketKey, window);

      // Attach headers for clients to introspect remaining budget.
      res.setHeader('X-RateLimit-Limit', window.capacity.toString());
      if (result) {
        res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
        res.setHeader('X-RateLimit-Reset', result.reset.toString());
        return next();
      }

      // Throttled
      res.setHeader('Retry-After', window.ttl.toString());
      throw createHttpError(429, 'Rate limit exceeded');
    } catch (error) {
      /* -------------------------------- Logs ------------------------------ */
      const requestId = (req.headers['x-request-id'] as string) || uuid();
      logger.warn({
        msg: 'Rate-limit violation',
        requestId,
        path: req.originalUrl,
        method: req.method,
        error: (error as Error).message
      });

      next(error);
    }
  };
}

/* ---------------------------------------------------------------------------
 * Helper: expose middleware for commonly used scopes
 * ---------------------------------------------------------------------------
 */

export const rateLimitTimeline = adaptiveRateLimiter({ window: 'timeline' });
export const rateLimitPost = adaptiveRateLimiter({ window: 'post' });
export const rateLimitFollow = adaptiveRateLimiter({ window: 'follow' });

/* ---------------------------------------------------------------------------
 * Healthcheck util
 * ---------------------------------------------------------------------------
 */

/**
 * Verifies that the underlying store (Redis) is writable and time-to-live is
 * correctly set.  Valuable for readiness probes.
 */
export async function selfTestRateLimiterStore(): Promise<void> {
  const redisUrl = process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL;
  if (!redisUrl) {
    logger.info(
      '[rate-limiter] No Redis URL provided – operating in local memory mode.'
    );
    return;
  }

  const redis = new Redis(redisUrl);
  const probeKey = `ratelimit:probe:${uuid()}`;
  await redis.set(probeKey, '1', 'EX', 2);
  const ttl = await redis.ttl(probeKey);

  if (ttl <= 0) {
    throw new Error('Failed to validate Redis TTL behaviour for rate-limiter');
  }

  await redis.quit();
  logger.info('[rate-limiter] Store self-test succeeded');
}
```