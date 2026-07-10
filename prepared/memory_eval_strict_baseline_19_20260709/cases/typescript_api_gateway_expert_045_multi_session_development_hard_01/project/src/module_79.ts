```typescript
/**
 * src/module_79.ts
 *
 * Distributed, Redis–backed rate-limiter with
 * decorator-driven configuration for both REST controllers
 * and GraphQL resolvers.
 *
 * The module lives in the “infrastructure” layer of
 * SocialPulse Gateway and showcases how cross-cutting
 * concerns (abuse-mitigation) can be expressed declaratively
 * while remaining framework-agnostic.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import crypto from 'crypto';
import 'reflect-metadata';

/* -------------------------------------------------------------------------- */
/*                               Public typings                               */
/* -------------------------------------------------------------------------- */

export interface RateLimitOptions {
  /**
   * Maximum number of allowed requests per window.
   * Can be overridden dynamically at runtime via the
   * `RateLimitPolicyProvider` interface (multi-tenant use-cases).
   */
  points: number;

  /**
   * Duration of the window in seconds.
   */
  duration: number;

  /**
   * Optional key prefix to differentiate between logical buckets
   * (e.g., “/v1/timeline” vs “/v2/timeline”)
   */
  keyPrefix?: string;
}

export interface RateLimitState {
  allowed: boolean;
  remaining: number;
  reset: number; // epoch seconds
}

/**
 * Optional hook that can supply tenant- or user-specific
 * rate-limit values on the fly.
 */
export interface RateLimitPolicyProvider {
  resolve(
    req: Request,
    declared: RateLimitOptions
  ): Promise<RateLimitOptions> | RateLimitOptions;
}

/* -------------------------------------------------------------------------- */
/*                         Decorator implementation                           */
/* -------------------------------------------------------------------------- */

const RL_METADATA_KEY = Symbol('socialpulse:rate_limit');

/**
 * Declarative rate-limit decorator. Can be attached to:
 *
 *  - Express route handlers
 *  - GraphQL resolver methods
 *
 * The actual enforcement is done by the `rateLimitMiddleware`
 * which inspects metadata via `Reflect.getMetadata`.
 */
export function RateLimit(opts: RateLimitOptions): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    Reflect.defineMetadata(RL_METADATA_KEY, opts, descriptor.value!);
  };
}

/**
 * Helper to fetch decorator options (if any) for an arbitrary handler.
 */
export function getRateLimitMetadata(
  handler: unknown
): RateLimitOptions | undefined {
  return Reflect.getMetadata(RL_METADATA_KEY, handler);
}

/* -------------------------------------------------------------------------- */
/*                     Redis-backed enforcement engine                        */
/* -------------------------------------------------------------------------- */

/**
 * Handles atomic bucket accounting using a tiny Lua script so that
 * the rate-limit logic stays race-free across multiple gateway nodes.
 */
const LUA_TOKEN_BUCKET = `
-- KEYS[1]   = bucket key
-- ARGV[1]   = max requests
-- ARGV[2]   = window (ms)
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return current
`;

export class DistributedRateLimiter {
  private redis: RedisClient;
  private inMemoryFallback = new Map<string, { count: number; expires: number }>();

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Consume a single point against a bucket.
   *
   * If Redis is unreachable, falls back to a process-local Map
   * (best-effort, *not* strictly correct across the cluster).
   */
  async consume(
    key: string,
    opts: RateLimitOptions
  ): Promise<RateLimitState> {
    const windowMs = opts.duration * 1000;
    try {
      const current: number = await this.redis.eval(
        LUA_TOKEN_BUCKET,
        1,
        key,
        opts.points,
        windowMs
      );

      const ttlMs: number = await this.redis.pttl(key);
      const remaining = Math.max(opts.points - current, 0);

      return {
        allowed: current <= opts.points,
        remaining,
        reset: Math.ceil((Date.now() + ttlMs) / 1000),
      };
    } catch (err) {
      // Fallback – still mitigate bursts from the same process
      const now = Date.now();
      const bucket = this.inMemoryFallback.get(key);

      if (!bucket || bucket.expires < now) {
        this.inMemoryFallback.set(key, { count: 1, expires: now + windowMs });
        return {
          allowed: true,
          remaining: opts.points - 1,
          reset: Math.ceil((now + windowMs) / 1000),
        };
      }

      bucket.count += 1;
      const allowed = bucket.count <= opts.points;
      return {
        allowed,
        remaining: Math.max(opts.points - bucket.count, 0),
        reset: Math.ceil(bucket.expires / 1000),
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                   Express/Koa-compatible middleware                        */
/* -------------------------------------------------------------------------- */

export interface RateLimitMiddlewareConfig {
  redis: RedisClient;
  global: RateLimitOptions;
  policyProvider?: RateLimitPolicyProvider;
  /**
   * If true the middleware continues the chain even when the user
   * is throttled (the handler must check `res.locals.rateLimit`).
   * Defaults to `false`.
   */
  soft?: boolean;
}

/**
 * Factory that produces an Express-style middleware.
 */
export function createRateLimitMiddleware(
  config: RateLimitMiddlewareConfig
): RequestHandler {
  const engine = new DistributedRateLimiter(config.redis);
  const soft = config.soft ?? false;

  return async (req: Request, res: Response, next: NextFunction) => {
    // 1. Resolve declared policy (if any)
    const handler = (req as any).route?.stack?.slice(-1)[0]?.handle ?? undefined; // best-effort
    let policy = getRateLimitMetadata(handler) ?? config.global;

    // 2. Allow dynamic overrides
    if (config.policyProvider) {
      policy = await Promise.resolve(
        config.policyProvider.resolve(req, policy)
      );
    }

    // 3. Build bucket key
    const userId = (req as any).user?.id; // Passport.js style
    const identifier = userId ? `uid:${userId}` : `ip:${req.ip}`;
    const prefix = policy.keyPrefix ?? 'generic';
    const sha = crypto.createHash('sha1').update(prefix + ':' + identifier).digest('hex');
    const bucketKey = `rl:${prefix}:${sha}`;

    // 4. Consume
    const state = await engine.consume(bucketKey, policy);

    // 5. Expose details through response headers (RFC 6585)
    res.setHeader('X-RateLimit-Limit', policy.points.toString());
    res.setHeader('X-RateLimit-Remaining', state.remaining.toString());
    res.setHeader('X-RateLimit-Reset', state.reset.toString());

    res.locals.rateLimit = state;

    if (!state.allowed && !soft) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Allowed ${policy.points} requests per ${policy.duration}s window.`,
        retry_after: state.reset - Math.floor(Date.now() / 1000),
      });
      return;
    }

    next();
  };
}

