```typescript
/***************************************************************************************************
 * File:        src/module_37.ts
 * Project:     SocialPulse Gateway (api_gateway)
 *
 * Description:
 * -------------
 * Centralised, production-grade rate-limiting utilities used by both REST controllers and
 * GraphQL resolvers.  Built on top of Redis and designed to be horizontally scalable, the
 * implementation supports the classic fixed-window counter strategy but can be swapped for
 * more sophisticated algorithms (token-bucket, sliding-window) without affecting call-sites.
 *
 * Clean-architecture wise the module lives in the “infrastructure” ring: it talks to Redis,
 * emits structured logs, and exposes a domain-agnostic façade consumed by presentation
 * layers (HTTP middleware, GraphQL directives, WebSocket gatekeepers, …).
 *
 * Key Features
 * ------------
 * • Asynchronous, atomic operations via Lua scripting: no race-conditions under high load.
 * • Namespaced metrics (remaining, resetAt) returned with every decision.
 * • Pluggable identity extractor: user-id, API-key, IP address, etc.
 * • Zero external state: configuration is provided through RateLimitConfig objects.
 * • First-class TypeScript types & exhaustive error handling.
 *
 * Usage
 * -----
 * const limiter = new RedisRateLimiter({ redisUrl: process.env.REDIS_URL });
 * app.use(buildRateLimitMiddleware(limiter, { windowSec: 60, max: 120 }));
 ***************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import IORedis, { Redis } from 'ioredis';

/* -------------------------------------------------------------------------------------------------
 * Logger
 * -------------------------------------------------------------------------------------------------*/
const log = pino({
  name: 'rate-limiter',
  level: process.env.LOG_LEVEL ?? 'info',
});

/* -------------------------------------------------------------------------------------------------
 * Error types
 * -------------------------------------------------------------------------------------------------*/
/**
 * Thrown when a request exceeds the configured rate-limit.
 * The error is presentation independent—controllers can translate it to HTTP 429,
 * GraphQL errors, WebSocket close codes, etc.
 */
export class RateLimitExceededError extends Error {
  readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSec = retryAfterSec;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Types & Interfaces
 * -------------------------------------------------------------------------------------------------*/
/**
 * Low-level configuration describing a single limit.
 */
export interface RateLimitConfig {
  /** Time window in seconds (e.g. 60 for 1 minute). */
  readonly windowSec: number;
  /** Maximum number of allowed requests in that window. */
  readonly max: number;
}

/**
 * Result from a limiting decision.
 */
export interface RateLimitDecision {
  allowed: boolean;          // Whether the caller can proceed.
  remaining: number;         // Tokens left in the current window.
  resetAt: number;           // Epoch-seconds timestamp when the window resets.
}

/**
 * Abstract contract for rate-limiter implementations.
 */
export interface IRateLimiter {
  consume(identity: string, config: RateLimitConfig): Promise<RateLimitDecision>;
}

/* -------------------------------------------------------------------------------------------------
 * Redis implementation
 * -------------------------------------------------------------------------------------------------*/

/** Internal namespacing helper for Redis keys to avoid collisions. */
const keyFor = (identity: string, windowSec: number): string =>
  `spg:rl:${identity}:${windowSec}`;

/**
 * Lua script executed atomically on Redis.
 *
 * KEYS[1] -> counter key
 * ARGV[1] -> window (seconds)
 * ARGV[2] -> max
 * Returns: { counter, ttl }
 *
 * Behaviour:
 *  1. Increment the counter (initialises to 1).
 *  2. Set the key’s expiry to `window` seconds if it is new.
 *  3. Return the counter and remaining TTL.
 */
const LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { current, ttl }
`;

/**
 * Redis-backed, fixed-window rate-limiter.
 */
export class RedisRateLimiter implements IRateLimiter {
  private redis: Redis;

  constructor(opts: { redisUrl: string }) {
    this.redis = new IORedis(opts.redisUrl, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
    });

