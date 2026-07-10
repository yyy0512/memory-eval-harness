```typescript
/******************************************************************************
 * File: module_36.ts
 * Project: SocialPulse Gateway (api_gateway)
 * Description:
 *   Production-grade, sliding-window rate-limiter with Redis-backing.
 *   – Atomic counter updates via Lua script
 *   – Supports per-route overrides and dynamic re-configuration
 *   – Works as standalone service or Express / GraphQL middleware
 *   – Plugs into gateway-wide logger, metrics collector, and feature-flag
 *
 *   Layer: infrastructure ➜ adapter (exposed via DI container)
 ******************************************************************************/

import { createHash } from 'crypto';
import Redis, { Redis as RedisClient } from 'ioredis';
import pino from 'pino';
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

/* -------------------------------------------------------------------------- */
/*                                Type Helpers                                */
/* -------------------------------------------------------------------------- */

export interface RateLimitContext {
  /** Canonical identifier for the caller (e.g. userId, IP) */
  actorId: string;
  /** Unique qualifier for the resource (e.g. ENDPOINT_KEY:v2)            */
  bucket: string;
  /** Weight of current attempt (e.g. fan-out size)                       */
  cost?: number;
}

/** Result returned for every rate-limit evaluation */
export type RateLimitDecision =
  | {
      allowed: true;
      remaining: number;
      resetIn: number;
    }
  | {
      allowed: false;
      remaining: 0;
      retryIn: number;
    };

/* -------------------------------------------------------------------------- */
/*                            Configuration Schema                            */
/* -------------------------------------------------------------------------- */

export const RateLimiterConfigSchema = z.object({
  limit: z.number().int().positive(), // max tokens
  windowMs: z.number().int().positive(), // sliding window length
  prefix: z.string().default('rl:'), // redis key prefix
});

export type RateLimiterConfig = z.infer<typeof RateLimiterConfigSchema>;

/* -------------------------------------------------------------------------- */
/*                              Redis Lua Script                              */
/* -------------------------------------------------------------------------- */

/**
 * Sliding window algorithm
 *
 *  KEYS[1] -> redis key
 *  ARGV[1] -> window (ms)
 *  ARGV[2] -> limit
 *  ARGV[3] -> now (ms)
 *  ARGV[4] -> cost (token weight)
 *
 *  1. Remove outdated scores
 *  2. Increment with cost
 *  3. Return {current, remaining, ttl}
 */
const SLIDING_WINDOW_LUA = `
local key     = KEYS[1]
local window  = tonumber(ARGV[1])
local limit   = tonumber(ARGV[2])
local now     = tonumber(ARGV[3])
local cost    = tonumber(ARGV[4])

-- purge old
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- add new
redis.call('ZADD', key, now, now)

-- increment cost (use separate hash for heavy weight items)
local current = redis.call('ZCARD', key) + cost - 1

-- set TTL for cleanup (window *2 to tolerate clock skew)
redis.call('PEXPIRE', key, window * 2)

local remaining = limit - current
return { current, remaining > 0 and remaining or 0 }
`;

/* -------------------------------------------------------------------------- */
/*                                RateLimiter                                 */
/* -------------------------------------------------------------------------- */

export class RateLimiter {
  private readonly redis: RedisClient;
  private readonly logger: pino.Logger;
  private readonly cfg: RateLimiterConfig;

  constructor(
    redis: RedisClient,
    logger: pino.Logger = pino(),
    config: Partial<RateLimiterConfig> = {},
  ) {
    this.redis = redis;
    this.logger = logger.child({ module: 'RateLimiter' });
    this.cfg = RateLimiterConfigSchema.parse(config);
  }

  /**
   * Produces the redis key for a rate-limit bucket
   */
  private buildKey(ctx: RateLimitContext): string {
    // Sanitize & hash actorId to avoid unbounded key length
    const hashedActor = createHash('sha1').update(ctx.actorId).digest('hex');
    return `${this.cfg.prefix}${ctx.bucket}:${hashedActor}`;
  }

  /**
   * Evaluate and update rate-limit counters atomically
   */
  async check(ctx: RateLimitContext): Promise<RateLimitDecision> {
    const cost = Math.max(1, ctx.cost ?? 1);
    const now = Date.now();
    const key = this.buildKey(ctx);

    try {
      const [currentStr, remainingStr] = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        key,
        this.cfg.windowMs,
        this.cfg.limit,
        now,
        cost,
      )) as [string, string];

      const current = Number(currentStr);
      const remaining = Number(remainingStr);
      const resetIn = this.cfg.windowMs - (now % this.cfg.windowMs);

      if (current > this.cfg.limit) {
        this.logger.debug(
          { actorId: ctx.actorId, bucket: ctx.bucket },
          'Rate limit exceeded',
        );
        return { allowed: false, remaining: 0, retryIn: resetIn };
      }

      return { allowed: true, remaining, resetIn };
    } catch (err) {
      // Fail-open strategy to avoid breaking production traffic
      this.logger.error(
        { err, actorId: ctx.actorId, bucket: ctx.bucket },
        'RateLimiter redis failure – allowing request',
      );
      return { allowed: true, remaining: this.cfg.limit, resetIn: 0 };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                         Express/GQL Helper Middleware                      */
/* -------------------------------------------------------------------------- */

export interface MiddlewareOptions {
  bucket: string | ((req: Request) => string);
  /**
   * Extract a canonical actor identifier.
   * Accepts:
   *   – logged-in user id
   *   – api key
   *   – client ip (as fallback)
   */
  actorId: (req: Request) => string | undefined;
  /**
   * Optional custom cost strategy (e.g. fan-out weight)
   */
  cost?: (req: Request) => number | undefined;
}

export const rateLimitMiddleware =
  (limiter: RateLimiter, options: MiddlewareOptions) =>
  async (req: Request, res: Response, next: NextFunction) => {
    // Resolve bucket
    const bucket =
      typeof options.bucket === 'function'
        ? options.bucket(req)
        : options.bucket;

    // Resolve actorId
    const actor = options.actorId(req) ?? req.ip;
    if (!actor) {
      // Unable to determine actor -> block for safety
      res.status(400).json({
        error: 'RATE_LIMIT_ERROR',
        message: 'Unable to resolve actor identity',
      });
      return;
    }

    // Evaluate
    const decision = await limiter.check({
      actorId: actor,
      bucket,
      cost: options.cost?.(req),
    });

    // Set rate-limit headers (convention similar to GitHub API)
    res.setHeader('X-RateLimit-Limit', String(limiter['cfg'].limit));
    res.setHeader(
      'X-RateLimit-Remaining',
      String(decision.allowed ? decision.remaining : 0),
    );
    res.setHeader(
      'X-RateLimit-Reset',
      String(
        (Date.now() +
          ('resetIn' in decision ? decision.resetIn : decision.retryIn)) / 1000,
      ),
    );

    if (decision.allowed) return next();

    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      retry_after_ms: decision.retryIn,
      message:
        'Too many requests. Please slow down or try again after the specified time.',
    });
  };

/* -------------------------------------------------------------------------- */
/*                         Example Registration (Express)                     */
/* -------------------------------------------------------------------------- */

/*
import express from 'express';
import { getRedis } from './redis.factory';

const app = express();
const limiter = new RateLimiter(getRedis());

app.use(
  '/v1/timeline',
  rateLimitMiddleware(limiter, {
    bucket: 'GET_TIMELINE_V1',
    actorId: (req) => req.headers['x-user-id'] as string | undefined,
  }),
);

export default app;
*/

/******************************************************************************
 * End of module_36.ts
 *****************************************************************************/
```