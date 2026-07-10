```typescript
// File: src/module_30.ts
// Description: Production-grade sliding-window rate-limiter with Redis–Lua atomicity.
//              Provides Express middleware and Apollo GraphQL plugin factories.
//
// NOTE: This file purposefully avoids concrete application wiring. Instead, it
//       exposes composable building-blocks that can be consumed by presentation
//       layers (REST controllers / GraphQL resolvers) while respecting
//       Clean Architecture boundaries.
//
// External deps (declare in package.json):
//   "ioredis": "^5",
//   "express": "^4",
//   "@apollo/server": "^4",
//   "http-errors": "^2",
//   "undici": "^5" (polyfill for fetch if Node < 18, optional)

import type { NextFunction, Request, Response } from 'express';
import { ApolloServerPlugin, GraphQLRequestContext } from '@apollo/server';
import Redis from 'ioredis';
import createError from 'http-errors';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/**
 * Shape of the limiter configuration.
 */
export interface RateLimitConfig {
  /**
   * Runnable Lua script for Redis. Default is a sliding-window implementation.
   */
  luaScript?: string;

  /**
   * Sliding-window (in seconds).
   */
  window: number;

  /**
   * Allowed requests inside the window.
   */
  maxRequests: number;

  /**
   * Prefix to namespace all Redis keys (multi-tenant support).
   */
  keyPrefix?: string;

  /**
   * Whether to attach rate-limit headers to HTTP responses.
   */
  exposeHeaders?: boolean;

  /**
   * Optionally pass a logger that respects pino-like interface.
   */
  logger?: { debug: (msg: string, meta?: unknown) => void; warn: typeof console.warn };
}

export interface ExpressRateLimitOptions extends RateLimitConfig {
  /**
   * Extract key (user ID, IP, session, etc.) from the HTTP request.
   */
  keyFn(req: Request): string | undefined;
}

export interface GraphQLRateLimitOptions extends RateLimitConfig {
  /**
   * Extract key (user ID, session) from GraphQL context.
   */
  keyFn<Ctx>(ctx: Ctx): string | undefined;
}

/* -------------------------------------------------------------------------- */
/*                              Lua script (EVAL)                             */
/* -------------------------------------------------------------------------- */
// Defaults to a high-performance sliding-window counter. Using Redis sorted sets
// instead of INCR w/ expiry to mitigate burst attacks & support millisecond
// accuracy. Complexity: O(log N) thanks to ZREMRANGEBYSCORE.
//
// KEYS[1] = <rate-limit-key>
// ARGV[1] = window (ms)
// ARGV[2] = now (ms)
// ARGV[3] = limit (int)
// Returns an array: { allowed, ttl(ms), currentCount }
const DEFAULT_LUA = `
  local key     = KEYS[1]
  local window  = tonumber(ARGV[1])
  local now     = tonumber(ARGV[2])
  local limit   = tonumber(ARGV[3])

  -- purge expired
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

  -- add current hit
  redis.call('ZADD', key, now, now)

  -- current count
  local count = redis.call('ZCARD', key)

  -- set TTL for cleanup if not set
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    redis.call('PEXPIRE', key, window)
    ttl = window
  end

  local allowed = 0
  if count <= limit then
    allowed = 1
  end

  return { allowed, ttl, count }
