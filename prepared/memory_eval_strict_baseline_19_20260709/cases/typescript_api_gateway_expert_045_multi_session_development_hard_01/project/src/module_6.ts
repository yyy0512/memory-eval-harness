```typescript
/***************************************************************************************************
 * File:        src/module_6.ts
 * Project:     SocialPulse Gateway (api_gateway)
 * Description: Unified Rate-Limiter (REST middleware + GraphQL plugin) backed by Redis.
 * -------------------------------------------------------------------------------------------------
 * The module implements a sliding-window rate-limiter that can be plugged into both the Express
 * (REST) stack and ApolloServer (GraphQL) stack.  Limits are enforced per-consumer (identified by
 * either an authenticated userId or an apiKey) and can be version-scoped so that a new API version
 * can ship with more generous limits while leaving the current version unchanged.
 *
 * Design goals:
 *   – Strict time-window enforcement using Redis atomic operations.
 *   – Graceful degradation (fail-open) when Redis is down, but with structured logging.
 *   – Can be configured per route and/or per GraphQL operation.
 *   – Provides both an Express middleware factory and an Apollo GraphQL plugin.
 *
 * Usage (REST):
 *   app.get(
 *     '/v1/timeline',
 *     rateLimiter({
 *       windowMs: 60_000,        // 1 minute window
 *       maxRequests: 120,        // allow 120 req/min
 *     }),
 *     timelineController,
 *   );
 *
 * Usage (GraphQL):
 *   const server = new ApolloServer({
 *     schema,
 *     plugins: [
 *       rateLimiterGraphQLPlugin({
 *         windowMs: 30_000,
 *         maxRequests: 60,
 *       }),
 *     ],
 *   });
 ***************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import Redis, { RedisOptions } from 'ioredis';
import {
  GraphQLRequestContext,
  GraphQLRequestListener,
  ApolloServerPlugin,
} from 'apollo-server-plugin-base';

import createHttpError from 'http-errors';

// Placeholder for the project-level logger abstraction.
// Replace with your concrete logger implementation.
import { logger } from './infrastructure/logger';

// ---------------------------------------------------------------------------------------------------------------------
// Configuration interfaces
// ---------------------------------------------------------------------------------------------------------------------

export interface RateLimiterOptions {
  /**
   * Time window size in milliseconds.
   */
  windowMs: number;

  /**
   * Maximum allowed requests within the window.
   */
  maxRequests: number;

  /**
   * If true, apply the same bucket for all endpoints; if false, scope the key to each route/path.
   */
  global?: boolean;

  /**
   * Api version the request is hitting; if undefined, 'v1' is assumed.  Included in the Redis key
   * so that each version has isolated limits.
   */
  apiVersion?: string;
}

export interface RateLimiterFactoryOptions extends RateLimiterOptions {
  /**
   * Optional override for Redis connection settings.
   */
  redisOptions?: RedisOptions;

  /**
   * Optional pre-existing Redis client.  If provided the module will not create its own.
   */
  redisClient?: Redis;
}

// ---------------------------------------------------------------------------------------------------------------------
// Redis helper – singleton pattern to avoid multiple pooled connections
// ---------------------------------------------------------------------------------------------------------------------

class RedisSingleton {
  private static _instance: Redis;
  static getInstance(opts?: RedisOptions): Redis {
    if (!RedisSingleton._instance) {
      RedisSingleton._instance = new Redis(opts);
      // basic connection diagnostics
      RedisSingleton._instance.on('error', (err) =>
        logger.error('Redis connection error inside RateLimiter', { err }),
      );
    }
    return RedisSingleton._instance;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Key builder – ensures deterministic bucket identities
// ---------------------------------------------------------------------------------------------------------------------

const buildRedisKey = (
  identifier: string,
  route: string,
  options: RateLimiterOptions,
): string => {
  const version = options.apiVersion ?? 'v1';
  const scope = options.global ? 'global' : route;
  return `spg:ratelimit:${version}:${scope}:${identifier}`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Core algorithm – sliding-window counter
// ---------------------------------------------------------------------------------------------------------------------

interface RateLimitState {
  current: number;
  remaining: number;
  reset: number; // unix epoch millis when the window expires
}

async function consumeToken(
  redis: Redis,
  key: string,
  windowMs: number,
): Promise<RateLimitState> {
  // Use MULTI/EXEC for atomicity.
  const now = Date.now();
  const expireSeconds = Math.ceil(windowMs / 1000);

  const [[count], [ttl]] = await redis
    .multi()
    .incr(key)
    .ttl(key)
    .exec() as [[null, number], [null, number]];

  // If this was the first increment or key had expired, set new TTL.
  if (ttl === -1) {
    await redis.expire(key, expireSeconds);
  }

  const newTtl = ttl !== -1 ? ttl : expireSeconds;
  return {
    current: count,
    remaining: Math.max(0, expireSeconds - count), // we will clamp later
    reset: now + newTtl * 1000,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------------------------------------------------

export const rateLimiter =
  (factoryOpts: RateLimiterFactoryOptions) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const {
      windowMs,
      maxRequests,
      global,
      apiVersion,
      redisClient,
      redisOptions,
    } = factoryOpts;

    const redis = redisClient ?? RedisSingleton.getInstance(redisOptions);

    // Identifier extraction strategy (prefer authenticated user, fallback to API key, then IP)
    const identifier =
      (req as any).user?.id ||
      req.header('x-api-key') ||
      req.ip ||
      'anonymous';

    const routeKey = req.route?.path ?? req.path;

    const redisKey = buildRedisKey(identifier, routeKey, {
      windowMs,
      maxRequests,
      global,
      apiVersion,
    });

    let state: RateLimitState;

    try {
      state = await consumeToken(redis, redisKey, windowMs);
    } catch (e) {
      // Fail-open if Redis is unavailable, but log an error
      logger.error('RateLimiter failed to contact Redis, allowing request', {
        error: e,
      });
      return next();
    }

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader(
      'X-RateLimit-Remaining',
      Math.max(0, maxRequests - state.current).toString(),
    );
    res.setHeader('X-RateLimit-Reset', Math.floor(state.reset / 1000).toString());

    if (state.current > maxRequests) {
      const retryAfterSec = Math.ceil((state.reset - Date.now()) / 1000);
      res.setHeader('Retry-After', retryAfterSec.toString());
      return next(
        new createHttpError.TooManyRequests(
          `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        ),
      );
    }

    return next();
  };