    this.redis.on('error', (err) => log.error({ err }, 'Redis connection error'));
    this.redis.on('connect', () => log.debug('Redis connected (rate-limiter)'));
  }

  /**
   * Performs a rate-limit check for the given identity.
   *
   * Complexity: O(1), atomic.
   */
  async consume(identity: string, config: RateLimitConfig): Promise<RateLimitDecision> {
    const { windowSec, max } = config;
    const redisKey = keyFor(identity, windowSec);

    const [counter, ttl] = (await this.redis.eval(
      LUA_SCRIPT,
      1,
      redisKey,
      windowSec,
      max,
    )) as [number, number];

    const allowed = counter <= max;
    const remaining = allowed ? max - counter : 0;
    const resetAt = Math.floor(Date.now() / 1000) + (ttl >= 0 ? ttl : windowSec);

    log.debug(
      {
        identity,
        counter,
        max,
        remaining,
        ttl,
        allowed,
      },
      'Rate limit check',
    );

    return { allowed, remaining, resetAt };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Express middleware builder
 * -------------------------------------------------------------------------------------------------*/

export interface IdentityExtractor {
  (req: Request): string;
}

const defaultIdentityExtractor: IdentityExtractor = (req) =>
  // Prefer authenticated user id; fallback to IP.
  req.user?.id?.toString() ?? req.ip;

/**
 * Factory that returns an Express middleware enforcing rate-limits.
 */
export function buildRateLimitMiddleware(
  limiter: IRateLimiter,
  config: RateLimitConfig,
  extractor: IdentityExtractor = defaultIdentityExtractor,
) {
  if (!limiter) {
    throw new Error('RateLimiter instance must be provided');
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const identity = extractor(req);
      const decision = await limiter.consume(identity, config);

      // Expose rate-limit headers (RFC-draft).
      res.setHeader('X-RateLimit-Limit', config.max.toString());
      res.setHeader('X-RateLimit-Remaining', decision.remaining.toString());
      res.setHeader('X-RateLimit-Reset', decision.resetAt.toString());

      if (!decision.allowed) {
        throw new RateLimitExceededError(
          `Rate-limit exceeded (allowed ${config.max} requests per ${config.windowSec}s)`,
          decision.resetAt - Math.floor(Date.now() / 1000),
        );
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        res.setHeader('Retry-After', err.retryAfterSec.toString());
        res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: err.message,
          retryAfterSec: err.retryAfterSec,
        });
        return;
      }

      // Unexpected error – delegate to global error handler.
      next(err as Error);
    }
  };
}

/* -------------------------------------------------------------------------------------------------
 * GraphQL directive (optional)
 * -------------------------------------------------------------------------------------------------*/
/**
 * Simple wrapper to reuse the limiter in Apollo Server via schema-level directives.
 *
 * Usage in schema.graphql:
 *
 *  directive @rateLimit(windowSec: Int!, max: Int!) on FIELD_DEFINITION
 *
 * Add to Apollo Server plugin chain:
 *  import { rateLimitDirective } from './module_37';
 *  server.addPlugin(rateLimitDirective(limiter));
 */
import {
  defaultFieldResolver,
  GraphQLField,
  GraphQLSchema,
} from 'graphql';
import { mapSchema, MapperKind, getDirective } from '@graphql-tools/utils';

export function rateLimitDirective(limiter: IRateLimiter) {
  return {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    visitSchema(schema: GraphQLSchema) {
      return mapSchema(schema, {
        [MapperKind.OBJECT_FIELD]: (fieldConfig: GraphQLField<unknown, unknown>) => {
          const directive = getDirective(schema, fieldConfig, 'rateLimit')?.[0];
          if (!directive) return fieldConfig;

          const { windowSec, max } = directive as { windowSec: number; max: number };
          const originalResolver = fieldConfig.resolve ?? defaultFieldResolver;

          fieldConfig.resolve = async function (source, args, context, info) {
            // Derive identity from context (e.g., JWT sub or IP)
            const identity: string = context.user?.id ?? context.ip;
            const decision = await limiter.consume(identity, { windowSec, max });

            if (!decision.allowed) {
              throw new RateLimitExceededError(
                `Too many requests (allowed ${max} per ${windowSec}s)`,
                decision.resetAt - Math.floor(Date.now() / 1000),
              );
            }

            // eslint-disable-next-line @typescript-eslint/return-await
            return originalResolver.call(this, source, args, context, info);
          };

          return fieldConfig;
        },
      });
    },
  };
}
```