`;

/* -------------------------------------------------------------------------- */
/*                          SlidingWindowRateLimiter                          */
/* -------------------------------------------------------------------------- */

export class SlidingWindowRateLimiter {
  private readonly redis: Redis;
  private readonly scriptSha: string | null = null;
  private readonly cfg: RateLimitConfig;

  constructor(redis: Redis, cfg: RateLimitConfig) {
    this.redis = redis;
    this.cfg = {
      keyPrefix: 'sr',
      exposeHeaders: true,
      ...cfg,
      luaScript: cfg.luaScript ?? DEFAULT_LUA,
    };

    // Pre-load Lua for EVALSHA to reduce latency.
    this.preloadLua()
      .then((sha) => {
        if (this.cfg.logger) this.cfg.logger.debug('Rate-limit Lua pre-loaded', { sha });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.scriptSha = sha;
      })
      .catch((err) => {
        if (this.cfg.logger) this.cfg.logger.warn('Failed to preload Lua: ' + err);
      });
  }

  /* ---------------------------------------------------------------------- */
  /*                              Public API                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Express middleware factory.
   */
  express(options: ExpressRateLimitOptions) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const identifier = options.keyFn(req);
        if (!identifier) return next(); // Skip if key not resolvable.

        const { allowed, retryAfter, limit, remaining } =
          await this.consume(identifier, options);

        /* Attach headers for better client experience. */
        if (options.exposeHeaders ?? true) {
          res.setHeader('X-RateLimit-Limit', limit.toString());
          res.setHeader('X-RateLimit-Remaining', remaining.toString());
          res.setHeader('X-RateLimit-Reset', retryAfter.toString());
        }

        if (!allowed) {
          // HTTP 429 Too Many Requests
          return next(
            createError(429, 'Rate limit exceeded', {
              headers: {
                'Retry-After': Math.ceil(retryAfter / 1000),
              },
            }),
          );
        }

        return next();
      } catch (err) {
        return next(err);
      }
    };
  }

  /**
   * Apollo GraphQL plugin factory.
   *
   * Usage:
   * new ApolloServer({
   *    plugins: [limiter.graphql({ ...opts })]
   * })
   */
  graphql<Ctx = Record<string, unknown>>(
    options: GraphQLRateLimitOptions,
  ): ApolloServerPlugin<Ctx> {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    return {
      async requestDidStart() {
        return {
          async didResolveOperation(ctx: GraphQLRequestContext<Ctx>) {
            const identifier = options.keyFn(ctx.contextValue);
            if (!identifier) return;

            const { allowed, retryAfter } = await (async () =>
              this.consume(identifier, options))();

            if (!allowed) {
              throw createError(
                429,
                'Rate limit exceeded',
                // GraphQL spec mandates "extensions.code" for custom errors.
                { extensions: { code: 'RATE_LIMITED', retryAfterMs: retryAfter } },
              );
            }
          }.bind(this),
        };
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /*                              Internals                                 */
  /* ---------------------------------------------------------------------- */

  private async preloadLua(): Promise<string> {
    return this.redis.script('LOAD', this.cfg.luaScript!);
  }

  private tokenKey(identifier: string): string {
    return `${this.cfg.keyPrefix}:${identifier}`;
  }

  /**
   * Atomically consume one point from the bucket.
   */
  private async consume(
    identifier: string,
    localCfg: Pick<RateLimitConfig, 'window' | 'maxRequests' | 'exposeHeaders' | 'logger'>,
  ): Promise<{
    allowed: boolean;
    retryAfter: number;
    remaining: number;
    limit: number;
  }> {
    const nowMs = Date.now();
    const key = this.tokenKey(identifier);
    const args = [
      // KEYS[1]
      key,
      // ARGV
      localCfg.window * 1000,
      nowMs,
      localCfg.maxRequests,
    ];

    // Use EVALSHA if pre-loaded, fallback EVAL on NO SCRIPT error.
    let result: [number, number, number];
    try {
      // @ts-ignore – Redis typings can't infer dynamic arg length.
      result = (await this.redis.evalsha(
        this.scriptSha,
        1,
        ...args,
      )) as [number, number, number];
    } catch (err: unknown) {
      if (
        typeof err === 'object' &&
        err !== null &&
        // @ts-ignore
        err.message?.includes?.('NOSCRIPT')
      ) {
        // Fallback to full EVAL once – prevents replication of script multiple times.
        // @ts-ignore
        result = (await this.redis.eval(this.cfg.luaScript!, 1, ...args)) as [
          number,
          number,
          number,
        ];
      } else {
        throw err;
      }
    }

    const [allowedInt, ttlMs, current] = result;
    const allowed = allowedInt === 1;
    const remaining = Math.max(localCfg.maxRequests - current, 0);

    // Retry-After header uses seconds granularity per RFC-spec.
    const retryAfter = allowed ? 0 : ttlMs;

    return { allowed, retryAfter, remaining, limit: localCfg.maxRequests };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Helper Exports                                */
/* -------------------------------------------------------------------------- */

export const defaultLimiter = (redis: Redis): SlidingWindowRateLimiter =>
  new SlidingWindowRateLimiter(redis, {
    window: 60,
    maxRequests: 120,
    keyPrefix: 'sr',
    exposeHeaders: true,
  });

/**
 * Example usage (Express):
 *
 * import express from 'express';
 * import Redis from 'ioredis';
 * import { defaultLimiter } from './module_30';
 *
 * const app = express();
 * const redis = new Redis(process.env.REDIS_URL);
 *
 * app.use(
 *   defaultLimiter(redis).express({
 *     window: 10,
 *     maxRequests: 20,
 *     keyFn: (req) => req.ip,
 *   }),
 * );
 *
 * Example usage (Apollo):
 *
 * const server = new ApolloServer({
 *   typeDefs,
 *   resolvers,
 *   plugins: [
 *     defaultLimiter(redis).graphql({
 *       window: 60,
 *       maxRequests: 100,
 *       keyFn: (ctx) => ctx.user?.id,
 *     }),
 *   ],
 * });
 */
```