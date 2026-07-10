```typescript
/**
 * SocialPulse Gateway
 * src/module_27.ts
 *
 * Adaptive, reputation-aware rate-limiter used by REST controllers and GraphQL
 * resolvers.  The implementation leverages Redis for distributed token buckets
 * (single Lua script => O(1) atomic ops) and can gracefully degrade to an
 * in-memory store whenever Redis is unavailable (e.g., during bootstrap or
 * maintenance windows).
 *
 * The limiter understands the following concepts:
 *   • identityKey     – userId | ip | apiKey (pluggable)
 *   • reputationScore – 0‥100  (injected by upstream middleware)
 *   • dynamicBudget   – baseLimit × (1 + reputationScore/100)
 *   • penaltySeconds  – exponential back-off applied on abuse
 *
 * Usage (REST):
 *   app.get(
 *     "/v1/timeline",
 *     adaptiveRateLimiter.express({ baseLimit: 100, windowSec: 60 }),
 *     timelineController.list
 *   );
 *
 * Usage (GraphQL):
 *   const resolver = {
 *     Query: {
 *       feed: adaptiveRateLimiter.graphql({ baseLimit: 400, windowSec: 60 })(
 *         (_: any, args: FeedArgs, ctx: Ctx) => feedUseCase.execute(args, ctx)
 *       ),
 *     },
 *   };
 */

import Redis, { Redis as RedisClient } from "ioredis";
import { Request, Response, NextFunction } from "express";
import { v4 as uuid } from "uuid";

////////////////////////////////////////////////////////////////////////////////
// Interfaces & Types
////////////////////////////////////////////////////////////////////////////////

export interface RateLimitOptions {
  /** Max number of requests allowed inside the window (before multiplier). */
  baseLimit: number;
  /** Window size in seconds. */
  windowSec: number;
  /** Optional penalty applied once the limit is exceeded. (seconds) */
  penaltySec?: number;
  /**
   * Optional callback that extracts identity from request / GraphQL context.
   * When not provided defaults to `req.user?.id || req.ip`.
   */
  identityExtractor?<T = any>(source: Request | T): string | undefined;
}

interface InternalBucketState {
  remaining: number;
  resetAt: number; // UNIX timestamp (seconds)
}

interface ReputationAwareBudget {
  absoluteLimit: number;
  windowSec: number;
}

export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string | Error, meta?: Record<string, unknown>): void;
}

////////////////////////////////////////////////////////////////////////////////
// Redis Lua Script for atomic token bucket
////////////////////////////////////////////////////////////////////////////////

/**
 * KEYS[1]   => bucket key
 * ARGV[1]   => window (seconds)
 * ARGV[2]   => maxTokens
 *
 * Returns:
 *   { remaining, resetTS }
 */
const LUA_TOKEN_BUCKET = `
local current = redis.call("INCR", KEYS[1])

if tonumber(current) == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end

