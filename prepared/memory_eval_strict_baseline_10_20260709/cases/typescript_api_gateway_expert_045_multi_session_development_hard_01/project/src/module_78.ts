```typescript
/**
 * SocialPulse Gateway – Distributed Rate-Limiter
 * ----------------------------------------------
 * Scope   : Cross-cutting infrastructure middleware
 * Layer   : Infrastructure → Adapters
 * Purpose : Guard every REST & GraphQL entry-point against abusive patterns
 *           such as follow-spam, timeline scrapes or message floods.
 *
 * Highlights
 *  ‣ Token-bucket algorithm with a sliding window approximation.
 *  ‣ Redis backend for distributed enforcement across the API-gateway fleet.
 *  ‣ Per-consumer granularity (userId / apiKey / ip), route-level overrides.
 *  ‣ Express middleware & Apollo GraphQL plugin in one cohesive factory.
 *  ‣ Graceful degradation to an in-memory store when Redis is unreachable.
 *
 * File path: src/module_78.ts
 */

import type { Request, Response, NextFunction } from 'express';
import type { PluginDefinition } from 'apollo-server-core';
import { ForbiddenError, ApolloError } from 'apollo-server-errors';
import Redis, { Redis as RedisClient } from 'ioredis';
import ms from 'ms';

/* -------------------------------------------------------------------------- */
/*                             Type Declarations                              */
/* -------------------------------------------------------------------------- */

export interface RateLimiterConfig {
  /**
   * Global maximum number of tokens in the bucket (burst capacity).
   *
   * Example:
   *   • 120 = allow at most 120 requests in a sliding window of `windowMs`.
   */
  readonly capacity: number;

  /**
   * Sliding-window length (milliseconds). Each successful request consumes
   * one token and schedules its refill after `windowMs`.
   */
  readonly windowMs: number;

  /**
   * Prefix for Redis keys. Useful when multiple environments (dev/stg/prod)
   * share the same Redis cluster.
   *
   * Example: `spg:ratelimit`
   */
  readonly redisNamespace: string;

  /**
   * When Redis is unreachable, fall back to a process-local in-memory bucket.
   * This prevents hard outages, but means limits are enforced per-instance.
   */
  readonly fallbackToMemory?: boolean;

  /**
   * List of HTTP paths / GraphQL operations that bypass throttling.
   * Use with caution (e.g. health-checks or public introspection).
   */
  readonly whitelistedRoutes?: readonly string[];
}

/**
 * Outcome returned by `consumeToken`.
 * – `allowed = true`  → request may proceed.
 * – `allowed = false` → rate-limit exceeded.
 */
interface RateLimitResult {
  readonly allowed: boolean;
  /**
   * Remaining tokens after consumption.
   * `0` when limit is exceeded or bucket is empty.
   */
  readonly remaining: number;
  /**
   * Time until next token becomes available (milliseconds).
   * Provided only when `allowed` is false.
   */
  readonly retryAfter?: number;
}

/* -------------------------------------------------------------------------- */
/*                             Utility Functions                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a unique consumer key from the request. Priority:
 *   1. Authenticated userId (bearer / session)
 *   2. X-API-Key header
 *   3. Remote IP
 */
const buildConsumerId = (req: Request): string => {
  // These properties are populated by authentication middleware earlier
  const userId = (req as any).auth?.userId as string | undefined; // eslint-disable-line @typescript-eslint/no-unsafe-member-access
  const apiKey = req.headers['x-api-key'] as string | undefined;
  const ip = req.ip;

  return userId ?? apiKey ?? ip ?? 'anonymous';
};

/**
 * Derive a route identifier for bucket separation.
 * For REST: HTTP method + path
 * For GraphQL: "GRAPHQL:{operationName}"
 */
const buildRouteId = (req: Request): string => {
  if (req.body && typeof req.body.operationName === 'string') {
    // GraphQL request
    return `GRAPHQL:${req.body.operationName}`;
  }
  // REST request
  return `${req.method}:${req.path}`;
};

/**
 * Simple sleep helper for back-off while Redis reconnects.
 */
const sleep = (msDelay: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, msDelay));

/* -------------------------------------------------------------------------- */
/*                              Core Class                                    */
/* -------------------------------------------------------------------------- */

class DistributedRateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly redis: RedisClient | null;
  private readonly memoryBuckets: Map<string, number[]> = new Map();

  constructor(config: RateLimiterConfig) {
    this.config = {
      fallbackToMemory: true,
      whitelistedRoutes: [],
      ...config,
    };

    try {
      // Reuse Redis singleton if already instantiated elsewhere
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      this.redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        enableOfflineQueue: false,
        connectTimeout: 1_000,
        lazyConnect: true,
      });
      void this.redis.connect().catch(() => {
        // Will fallback to memory until Redis is back
        this.redis = null;
      });
    } catch {
      this.redis = null;
    }
  }

  /**
   * Attempt to consume one token from the bucket identified by (consumer, route).
   */
  public async consumeToken(
    consumerId: string,
    routeId: string,
  ): Promise<RateLimitResult> {
    const bucketKey = `${this.config.redisNamespace}:${consumerId}:${routeId}`;

    if (this.redis) {
      try {
        return await this.consumeRedis(bucketKey);
      } catch (err) {
        // Redis might be temporarily unavailable – degrade gracefully
        console.error('[RateLimiter] Redis error, falling back to memory:', err);
        if (!this.config.fallbackToMemory) {
          throw new ApolloError('Rate-limiter backend failure', 'RATE_LIMIT_BACKEND_DOWN');
        }
        return this.consumeMemory(bucketKey);
      }
    }

    // Redis disabled or not connected
    if (this.config.fallbackToMemory) {
      return this.consumeMemory(bucketKey);
    }

    throw new ApolloError('Rate-limiter backend unavailable', 'RATE_LIMIT_BACKEND_UNAVAILABLE');
  }

  /* ---------------------------------------------------------------------- */
  /*                      Algorithms (Redis / Memory)                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Token-bucket on Redis using sorted sets for sliding window.
   * Complexity: O(log(N)) where N = number of requests in window.
   */
  private async consumeRedis(bucketKey: string): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    // Wrap script into Lua for atomicity
    const lua = `
      local key         = KEYS[1]
      local now         = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local capacity    = tonumber(ARGV[3])

      -- Remove expired entries
      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

      local current = redis.call('ZCARD', key)

      if current < capacity then
        -- Accept the request and add entry
        redis.call('ZADD', key, now, now)
        -- Set TTL to ensure bucket auto-expires when idle
        redis.call('PEXPIRE', key, ${this.config.windowMs})
        return {1, capacity - current - 1}
      else
        -- Reject – calculate retryAfter (time until oldest token expires)
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
        return {0, 0, oldest}
      end
    ` as const;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const result = (await this.redis!.eval(lua, 1, bucketKey, now, windowStart, this.config.capacity)) as [
      0 | 1,
      number,
      number?,
    ];

    const allowed = result[0] === 1;
    const remaining = result[1];
    const retryAfter = !allowed ? windowStart + this.config.windowMs - (result[2] ?? 0) : undefined;

    return { allowed, remaining, retryAfter };
  }

  /**
   * In-memory fallback – not distributed, but avoids downtime.
   */
  private consumeMemory(bucketKey: string): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let bucket = this.memoryBuckets.get(bucketKey);
    if (!bucket) {
      bucket = [];
      this.memoryBuckets.set(bucketKey, bucket);
    }

    // Remove expired timestamps
    while (bucket.length && bucket[0] <= windowStart) {
      bucket.shift();
    }

    if (bucket.length < this.config.capacity) {
      bucket.push(now);
      return { allowed: true, remaining: this.config.capacity - bucket.length };
    }

    const retryAfter = bucket[0] + this.config.windowMs - now;
    return { allowed: false, remaining: 0, retryAfter };
  }

  /* ---------------------------------------------------------------------- */
  /*                          Public Interfaces                             */
  /* ---------------------------------------------------------------------- */

  /**
   * Express-compatible middleware.
   */
  public expressMiddleware =
    () => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const routeId = buildRouteId(req);
        if (this.config.whitelistedRoutes?.includes(routeId)) {
          return next();
        }

        const consumerId = buildConsumerId(req);
        const { allowed, retryAfter, remaining } = await this.consumeToken(consumerId, routeId);

        res.setHeader('X-RateLimit-Limit', String(this.config.capacity));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));

        if (!allowed) {
          if (retryAfter !== undefined) {
            res.setHeader('Retry-After', String(Math.ceil(retryAfter / 1_000)));
          }
          return res.status(429).json({
            error: 'Too Many Requests',
            retryAfter,
          });
        }

        return next();
      } catch (err) {
        console.error('[RateLimiter] Middleware error:', err);
        return res.status(500).json({ error: 'Rate-limiter failure' });
      }
    };

  /**
   * Apollo Server plugin for GraphQL operations.
   */
  public apolloPlugin = (): PluginDefinition => ({
    async requestDidStart() {
      return {
        async didResolveOperation(ctx) {
          if (!ctx.request.http) {
            // WebSocket or other protocol – rely on connection-level guard
            return;
          }

          const httpReq = ctx.request.http as any; // Node IncomingMessage
          const routeId = `GRAPHQL:${ctx.operationName ?? 'anonymous'}`;

          if (this.config.whitelistedRoutes?.includes(routeId)) {
            return;
          }

          const consumerId =
            (ctx.context as any).user?.id ??
            httpReq.headers['x-api-key'] ??
            httpReq.connection.remoteAddress ??
            'anonymous';

          const { allowed, retryAfter } = await (async () => {
            // Minimal retry loop when Redis reconnects mid-flight.
            for (let attempts = 0; attempts < 2; attempts += 1) {
              try {
                return await this.consumeToken(consumerId, routeId);
              } catch (err) {
                if (attempts === 0 && /backend/i.test(String(err))) {
                  await sleep(50); // brief back-off
                  continue;
                }
                throw err;
              }
            }
            throw new Error('Unreachable');
          })();

          if (!allowed) {
            throw new ForbiddenError(
              `Rate limit exceeded. Retry after ${ms(retryAfter ?? 0, { long: true })}.`,
            );
          }
        },
      };
    },
  });
}

/* -------------------------------------------------------------------------- */
/*                             Factory / Singleton                            */
/* -------------------------------------------------------------------------- */

/**
 * One shared instance per process keeps memory buckets coherent
 * even when several Express routers or Apollo servers are mounted.
 */
let defaultInstance: DistributedRateLimiter | null = null;

export const getRateLimiter = (config?: Partial<RateLimiterConfig>): DistributedRateLimiter => {
  if (defaultInstance) {
    return defaultInstance;
  }

  const capacity = Number.parseInt(process.env.RATE_LIMIT_CAPACITY ?? '', 10) || 100; // 100 tokens
  const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10) || 60_000; // 1 min

  defaultInstance = new DistributedRateLimiter({
    capacity,
    windowMs,
    redisNamespace: process.env.RATE_LIMIT_REDIS_NS ?? 'spg:ratelimit',
    fallbackToMemory: process.env.RATE_LIMIT_FALLBACK !== 'false',
    whitelistedRoutes: ['/healthz', '/metrics'],
    ...config,
  });

  return defaultInstance;
};

/* -------------------------------------------------------------------------- */
/*                                Re-Exports                                 */
/* -------------------------------------------------------------------------- */

export type { RateLimitResult };
export { DistributedRateLimiter };
```