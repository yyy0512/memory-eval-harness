```typescript
/**************************************************************************************************
 * SocialPulse Gateway
 * File: src/module_41.ts
 *
 * AdaptiveRateLimiter — Redis-backed, token-bucket rate-limiter usable both as:
 *   1. Express middleware for REST endpoints.
 *   2. Apollo Server plugin for GraphQL operations.
 *
 * It supports per-identity throttling (user-id ⟶ fallback ip-address) and plugs into
 * the platform’s observability stack (structured logging + Prometheus metrics).
 *
 * Dependencies (installed elsewhere in the project):
 *   - express
 *   - apollo-server-plugin-base
 *   - ioredis
 *   - ms
 *   - prom-client
 *   - uuid
 *
 * NOTE: Logger (`infra/logger`) and configuration (`config`) modules are expected to exist
 *       in the project. Replace paths if different.
 **************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import {
  ApolloServerPlugin,
  GraphQLRequestContext,
} from 'apollo-server-plugin-base';
import Redis, { Redis as RedisClient } from 'ioredis';
import ms from 'ms';
import {
  Counter,
  Histogram,
  collectDefaultMetrics,
  Registry,
} from 'prom-client';
import { v4 as uuidv4 } from 'uuid';

import logger from './infra/logger';
import config from './config';

/* --------------------------------- Types --------------------------------- */

export interface RateLimiterOptions {
  redisClient?: RedisClient;      // Existing client, otherwise one will be created.
  capacity: number;               // Bucket size (max tokens).
  refillRate: number;             // Tokens added per window.
  window: string | number;        // Window size (ms or human readable e.g. '1s').
  /** Optional: name to isolate keys (e.g. per-route) */
  scope?: string;
}

/** Returned by internal token bucket evaluation */
interface BucketState {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/* ---------------------------- Metrics registry --------------------------- */

// Use a standalone registry to avoid double-collecting default metrics when this
// module is imported more than once in testing.
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const rateLimitCounter = new Counter({
  name: 'sp_rate_limiter_requests_total',
  help: 'Total requests handled by AdaptiveRateLimiter',
  labelNames: ['scope', 'outcome'] as const,
  registers: [metricsRegistry],
});

const rateLimitLatency = new Histogram({
  name: 'sp_rate_limiter_latency_ms',
  help: 'Latency of rate limiter decision',
  labelNames: ['scope'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
  registers: [metricsRegistry],
});

/* -------------------------- Helper / util fns --------------------------- */

/**
 * Resolve identity from request.
 * Prefers authenticated user id, falls back to ip address.
 */
function resolveIdentity(req: Request): string {
  // Assuming authentication layer attaches `req.user`
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (req.user && typeof (req.user as any).id === 'string') {
    return `user:${(req.user as any).id}`;
  }

  const ip =
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown';
  return `ip:${ip}`;
}

/* ---------------------------- Core RateLimiter --------------------------- */

export class AdaptiveRateLimiter {
  private readonly redis: RedisClient;
  private readonly capacity: number;
  private readonly refillRate: number;
  private readonly windowMs: number;
  private readonly scope: string;

  constructor(opts: RateLimiterOptions) {
    this.capacity = opts.capacity;
    this.refillRate = opts.refillRate;
    this.windowMs =
      typeof opts.window === 'string' ? ms(opts.window) : opts.window;
    this.scope = opts.scope ?? 'global';

    // Re-use provided client or create new one
    this.redis =
      opts.redisClient ??
      new Redis({
        /**
         * Production deployments should configure Redis via environment variables.
         * In keeping with clean architecture, low-level infra details are centralized
         * elsewhere; here we accept defaults for brevity.
         */
        lazyConnect: true, // don't attempt to connect immediately at import time
      });

    if (!opts.redisClient) {
      // Establish connection asynchronously; errors bubble up via .status
      this.redis.connect().catch((err) => {
        logger.error(
          { err, scope: this.scope },
          'AdaptiveRateLimiter failed to connect to Redis',
        );
      });
    }
  }

  /**
   * Attempt to consume a token for the given identity.
   * Returns bucket state with allowance verdict.
   */
  async consume(identity: string): Promise<BucketState> {
    const now = Date.now();
    const key = `rl:${this.scope}:${identity}`;

    /**
     * Redis Lua script ensures atomicity:
     *  1. Fetch bucket (tokens, last_refill_timestamp)
     *  2. Refill tokens based on elapsed time
     *  3. If tokens available ➜ decrement & allow
     *  4. Persist state and TTL
     *
     * KEYS[1] = bucket key
     * ARGV[1] = capacity
     * ARGV[2] = refill_rate
     * ARGV[3] = window_ms
     * ARGV[4] = now (ms)
     */
    const script = `
      local data = redis.call("HMGET", KEYS[1], "tokens", "ts")
      local tokens = tonumber(data[1]) or tonumber(ARGV[1])
      local ts = tonumber(data[2]) or ARGV[4]

      -- Refill
      local elapsed = ARGV[4] - ts
      local refillTokens = (elapsed / ARGV[3]) * tonumber(ARGV[2])
      tokens = math.min(tokens + refillTokens, tonumber(ARGV[1]))

      local allowed = 0
      if tokens >= 1 then
        tokens = tokens - 1
        allowed = 1
      end

      -- Save state
      redis.call("HMSET", KEYS[1], "tokens", tokens, "ts", ARGV[4])
      redis.call("PEXPIRE", KEYS[1], ARGV[3] * 2)  -- survive two windows

      return {allowed, tokens, ts}
    `;

    const [allowed, remaining, ts] = (await this.redis.eval(
      script,
      1,
      key,
      this.capacity,
      this.refillRate,
      this.windowMs,
      now,
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining: Math.floor(remaining),
      resetAt: ts + this.windowMs,
    };
  }

  /* -------------------------------------------------------------------- */
  /* --------------------------- HTTP Middleware ------------------------ */
  /* -------------------------------------------------------------------- */

  /**
   * Express middleware factory.
   */
  createExpressMiddleware(): (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void> {
    return async (req, res, next) => {
      const end = rateLimitLatency.startTimer({ scope: this.scope });
      const identity = resolveIdentity(req);

      try {
        const state = await this.consume(identity);

        // Attach rate-limit headers (RFC-standard fields)
        res.setHeader('X-RateLimit-Limit', this.capacity.toString());
        res.setHeader('X-RateLimit-Remaining', state.remaining.toString());
        res.setHeader('X-RateLimit-Reset', Math.ceil(state.resetAt / 1000));

        if (!state.allowed) {
          rateLimitCounter.inc({ scope: this.scope, outcome: 'rejected' });
          end();
          return res
            .status(429)
            .json({ message: 'Too many requests', retryAt: state.resetAt });
        }

        rateLimitCounter.inc({ scope: this.scope, outcome: 'allowed' });
        end();
        return next();
      } catch (err) {
        // Fail-open: log but allow traffic to avoid availability impact.
        logger.error(
          { err, identity, scope: this.scope },
          'Rate limiter error – falling back to allow',
        );
        end();
        return next();
      }
    };
  }

  /* -------------------------------------------------------------------- */
  /* ------------------------ GraphQL Plug-in --------------------------- */
  /* -------------------------------------------------------------------- */

  /**
   * Apollo Server plugin factory.
   */
  createGraphQLPlugin(): ApolloServerPlugin {
    return {
      async requestDidStart() {
        // plugin instance state
        return {
          async didResolveOperation(requestContext: GraphQLRequestContext) {
            const end = rateLimitLatency.startTimer({ scope: this.scope });
            const identity =
              (requestContext.context as any)?.user?.id
                ? `user:${(requestContext.context as any).user.id}`
                : `ip:${
                    requestContext.request.http?.headers.get('x-forwarded-for') ??
                    requestContext.request.http?.headers.get('x-real-ip') ??
                    'unknown'
                  }`;

            try {
              const state = await (async () => this.consume(identity))();

              // Add response extensions so clients can introspect
              (requestContext.response as any).extensions = {
                ...(requestContext.response?.extensions ?? {}),
                rateLimit: {
                  limit: this.capacity,
                  remaining: state.remaining,
                  resetAt: state.resetAt,
                },
              };

              if (!state.allowed) {
                rateLimitCounter.inc({ scope: this.scope, outcome: 'rejected' });
                end();
                throw new Error('Too many requests');
              }

              rateLimitCounter.inc({ scope: this.scope, outcome: 'allowed' });
              end();
            } catch (err) {
              if (err.message === 'Too many requests') {
                // surface GraphQL-friendly error
                throw err;
              }
              logger.error(
                { err, identity, scope: this.scope },
                'Rate limiter error – allowing GraphQL operation',
              );
              end();
            }
          },
        };
      }.bind(this),
    };
  }

  /* -------------------------------------------------------------------- */
  /* --------------------------- Health Probe --------------------------- */
  /* -------------------------------------------------------------------- */

  /**
   * Liveness check (verifies Redis connectivity).
   */
  async livenessProbe(): Promise<boolean> {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Expose Prometheus metrics scraper.
   */
  async metrics(): Promise<string> {
    return metricsRegistry.metrics();
  }

  /* -------------------------------------------------------------------- */
  /* ----------------------------- Cleanup ------------------------------ */
  /* -------------------------------------------------------------------- */

  /**
   * Gracefully close Redis connection when gateway shuts down.
   */
  async shutdown(): Promise<void> {
    try {
      await this.redis.quit();
      logger.info({ scope: this.scope }, 'AdaptiveRateLimiter shutdown');
    } catch (err) {
      logger.warn({ err, scope: this.scope }, 'Error during shutdown');
    }
  }
}

/* ------------------------------------------------------------------------ */
/* ----------------------------- Factory API ------------------------------ */
/* ------------------------------------------------------------------------ */

/**
 * Gateway-wide default limiter.
 *
 * Example usage (Express):
 *   import express from 'express';
 *   import { defaultRateLimiter } from './module_41';
 *
 *   const app = express();
 *   app.use(defaultRateLimiter.createExpressMiddleware());
 *
 * Example usage (Apollo):
 *   const server = new ApolloServer({
 *     schema,
 *     plugins: [defaultRateLimiter.createGraphQLPlugin()],
 *   });
 */
export const defaultRateLimiter = new AdaptiveRateLimiter({
  capacity: config.rateLimit.capacity ?? 60,
  refillRate: config.rateLimit.refill ?? 60,
  window: config.rateLimit.window ?? '1m',
  scope: 'default',
  redisClient: undefined,
});

/* Convenience middleware exports */
export const rateLimitMiddleware = defaultRateLimiter.createExpressMiddleware();
export const rateLimitPlugin = defaultRateLimiter.createGraphQLPlugin();
```