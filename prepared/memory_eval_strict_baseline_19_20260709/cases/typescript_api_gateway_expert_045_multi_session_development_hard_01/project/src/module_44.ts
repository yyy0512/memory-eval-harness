```typescript
/* ============================================================================
 *  SocialPulse Gateway – Rate-Limiter (module_44.ts)
 *  ----------------------------------------------------------------------------
 *  This module implements a centralized, Redis-backed rate-limiter that can be
 *  applied uniformly across REST controllers, GraphQL resolvers, and any other
 *  incoming surface.  It supports dynamic, per-user / per-route policies, safe
 *  fall-backs, structured logging, and first-class TypeScript ergonomics.
 *
 *  Layers touched:
 *    – Domain:   RateLimitPolicy (value-object)
 *    – Infra:    RedisRateLimiter  (adapter)
 *    – Pres.:    Express middleware + GraphQL helper
 *  ============================================================================ */

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import ms from 'ms';
import { GraphQLFieldResolver } from 'graphql';

/* ---------------------------------------------------------------------------
 *  Shared Interfaces / Types
 *  --------------------------------------------------------------------------- */

/**
 * Value object that describes a single rate-limit policy.
 * Examples:
 *   – 100 requests per 15m  (window = 15m, max = 100)
 *   – 10 messages per min   (window = 1m,  max = 10)
 */
export interface RateLimitPolicy {
  /**
   * Maximum number of tokens that can be consumed during a single window.
   */
  readonly max: number;

  /**
   * Window duration in milliseconds.
   * Accepts either raw numbers or a string parseable by `ms()` (e.g. "15m").
   */
  readonly window: number | string;

  /**
   * Optional descriptive label (used only for metrics & logs).
   */
  readonly name?: string;
}

/**
 * Contract for a pluggable rate-limiter.
 */
export interface IRateLimiter {
  /**
   * Attempt to consume a single token for `key` under the given `policy`.
   *
   * Returns `true` if the request should be allowed, or `false` when the
   * quota is exhausted.
   */
  consumeToken(key: string, policy: RateLimitPolicy): Promise<boolean>;

  /**
   * Returns a human-readable value indicating how long, in seconds, until the
   * current window resets for `key`.  Guarantees non-negative integer.
   */
  secondsUntilReset(key: string): Promise<number>;
}

/**
 * Naïve fallback buffer to protect the system when Redis is unavailable.
 */
const inMemoryBuckets: Record<string, { reset: number; count: number }> = {};

/* ---------------------------------------------------------------------------
 *  Infrastructure Adapter: Redis-backed Sliding-Window Limiter
 *  --------------------------------------------------------------------------- */

export class RedisRateLimiter implements IRateLimiter {
  private readonly redis: Redis;

  constructor(
    redis: Redis,
    private readonly logger: { info: (m: string) => void; warn: (m: string) => void }
  ) {
    this.redis = redis;
  }

  /** @inheritdoc */
  public async consumeToken(key: string, policy: RateLimitPolicy): Promise<boolean> {
    const windowMs = typeof policy.window === 'string' ? ms(policy.window) : policy.window;
    const now = Date.now();
    const expiresAt = now + windowMs;

    try {
      // Use a single atomic script to increment usage and set TTL if new.
      // NOTE: `INCR` followed by `PEXPIRE` is NOT atomic – we use Lua here.
      const tokenCount = await this.redis.eval(
        `
        local current = redis.call("INCR", KEYS[1])
        if current == 1 then
          redis.call("PEXPIREAT", KEYS[1], ARGV[1])
        end
        return current
      `,
        1,
        key,
        expiresAt
      );

      const allowed = Number(tokenCount) <= policy.max;
      if (!allowed) {
        this.logger.warn(
          `[RATE-LIMIT] Blocked key="${key}" (policy="${policy.name ?? 'unnamed'}", window=${windowMs}ms max=${policy.max})`
        );
      }
      return allowed;
    } catch (err) {
      // Redis unavailable – degrade gracefully using in-memory window.
      this.logger.warn(`[RATE-LIMIT] Redis failure – activating in-memory fallback. ${String(err)}`);
      const bucket = inMemoryBuckets[key] ?? { reset: now + windowMs, count: 0 };
      if (bucket.reset < now) {
        // Reset window
        bucket.count = 0;
        bucket.reset = now + windowMs;
      }
      bucket.count++;
      inMemoryBuckets[key] = bucket;

      return bucket.count <= policy.max;
    }
  }

  /** @inheritdoc */
  public async secondsUntilReset(key: string): Promise<number> {
    try {
      const ttl = await this.redis.pttl(key); // returns -2 | -1 | ms
      return ttl < 0 ? 0 : Math.ceil(ttl / 1000);
    } catch {
      const bucket = inMemoryBuckets[key];
      if (!bucket) return 0;
      const diff = bucket.reset - Date.now();
      return diff < 0 ? 0 : Math.ceil(diff / 1000);
    }
  }
}

/* ---------------------------------------------------------------------------
 *  Presentation Layer: Express Middleware
 *  --------------------------------------------------------------------------- */

type PolicyResolver = (req: Request) => RateLimitPolicy;
type KeyResolver = (req: Request) => string;

/**
 * Factory to create a rate-limiting middleware for Express routes.
 *
 * Usage:
 *   app.get("/v1/timeline", rateLimit({
 *     key: req => `timeline:${req.user.id}`,
 *     policy: () => ({ max: 100, window: "15m", name: "timeline.read" })
 *   }), timelineController.index);
 */
export const rateLimit = (
  limiter: IRateLimiter,
  opts: {
    key: KeyResolver;
    policy: PolicyResolver;
    /**
     * Optionally override the default "Too Many Requests" (429) behaviour.
     */
    onRejected?: (req: Request, res: Response) => void;
  }
) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const policy = opts.policy(req);
    const key = opts.key(req);
    const allowed = await limiter.consumeToken(key, policy);

    if (allowed) {
      return next();
    }

    // Rejected – add useful headers per RFC-6585 and OWASP best-practice
    res.setHeader('Retry-After', await limiter.secondsUntilReset(key));
    res.setHeader('X-RateLimit-Limit', String(policy.max));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Policy', policy.name ?? 'generic');

    if (opts.onRejected) {
      return opts.onRejected(req, res);
    }

    res.status(429).json({
      status: 429,
      error: 'too_many_requests',
      message: `Rate limit exceeded (max ${policy.max} per ${policy.window}). Please try again later.`,
    });
  };
};

/* ---------------------------------------------------------------------------
 *  Presentation Layer: GraphQL Resolver Wrapper
 *  --------------------------------------------------------------------------- */

/**
 * Wrap a GraphQL resolver to enforce rate-limiting.
 *
 * Example:
 *   const getFeed = withRateLimit(
 *     { max: 10, window: "1m", name: "mutation.postMessage" },
 *     ctx => `postMessage:${ctx.viewer.id}`,
 *     limiter,
 *     logger
 *   )(async (_p, args, ctx) => { … });
 */
export function withRateLimit<
  TSource,
  TArgs extends Record<string, any>,
  TContext,
  TResult
>(
  policy: RateLimitPolicy,
  keyResolver: (ctx: TContext) => string,
  limiter: IRateLimiter,
  logger: { warn: (msg: string) => void }
): (
  next: GraphQLFieldResolver<TSource, TContext, TArgs>
) => GraphQLFieldResolver<TSource, TContext, TArgs, Promise<TResult>> {
  return (next) => {
    return async (source, args, ctx, info) => {
      const key = keyResolver(ctx);
      const allowed = await limiter.consumeToken(key, policy);

      if (allowed) {
        return next(source, args, ctx, info);
      }

      logger.warn(
        `[RATE-LIMIT] GraphQL field "${info.fieldName}" blocked for key="${key}" under policy="${policy.name ?? 'unnamed'}"`
      );

      throw new Error(
        `Rate limit exceeded: max ${policy.max} requests per ${policy.window}.`
      );
    };
  };
}

/* ---------------------------------------------------------------------------
 *  Helper: Default Policy Definitions
 *  --------------------------------------------------------------------------- */

/**
 * Example global defaults.  In real life, these would be loaded from config
 * or a feature-flag service to support dynamic roll-outs.
 */
export const DEFAULT_POLICIES = {
  timelineRead: Object.freeze<RateLimitPolicy>({
    name: 'timeline.read',
    max: 120,
    window: '15m',
  }),
  postCreate: Object.freeze<RateLimitPolicy>({
    name: 'post.create',
    max: 20,
    window: '1h',
  }),
};

/* ---------------------------------------------------------------------------
 *  Example Wiring (for illustration – remove if wiring elsewhere)
 *  --------------------------------------------------------------------------- */

// !!! NOTE: Actual application bootstrap code will live outside this module.
// The following snippet demonstrates typical usage and can be safely deleted.

/*
import express from 'express';
import { ApolloServer } from 'apollo-server-express';
import Redis from 'ioredis';
import { buildSchema } from 'type-graphql';

(async () => {
  const redis = new Redis(process.env.REDIS_URL);
  const logger = { info: console.log, warn: console.warn };
  const limiter = new RedisRateLimiter(redis, logger);

  // REST
  const app = express();
  app.get(
    '/v1/timeline',
    rateLimit(limiter, {
      key: (req) => `timeline:${req.user?.id ?? req.ip}`,
      policy: () => DEFAULT_POLICIES.timelineRead,
    }),
    timelineController.index
  );

  // GraphQL
  const schema = await buildSchema({ resolvers: [/* … *\/] });
  const server = new ApolloServer({
    schema,
    context: ({ req }) => ({ viewer: req.user, limiter, logger }),
  });
  server.applyMiddleware({ app, path: '/graphql' });

  app.listen(3000, () => logger.info(`Gateway listening at :3000`));
})();
*/

/* ---------------------------------------------------------------------------
 *  End of module_44.ts
 *  --------------------------------------------------------------------------- */
```