// ---------------------------------------------------------------------------------------------------------------------
// Apollo GraphQL plugin factory
// ---------------------------------------------------------------------------------------------------------------------

export const rateLimiterGraphQLPlugin = (
  factoryOpts: RateLimiterFactoryOptions,
): ApolloServerPlugin => {
  const {
    windowMs,
    maxRequests,
    global,
    apiVersion,
    redisClient,
    redisOptions,
  } = factoryOpts;

  const redis = redisClient ?? RedisSingleton.getInstance(redisOptions);

  const plugin: ApolloServerPlugin = {
    async requestDidStart(): Promise<GraphQLRequestListener> {
      return {
        async didResolveOperation(ctx: GraphQLRequestContext) {
          const http = ctx.request.http!;
          const identifier =
            (ctx.context as any).user?.id ||
            http?.headers.get('x-api-key') ||
            http?.headers.get('x-forwarded-for') ||
            'anonymous';

          const operationName =
            ctx.operationName ??
            (ctx.request.operationName ?? 'anonymous_operation');

          const redisKey = buildRedisKey(identifier, operationName, {
            windowMs,
            maxRequests,
            global,
            apiVersion,
          });

          let state: RateLimitState;
          try {
            state = await consumeToken(redis, redisKey, windowMs);
          } catch (e) {
            // Fail-open
            logger.error(
              'RateLimiter (GraphQL) failed to contact Redis, allowing request',
              { error: e },
            );
            return;
          }

          ctx.response.http!.headers.set('X-RateLimit-Limit', maxRequests.toString());
          ctx.response
            .http!.headers.set(
              'X-RateLimit-Remaining',
              Math.max(0, maxRequests - state.current).toString(),
            );
          ctx.response
            .http!.headers.set(
              'X-RateLimit-Reset',
              Math.floor(state.reset / 1000).toString(),
            );

          if (state.current > maxRequests) {
            const retryAfterSec = Math.ceil((state.reset - Date.now()) / 1000);
            ctx.response
              .http!.headers.set('Retry-After', retryAfterSec.toString());
            throw new createHttpError.TooManyRequests(
              `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
            );
          }
        },
      };
    },
  };

  return plugin;
};

// ---------------------------------------------------------------------------------------------------------------------
// Convenience builder for tests or programmatic use
// ---------------------------------------------------------------------------------------------------------------------

export class RateLimiter {
  private readonly redis: Redis;
  private readonly options: RateLimiterOptions;

  constructor(opts: RateLimiterFactoryOptions) {
    const { redisClient, redisOptions, ...rateOpts } = opts;
    this.redis = redisClient ?? RedisSingleton.getInstance(redisOptions);
    this.options = rateOpts;
  }

  public async check(
    identifier: string,
    scope: string = 'global',
  ): Promise<RateLimitState & { allowed: boolean }> {
    const key = buildRedisKey(identifier, scope, this.options);
    const state = await consumeToken(
      this.redis,
      key,
      this.options.windowMs,
    );
    return {
      ...state,
      allowed: state.current <= this.options.maxRequests,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Type re-exports for downstream code
// ---------------------------------------------------------------------------------------------------------------------

export type { RateLimitState };
```