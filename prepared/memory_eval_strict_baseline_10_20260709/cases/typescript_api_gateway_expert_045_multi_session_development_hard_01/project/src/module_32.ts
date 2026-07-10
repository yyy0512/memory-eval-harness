```typescript
/**
 * SocialPulse Gateway – Rate-Limiting module
 *
 * File: src/module_32.ts
 * Purpose: Implements a production-grade, Redis-backed sliding-window rate-limiter
 * that can be reused across REST (Express) and GraphQL (Apollo) entry points.
 *
 * The implementation relies on a Lua script to guarantee atomicity when counting
 * requests in a sliding window, preventing race conditions in highly concurrent
 * environments.  The module is designed following SOLID principles and offers
 * observability hooks (events + structured logger) to ease monitoring.
 */

import Redis from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
import type { GraphQLRequestContext } from 'apollo-server-types';
import EventEmitter from 'events';
import pino from 'pino';

/* ---------- Types & Interfaces ------------------------------------------------ */

export interface RateLimiterOptions {
  /**
   * Length of the window in seconds
   */
  windowSize: number;
  /**
   * Maximum amount of requests allowed inside the window
   */
  maxRequests: number;
  /**
   * Function that extracts a unique identifier per requester.
   * Example: `req => req.headers['x-api-key'] ?? req.ip`
   */
  keyGenerator: (req: Request | GraphQLRequestContext) => string;
  /**
   * Name‐space prefix in Redis
   */
  redisKeyPrefix?: string;
  /**
   * If true, requests will not be blocked when Redis is unavailable.
   */
  failOpen?: boolean;
}

/**
 * Structured event payloads emitted by the rate-limiter
 */
export interface RateLimiterEventPayload {
  identifier: string;
  remaining: number;
  windowSize: number;
  maxRequests: number;
  timestamp: number;
}

export interface RateLimiter {
  /**
   * Express middleware
   */
  express(): (req: Request, res: Response, next: NextFunction) => void;
  /**
   * Apollo ‘plugin’ hook – fires on each GraphQL request
   */
  apollo(): {
    async requestDidStart(
      context: GraphQLRequestContext
    ): Promise<void>;
  };
  /**
   * Underlying EventEmitter for observability
   */
  events: EventEmitter;
}

/* ---------- Errors ----------------------------------------------------------- */

/**
 * Thrown when a client exceeds the configured rate-limit.
 */
export class RateLimitExceededError extends Error {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfter = retryAfter;
  }
}

/* ---------- Redis Lua Script -------------------------------------------------- */
/**
 * Atomic sliding window counter.
 *
 * KEYS[1] -> Redis sorted-set key for the requester
 * ARGV[1] -> current unix timestamp (ms)
 * ARGV[2] -> windowSize (ms)
 * ARGV[3] -> maxRequests
 *
 * 1. Removes scores older than (now - windowSize)
 * 2. Adds current timestamp as new score/member
 * 3. Returns the current cardinality of the sorted set
 */
const SLIDING_WINDOW_LUA = `
  local key         = KEYS[1]
  local now         = tonumber(ARGV[1])
  local window      = tonumber(ARGV[2])
  local maxRequests = tonumber(ARGV[3])

  -- purge old
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  -- add current
  redis.call('ZADD', key, now, now)
  -- get count
  local count = redis.call('ZCARD', key)
  -- set expire to window to avoid ghost keys
  redis.call('PEXPIRE', key, window)

  return count
