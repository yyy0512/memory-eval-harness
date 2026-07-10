```typescript
/**************************************************************************************************
 * SocialPulse Gateway
 * ------------------------------------------------------------------------------------------------
 * Module: module_65.ts
 * Purpose: Centralised, reusable rate-limiting utility (REST middleware + GraphQL plugin) with a
 *          Redis-backed sliding-window algorithm and pluggable in-memory fallback. The module is
 *          designed to be consumed both by edge controllers (REST) and GraphQL resolvers while
 *          remaining agnostic of the presentation layer.
 *
 * Architectural layer: Infrastructure → Adapters
 *
 * NOTE: The implementation purposefully avoids any hard dependency on a specific HTTP or GraphQL
 *       framework so it can be wired into Express, Fastify, ApolloServer, Mercurius, etc.
 **************************************************************************************************/

// External ------------------------------------------------------------------

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { GraphQLRequestContext, GraphQLRequestListener } from 'apollo-server-plugin-base';
import { ApolloServerPlugin } from 'apollo-server-plugin-base';
import Redis from 'ioredis';
import pino from 'pino';

// Internal ------------------------------------------------------------------

/**
 * Logger instance shared across the gateway. In real code this would be injected
 * through a DI container. For brevity we create it here.
 */
const logger = pino({ name: 'rate-limiter' });

/**
 * Error returned when a rate limit is exceeded. We keep it distinct to enable
 * specific HTTP/GraphQL error mapping upstream.
 */
export class RateLimitExceededError extends Error {
  public readonly retryAfter: number;
  public readonly remainingHits: number;

  constructor(message: string, retryAfter: number, remainingHits: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfter = retryAfter;
    this.remainingHits = remainingHits;
  }
}

// Types ---------------------------------------------------------------------

export interface RateLimitConfig {
  /**
   * Maximum number of points (i.e. requests) allowed in the bucket.
   */
  points: number;
  /**
   * Window duration in seconds.
   */
  duration: number;
  /**
   * Optional Redis key prefix—useful for multi-tenant environments.
   */
  keyPrefix?: string;
}

/** Envelope returned after each consumption attempt. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // Unix epoch (seconds)
}

/**
 * Store interface which allows us to provide multiple back-ends (Redis, in-memory, etc.)
 * without changing the RateLimiter implementation.
 */
export interface SlidingWindowStore {
  /**
   * Attempt to consume `weight` points for a given key.
   * @returns {Promise<RateLimitResult>} consumption result
   */
  consume(
    key: string,
    weight: number,
    window: number,
    limit: number
  ): Promise<RateLimitResult>;
}

// Implementation ------------------------------------------------------------

/**
 * Lightweight in-memory store for unit / integration tests and local dev
 * environments where Redis is not available.
 *
 * The implementation is NOT distributed and MUST NOT be used in multi-process
 * production setups.
 */
class MemorySlidingWindowStore implements SlidingWindowStore {
  private readonly buckets = new Map<
    string,
    Array<{ timestamp: number; weight: number }>
  >();

  async consume(
    key: string,
    weight: number,
    window: number,
    limit: number
  ): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);

    const records = this.buckets.get(key) ?? [];
    // prune old records
    while (records.length && records[0].timestamp <= now - window) {
      records.shift();
    }

    const sum = records.reduce((acc, r) => acc + r.weight, 0);
    const nextSum = sum + weight;
    const allowed = nextSum <= limit;

    if (allowed) {
      records.push({ timestamp: now, weight });
      this.buckets.set(key, records);
    }

    const remaining = Math.max(limit - (allowed ? nextSum : sum), 0);
    const retryAfter = allowed
      ? 0
      : records.length
      ? records[0].timestamp + window
      : now + window;

    return {
      allowed,
      remaining,
      retryAfter,
    };
  }
}

/**
 * Redis-based sliding window implementation leveraging sorted sets.
 * The algorithm stores each hit under a ZSET with member = timestamp + random,
 * score = timestamp. Expired entries are automatically purged using ZREMRANGEBYSCORE.
 */
class RedisSlidingWindowStore implements SlidingWindowStore {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(client: Redis, prefix = 'rl') {
    this.redis = client;
    this.prefix = prefix;
  }

  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async consume(
    key: string,
    weight: number,
    windowInSec: number,
    limit: number
  ): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowInSec;
    const redisKey = this.key(key);

    // Lua script for atomicity:
    // 1. Remove outdated entries,
    // 2. Count current set,
    // 3. If allowed, add new element,
    // 4. Return tuple(allowed, remaining, retryAfter)
    const lua = `
      local key         = KEYS[1]
      local now         = tonumber(ARGV[1])
      local windowStart = tonumber(ARGV[2])
      local weight      = tonumber(ARGV[3])
      local limit       = tonumber(ARGV[4])

      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)
      local count = tonumber(redis.call('ZCARD', key))
      local next  = count + weight

      if next <= limit then
        for i = 1, weight, 1 do
          redis.call('ZADD', key, now, now .. '-' .. math.random())
        end
        redis.call('EXPIRE', key, windowStart + limit)
        return {1, limit - next, 0}
      else
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')[2]
        return {0, limit - count, oldest + tonumber(ARGV[5])}
      end
    `;

    const result = (await this.redis.eval(lua, 1, redisKey, now, windowStart, weight, limit, windowInSec)) as [
      number,
      number,
      number
    ];

    const [allowedFlag, remaining, retryAfter] = result;

    return {
      allowed: allowedFlag === 1,
      remaining,
      retryAfter,
    };
  }
}

/**
 * Polymorphic rate limiter without any transport-specific assumptions.
 */
export class RateLimiter {
  private readonly conf: RateLimitConfig;
  private readonly store: SlidingWindowStore;

  constructor(conf: RateLimitConfig, store: SlidingWindowStore) {
    this.conf = conf;
    this.store = store;
  }

  /**
   * Consume a single point from the bucket identified by `id`.
   * When `weight` > 1 the consumer drains multiple points at once.
   */
  public async consume(id: string, weight = 1): Promise<RateLimitResult> {
    if (weight <= 0) {
      throw new TypeError('weight must be a positive integer');
    }
    return await this.store.consume(
      id,
      weight,
      this.conf.duration,
      this.conf.points
    );
  }

  /**
   * Express/Connect/Fastify middleware factory.
   */
  public expressMiddleware(
    /**
     * Extractor returning a unique identifier for the subject (userId, IP, API key, etc.)
     * Override to provide custom semantics for your application.
     */
    idExtractor: (req: Request) => string | Promise<string>
  ): RequestHandler {
    return async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        const id = await idExtractor(req);
        const result = await this.consume(id);

        res.setHeader('X-RateLimit-Limit', this.conf.points.toString());
        res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
        res.setHeader(
          'X-RateLimit-Reset',
          result.retryAfter ? result.retryAfter.toString() : '0'
        );

        if (!result.allowed) {
          res.setHeader('Retry-After', (result.retryAfter - Date.now() / 1000).toString());
          next(
            new RateLimitExceededError(
              'Too many requests. Please wait before retrying.',
              result.retryAfter,
              result.remaining
            )
          );
          return;
        }

        return next();
      } catch (err) {
        logger.error({ err }, 'Rate limiter failed');
        return next(err);
      }
    };
  }

  /**
   * ApolloServer plugin factory.
   */
  public apolloPlugin(
    /**
     * Extractor returning a unique identifier for the subject, given the GraphQL
     * request context.
     */
    idExtractor: (ctx: GraphQLRequestContext) => string | Promise<string>
  ): ApolloServerPlugin {
    const limiter = this;
    return {
      async requestDidStart(
        context: GraphQLRequestContext
      ): Promise<GraphQLRequestListener> {
        const identifier = await idExtractor(context);
        const result = await limiter.consume(identifier);

        context.response.http?.headers.set(
          'X-RateLimit-Limit',
          limiter.conf.points.toString()
        );
        context.response.http?.headers.set(
          'X-RateLimit-Remaining',
          result.remaining.toString()
        );

        if (!result.allowed) {
          throw new RateLimitExceededError(
            'Too many GraphQL operations. Slow down.',
            result.retryAfter,
            result.remaining
          );
        }

        return {};
      },
    };
  }
}

// Factory -------------------------------------------------------------------

export interface RateLimiterFactoryOptions {
  redisClient?: Redis;
  fallbackStore?: SlidingWindowStore; // used when Redis is not provided
  config: RateLimitConfig;
  customPrefix?: string;
}

/**
 * Helper for dependency-injection & service-location.
 * Decides which backing store to use based on availability.
 */
export function createRateLimiter(
  opts: RateLimiterFactoryOptions
): RateLimiter {
  const {
    redisClient,
    fallbackStore = new MemorySlidingWindowStore(),
    config,
    customPrefix,
  } = opts;

  let store: SlidingWindowStore;

  if (redisClient) {
    store = new RedisSlidingWindowStore(redisClient, customPrefix ?? 'rl');
    logger.info('Using RedisSlidingWindowStore for rate limiting');
  } else {
    store = fallbackStore;
    logger.warn('Redis client unavailable. Falling back to in-memory store');
  }

  return new RateLimiter(config, store);
}

/**************************************************************************************************
 * Example usage (Express) ------------------------------------------------------------------------
 *
 * import express from 'express'
 * import Redis from 'ioredis'
 * import { createRateLimiter } from './module_65'
 *
 * const app = express()
 * const redis = new Redis({ host: 'redis-master.socialpulse', lazyConnect: true })
 *
 * const limiter = createRateLimiter({
 *   redisClient: redis,
 *   config: { points: 100, duration: 60 },
 * })
 *
 * app.use(
 *   limiter.expressMiddleware(req =>
 *     req.headers['x-api-key']?.toString() || req.ip
 *   )
 * )
 *
 **************************************************************************************************/

```