/* -------------------------------------------------------------------------- */
/*                          Example usage snippet                             */
/* -------------------------------------------------------------------------- */

/**
 * Below is an illustrative snippet showing how the module would be wired
 * in an Express application. It is **not** executed as part of the file
 * (kept for documentation purposes only).
 */

/* eslint-disable @typescript-eslint/no-unused-vars */
// import express from 'express';
// import Redis from 'ioredis';

// const app = express();
// const redis = new Redis(process.env.REDIS_URL);

// // Global policy: 120 requests / minute
// app.use(
//   createRateLimitMiddleware({
//     redis,
//     global: { points: 120, duration: 60 },
//   })
// );

// class TimelineController {
//   @RateLimit({ points: 30, duration: 60, keyPrefix: 'timeline' })
//   static async getTimeline(req: Request, res: Response) {
//     // ... domain logic ...
//     res.json({ data: [] });
//   }
// }

// app.get('/v1/timeline', TimelineController.getTimeline);
// /* eslint-enable @typescript-eslint/no-unused-vars */

/* -------------------------------------------------------------------------- */
/*                              Module exports                                */
/* -------------------------------------------------------------------------- */

// Re-exporting for convenience – upstream modules can simply import
// everything from `module_79` and remain decoupled from the file layout.
export default {
  RateLimit,
  createRateLimitMiddleware,
  DistributedRateLimiter,
};
```