`;

/* ---------- Implementation --------------------------------------------------- */

export class RedisSlidingWindowRateLimiter implements RateLimiter {
  private readonly redis: Redis.Redis;
  private readonly opts: Required<RateLimiterOptions>;
  public readonly events: EventEmitter;
  private readonly logger = pino({ name: 'rate-limiter' });

  constructor(redis: Redis.Redis, options: RateLimiterOptions) {
    if (!redis) {
      throw new Error('Redis instance must be provided.');
    }

    this.redis = redis;
    this.events = new EventEmitter();

    // Default options
    this.opts = {
      windowSize     : options.windowSize,
      maxRequests    : options.maxRequests,
      keyGenerator   : options.keyGenerator,
      redisKeyPrefix : options.redisKeyPrefix ?? 'rate',
      failOpen       : options.failOpen ?? true
    };

    if (this.opts.windowSize <= 0 || this.opts.maxRequests <= 0) {
      throw new Error('[RateLimiter] windowSize and maxRequests must be > 0');
    }
  }

  /* -------------------- Public API -------------------------- */

  public express() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await this.assertRate(req);
        next();
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          res.setHeader('Retry-After', err.retryAfter.toString());
          res.status(429).json({ error: err.message });
          return;
        }
        // Unexpected error, pass through regular error pipeline
        next(err);
      }
    };
  }

  public apollo() {
    return {
      // Note: we only implement requestDidStart; other phases remain untouched.
      requestDidStart: async (ctx: GraphQLRequestContext) => {
        await this.assertRate(ctx);
      }
    };
  }

  /* ---------------- String key builder ---------------------- */

  private buildRedisKey(identifier: string): string {
    // Example: rate:v1:identifier
    return `${this.opts.redisKeyPrefix}:${this.opts.windowSize}:${identifier}`;
  }

  /* ---------------- Rate limiting logic --------------------- */

  private async assertRate(context: Request | GraphQLRequestContext): Promise<void> {
    const identifier = this.opts.keyGenerator(context);

    if (!identifier) {
      // Fail fast to preserve cluster capacity; treat anonymous as one bucket
      this.logger.warn('Key generator returned falsy identifier; defaulting to "anonymous".');
      return this.checkRedis('anonymous');
    }

    return this.checkRedis(identifier);
  }

  private async checkRedis(identifier: string): Promise<void> {
    const now = Date.now();
    const key = this.buildRedisKey(identifier);

    try {
      const requestCount = await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        now,
        this.opts.windowSize * 1000,
        this.opts.maxRequests
      ) as number;

      const remaining = Math.max(this.opts.maxRequests - requestCount, 0);

      this.events.emit('rate_check', <RateLimiterEventPayload>{
        identifier,
        remaining,
        windowSize : this.opts.windowSize,
        maxRequests: this.opts.maxRequests,
        timestamp  : now
      });

      if (requestCount > this.opts.maxRequests) {
        const retryAfter = this.opts.windowSize; // simple approach
        throw new RateLimitExceededError(
          `Rate limit exceeded: max ${this.opts.maxRequests} requests in ${this.opts.windowSize}s.`,
          retryAfter
        );
      }
    } catch (err) {
      // Redis down? Decide based on failOpen strategy.
      if (err instanceof RateLimitExceededError) throw err;
      this.logger.error(
        { err, identifier },
        'Redis error while performing rate-limit check.'
      );
      if (!this.opts.failOpen) throw err; // fail-closed
    }
  }
}

/* ---------- Factory helper --------------------------------------------------- */

/**
 * Convenience factory to simplify wiring in IOC containers.
 */
export function createRateLimiter(
  redis: Redis.Redis,
  options: RateLimiterOptions
): RateLimiter {
  return new RedisSlidingWindowRateLimiter(redis, options);
}

/* ---------- Example usage (commented) ----------------------------------------

import express from 'express';
import Redis from 'ioredis';

const app = express();
const redis = new Redis(process.env.REDIS_URL);

const rateLimiter = createRateLimiter(redis, {
  windowSize  : 60,         // 60s window
  maxRequests : 120,        // 120 reqs
  keyGenerator: (ctx) => {
    if ('ip' in ctx) { // Express request
      return ctx.ip;
    }
    // Apollo context
    return ctx.request.http?.headers.get('x-forwarded-for') ?? 'anonymous';
  }
});

app.use(rateLimiter.express());

-------------------------------------------------------------------------- */
```