local ttl = redis.call("TTL", KEYS[1])
return { tonumber(ARGV[2]) - tonumber(current), tonumber(ttl) }
`;

/**
 * Friendly wrapper around Redis#eval that automatically loads the script
 * if not yet cached.
 */
async function evalTokenBucket(
  redis: RedisClient,
  key: string,
  windowSec: number,
  maxTokens: number,
): Promise<InternalBucketState> {
  // Note: `redis.defineCommand` would be cleaner, but we keep it inline to
  // avoid business logic leakage into infrastructure bootstrapping.
  const res = (await redis.eval(
    LUA_TOKEN_BUCKET,
    1,
    key,
    windowSec,
    maxTokens,
  )) as [number, number];

  const [remaining, ttl] = res;
  return {
    remaining,
    resetAt: Math.floor(Date.now() / 1000) + ttl,
  };
}

////////////////////////////////////////////////////////////////////////////////
// In-memory fallback
////////////////////////////////////////////////////////////////////////////////

class InMemoryStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  public async consume(
    key: string,
    windowSec: number,
    maxTokens: number,
  ): Promise<InternalBucketState> {
    const now = Date.now() / 1000; // seconds
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSec });
      return {
        remaining: maxTokens - 1,
        resetAt: Math.floor(now + windowSec),
      };
    }

    bucket.count += 1;
    return {
      remaining: Math.max(0, maxTokens - bucket.count),
      resetAt: Math.floor(bucket.resetAt),
    };
  }
}

////////////////////////////////////////////////////////////////////////////////
// AdaptiveRateLimiter – public API
////////////////////////////////////////////////////////////////////////////////

export class AdaptiveRateLimiter {
  private readonly redis?: RedisClient;
  private readonly memory = new InMemoryStore();
  private readonly logger: ILogger;

  constructor(params: { redis?: RedisClient; logger: ILogger }) {
    this.redis = params.redis;
    this.logger = params.logger;
  }

  ////////////////////////////////////////////////////////////////////////////
  // Express middleware factory
  ////////////////////////////////////////////////////////////////////////////

  public express = (opts: RateLimitOptions) => {
    return async (req: Request, res: Response, next: NextFunction) => {
      const identityKey =
        opts.identityExtractor?.(req) ||
        (req as any).user?.id ||
        req.ip ||
        uuid(); // fallback for anonymous

      const budget = this.computeBudget({
        baseLimit: opts.baseLimit,
        reputation: (req as any).reputationScore ?? 0,
      });

      try {
        const state = await this.consume(identityKey, opts.windowSec, budget);

        // Add standard RateLimit headers (RFC-draft spec)
        res.setHeader("RateLimit-Limit", budget.absoluteLimit.toString());
        res.setHeader("RateLimit-Remaining", state.remaining.toString());
        res.setHeader("RateLimit-Reset", state.resetAt.toString());

        if (state.remaining < 0) {
          const retryAfter = Math.max(1, state.resetAt - Date.now() / 1000);
          res.setHeader("Retry-After", retryAfter.toString());
          res.status(429).json({
            error: "Too Many Requests",
            retryAfter,
          });
          this.logger.warn("rate_limit.exceeded", {
            identityKey,
            path: req.path,
            method: req.method,
            retryAfter,
          });
          return;
        }

        next();
      } catch (err) {
        this.logger.error("rate_limit.failed", { err });
        // Fail-open, otherwise we take down the API in case of cache failure
        next();
      }
    };
  };

  ////////////////////////////////////////////////////////////////////////////
  // GraphQL resolver wrapper
  ////////////////////////////////////////////////////////////////////////////

  public graphql =
    <TSource extends object = any, TArgs = any, TContext = any>(
      opts: RateLimitOptions,
    ) =>
    <TResult = any>(
      resolver: (
        source: TSource,
        args: TArgs,
        context: TContext,
        info: any,
      ) => Promise<TResult> | TResult,
    ) =>
    async (
      source: TSource,
      args: TArgs,
      context: TContext & { reputationScore?: number },
      info: any,
    ): Promise<TResult> => {
      const identityKey =
        opts.identityExtractor?.(context) ||
        (context as any).user?.id ||
        (context as any).ip ||
        uuid();

      const budget = this.computeBudget({
        baseLimit: opts.baseLimit,
        reputation: context.reputationScore ?? 0,
      });

      const state = await this.consume(identityKey, opts.windowSec, budget);

      if (state.remaining < 0) {
        this.logger.warn("rate_limit.exceeded", {
          identityKey,
          field: info?.fieldName,
        });
        throw new Error("Rate limit exceeded");
      }

      return resolver(source, args, context, info);
    };

  ////////////////////////////////////////////////////////////////////////////
  // Private helpers
  ////////////////////////////////////////////////////////////////////////////

  private async consume(
    identityKey: string,
    windowSec: number,
    budget: ReputationAwareBudget,
  ): Promise<InternalBucketState> {
    if (this.redis) {
      return evalTokenBucket(this.redis, identityKey, windowSec, budget.absoluteLimit);
    }

    this.logger.warn("rate_limit.redis_unavailable_fallback", { identityKey });
    return this.memory.consume(identityKey, windowSec, budget.absoluteLimit);
  }

  private computeBudget(params: {
    baseLimit: number;
    reputation: number; // 0‥100
  }): ReputationAwareBudget {
    const multiplier = 1 + Math.min(100, Math.max(0, params.reputation)) / 100; // 1‥2
    const absolute = Math.floor(params.baseLimit * multiplier);
    return {
      absoluteLimit: absolute,
      windowSec: 60,
    };
  }
}

////////////////////////////////////////////////////////////////////////////////
// Default instance (for convenience). In DI setups you likely won't use this.
////////////////////////////////////////////////////////////////////////////////

import pino from "pino";
const logger: ILogger = pino({
  name: "AdaptiveRateLimiter",
  level: process.env.LOG_LEVEL || "info",
});

let redisClient: RedisClient | undefined;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
  });
  redisClient.on("error", (err) => logger.error("redis.error", { err }));
}

export const adaptiveRateLimiter = new AdaptiveRateLimiter({
  redis: redisClient,
  logger,
});
```