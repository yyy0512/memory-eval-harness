```typescript
/**
 * SocialPulse Gateway – Rate-Limiting & Abuse-Guard Module
 * -------------------------------------------------------
 * This module ships a production–grade, Redis–backed sliding-window rate-limiter
 * that can be shared between the HTTP (Express) and GraphQL layers.  A Lua script
 * guarantees atomicity while an in-memory fallback keeps the gateway functional
 * during intermittent Redis outages (at the cost of accuracy across replicas).
 *
 * Primary exports
 *  - SlidingWindowRateLimiter ..... Core service
 *  - createRateLimitMiddleware .... Plug-n-play Express middleware
 *  - createRateLimitDirective ..... GraphQL @rateLimit(max:, window:) directive
 *
 * Usage (HTTP):
 *  const limiter = new SlidingWindowRateLimiter({ redis });
 *  app.use('/api', createRateLimitMiddleware({ max: 150, windowMs: 60_000 }, limiter));
 *
 * Usage (GraphQL):
 *  const limiter = new SlidingWindowRateLimiter({ redis });
 *  const rateLimitDirective = createRateLimitDirective(limiter);
 *  const schema = makeExecutableSchema({ typeDefs, resolvers, schemaDirectives: { rateLimit: rateLimitDirective }});
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { GraphQLField } from 'graphql';
import { defaultFieldResolver } from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';
import Redis from 'ioredis';
import pino from 'pino';

/* -------------------------------------------------------------------------- */
/*                                Configuration                               */
/* -------------------------------------------------------------------------- */

export interface RateLimitingOptions {
  /** Sliding-window size in milliseconds (e.g. 60 000 = 1 minute) */
  windowMs: number;
  /** Max requests allowed within the window                           */
  max: number;
  /** Optional key prefix to avoid collisions with other Redis entries */
  keyPrefix?: string;
  /** If true, headers (RateLimit-*) are attached to HTTP responses    */
  headers?: boolean;
}

export interface RateLimitContext {
  /** A unique identifier for the actor (e.g. userId, IP) */
  key: string;
  /** Epoch milliseconds of the current request           */
  now?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Remaining attempts            */
  remaining: number;
  /** Epoch ms when the window resets */
  reset: number;
}

/* -------------------------------------------------------------------------- */
/*                        Sliding-Window Rate-Limiter                         */
/* -------------------------------------------------------------------------- */

export class SlidingWindowRateLimiter {
  private readonly redis?: Redis;
  private readonly inMemoryStore = new Map<string, number[]>();
  private readonly log = pino({ name: 'SlidingWindowRateLimiter' });
  private readonly opts: RateLimitingOptions;

  private static LUA_SCRIPT = `
    -- KEYS[1] -> rate limit key
    -- ARGV[1] -> current timestamp (ms)
    -- ARGV[2] -> window size (ms)
    -- ARGV[3] -> max allowed
    local key     = KEYS[1]
    local now     = tonumber(ARGV[1])
    local window  = tonumber(ARGV[2])
    local maxHits = tonumber(ARGV[3])

    -- purge outdated hits
    redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
    -- add current hit
    redis.call('ZADD', key, now, now)
    -- get current count
    local count = redis.call('ZCARD', key)
    -- set TTL slightly bigger than window to auto-expire keys
    redis.call('PEXPIRE', key, window + 500)

    return count
  `;

  constructor(
    params: { redis?: Redis } & Partial<RateLimitingOptions> = {},
  ) {
    const { redis, ...defaults } = params;
    this.redis = redis;
    this.opts = {
      windowMs: defaults.windowMs ?? 60_000,
      max: defaults.max ?? 100,
      keyPrefix: defaults.keyPrefix ?? 'rl:',
      headers: defaults.headers ?? true,
    };

    // Register Lua script once when Redis is provided.
    if (this.redis) {
      this.redis.defineCommand('slidingWindowRateLimit', {
        numberOfKeys: 1,
        lua: SlidingWindowRateLimiter.LUA_SCRIPT,
      });
    }
  }

  /**
   * Consume a single token from the rate-limit bucket.
   * If capacity is exhausted, `allowed` will be false.
   */
  async consume(
    { key, now = Date.now() }: RateLimitContext,
    opts: Partial<RateLimitingOptions> = {},
  ): Promise<RateLimitResult> {
    const conf = { ...this.opts, ...opts };
    const redisKey = `${conf.keyPrefix}${key}`;

    let hits: number;

    if (this.redis) {
      try {
        // @ts-ignore – defineCommand injected by ioredis
        hits = await this.redis.slidingWindowRateLimit(
          redisKey,
          now,
          conf.windowMs,
          conf.max,
        );
      } catch (err) {
        this.log.warn({ err }, 'Falling back to in-memory rate limiter');
        hits = this.consumeInMemory(redisKey, now, conf);
      }
    } else {
      hits = this.consumeInMemory(redisKey, now, conf);
    }

    const allowed = hits <= conf.max;
    const remaining = Math.max(conf.max - hits, 0);
    const reset = now + conf.windowMs;

    return { allowed, remaining, reset };
  }

  /* -------------------------------- Internals ------------------------------- */

  private consumeInMemory(
    key: string,
    now: number,
    conf: RateLimitingOptions,
  ): number {
    const bucket = this.inMemoryStore.get(key) ?? [];
    // remove outdated
    const freshHits = bucket.filter((ts) => ts > now - conf.windowMs);
    freshHits.push(now);
    this.inMemoryStore.set(key, freshHits);
    return freshHits.length;
  }
}

/* -------------------------------------------------------------------------- */
/*                              Express Middleware                            */
/* -------------------------------------------------------------------------- */

/**
 * Factory: returns an Express middleware that enforces per-actor rate limits.
 *
 * @example
 * const limiter = new SlidingWindowRateLimiter({ redis });
 * app.use('/v1', createRateLimitMiddleware({ windowMs: 10_000, max: 50 }, limiter));
 */
export const createRateLimitMiddleware = (
  opts: Partial<RateLimitingOptions>,
  limiter: SlidingWindowRateLimiter,
): RequestHandler => {
  const defaults: RateLimitingOptions = {
    windowMs: 60_000,
    max: 100,
    headers: true,
  };

  const config = { ...defaults, ...opts };

  return async (req: Request, res: Response, next: NextFunction) => {
    const actorKey =
      // Prefer authenticated user ID if available, else fall back to IP
      (req as any).user?.id?.toString() ??
      req.headers['x-forwarded-for']?.toString()?.split(',')[0] ??
      req.ip;

    const { allowed, remaining, reset } = await limiter.consume({ key: actorKey }, config);

    // Attach standard RateLimit response headers if enabled
    if (config.headers) {
      res.setHeader('RateLimit-Limit', config.max.toString());
      res.setHeader('RateLimit-Remaining', remaining.toString());
      res.setHeader('RateLimit-Reset', Math.ceil(reset / 1000).toString());
    }

    if (!allowed) {
      res.status(429).json({
        status: 429,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
      });
      return;
    }

    next();
  };
};

/* -------------------------------------------------------------------------- */
/*                        GraphQL @rateLimit Directive                        */
/* -------------------------------------------------------------------------- */

interface GraphQLRateLimitArgs {
  max: number;
  window: number; // seconds
}

/**
 * Factory: Creates a SchemaDirective class bound to the supplied rate-limiter.
 * The directive can be attached at the field or type level:
 *
 *   type Query {
 *     secureResource: String @rateLimit(max: 20, window: 60)
 *   }
 */
export const createRateLimitDirective = (
  limiter: SlidingWindowRateLimiter,
) => {
  return class RateLimitDirective extends SchemaDirectiveVisitor {
    // @ts-ignore – `visitFieldDefinition` is invoked dynamically by GraphQL-Tools
    visitFieldDefinition(field: GraphQLField<any, any>) {
      const { resolve = defaultFieldResolver } = field;
      const { max, window }: GraphQLRateLimitArgs = this.args as any;

      field.resolve = async function (source, args, context, info) {
        const key =
          context?.user?.id?.toString() ??
          context?.ip ??
          'anonymous';

        const rate = await limiter.consume(
          { key },
          { windowMs: window * 1000, max },
        );

        if (!rate.allowed) {
          throw new Error(
            `Rate limit exceeded. Allowed ${max} requests in ${window}s.`,
          );
        }

        return resolve.call(this, source, args, context, info);
      };
    }
  };
};
```