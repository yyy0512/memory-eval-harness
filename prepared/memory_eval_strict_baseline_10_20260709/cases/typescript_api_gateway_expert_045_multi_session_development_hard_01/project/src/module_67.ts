```typescript
/* ===========================================================================
 * File: module_67.ts
 * Project: SocialPulse Gateway  (api_gateway)
 * Description:
 *   Cross-cutting rate-limit facilities shared by both REST (Express) and
 *   GraphQL (Apollo) entry-points.  Implements a sliding-window counter on top
 *   of Redis and exposes:
 *
 *     1.  Express middleware     → rateLimitExpress(…)
 *     2.  Apollo plugin          → rateLimitApollo(…)
 *
 *   The module keeps the public surface minimal while remaining highly
 *   configurable and testable.  Persistence is delegated to Redis; callers
 *   provide a fully-configured ioredis client—maintaining clean_architecture
 *   “infrastructure-as-dependency” principles.
 * ---------------------------------------------------------------------------
 * NOTE:
 *   Do not import this module from domain / application layers  ► violates
 *   dependency-rule.  It is meant for the presentation & infrastructure
 *   boundaries only.
 * ==========================================================================*/

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { GraphQLRequestContext, GraphQLRequestListener } from 'apollo-server-plugin-base';
import { ApolloError } from 'apollo-server-errors';
import { IncomingHttpHeaders } from 'http';
import pino, { Logger } from 'pino';

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration & Types
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Sliding-window rate-limit configuration.
 *
 * points    : maximum number of requests
 * windowSec : per X seconds (time-window)
 * keyPrefix : redis key namespace
 * identify  : function used to extract a stable identity from the request
 * logger    : optional pino instance; will fall back to a noop logger
 */
export interface RateLimiterConfig {
  points: number;
  windowSec: number;
  keyPrefix?: string;
  identify?: (headers: IncomingHttpHeaders) => string | null;
  logger?: Logger;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ────────────────────────────────────────────────────────────────────────── */

/** Express-ready error type */
export class RateLimitExceededError extends Error {
  public readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** GraphQL-ready error type (maps to HTTP 429) */
export class GraphQLRateLimitError extends ApolloError {
  constructor(message: string, retryAfterSec: number) {
    super(message, 'RATE_LIMIT_EXCEEDED', { retryAfterSec });
    Object.defineProperty(this, 'name', { value: 'GraphQLRateLimitError' });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Internal helper
 * ────────────────────────────────────────────────────────────────────────── */

const DEFAULT_KEY_PREFIX = 'sp:rl';
const DEFAULT_IDENT = (headers: IncomingHttpHeaders): string | null =>
  (headers['x-user-id'] as string) || (headers['x-forwarded-for'] as string) || null;

/**
 * Compose the redis key used for storing the sliding window counter.
 */
function buildKey(prefix: string, fingerprint: string): string {
  return `${prefix}:${fingerprint}`;
}

/**
 * Perform the rate-limit check against Redis using a sliding-window counter.
 *
 * Relying on Redis atomicity of INCR + EXPIRE in a MULTI/EXEC block guarantees
 * no race conditions for a single key.
 *
 * Returns:  [allowed, remaining, ttl]
 */
async function hitLimit(
  redis: Redis,
  key: string,
  { points, windowSec }: Pick<RateLimiterConfig, 'points' | 'windowSec'>
): Promise<{ allowed: boolean; remaining: number; ttl: number }> {
  const now = Math.floor(Date.now() / 1000);

  const [[, current], [, ttl]] = await redis
    .multi()
    .incr(key)
    .ttl(key)
    .exec();

  if (current === 1 || ttl === -1) {
    // First hit in window; expire after windowSec
    await redis.expire(key, windowSec);
  }

  const remaining = Math.max(points - current, 0);
  const allowed = current <= points;

  return {
    allowed,
    remaining,
    ttl: await redis.ttl(key).then((t) => (t < 0 ? windowSec : t)),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Factory
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Create an object holding both REST and GraphQL integrations.
 *
 * Example:
 *   const limiter = createRateLimiter(redis, { points: 60, windowSec: 60 })
 *   app.use(limiter.rateLimitExpress);
 *   const server = new ApolloServer({ …, plugins: [limiter.rateLimitApollo] });
 */
export function createRateLimiter(redis: Redis, cfg: RateLimiterConfig) {
  const {
    points,
    windowSec,
    keyPrefix = DEFAULT_KEY_PREFIX,
    identify = DEFAULT_IDENT,
    logger = pino({ level: 'warn', name: 'rate-limiter' }),
  } = cfg;

  /* ─────────────────────────────────────
   * 1. Express middleware
   * ──────────────────────────────────── */
  async function rateLimitExpress(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const fingerprint = identify(req.headers);

      // Anonymous clients (no stable id) are still throttled per IP
      const key = buildKey(keyPrefix, fingerprint ?? req.ip);

      const { allowed, remaining, ttl } = await hitLimit(redis, key, { points, windowSec });

      res.setHeader('X-RateLimit-Limit', points.toString());
      res.setHeader('X-RateLimit-Remaining', remaining.toString());
      res.setHeader('X-RateLimit-Reset', ttl.toString());

      if (!allowed) {
        logger.warn({ key, remaining }, 'Rate limit exceeded');
        throw new RateLimitExceededError('Too many requests', ttl);
      }

      next();
    } catch (err) {
      next(err);
    }
  }

  /* ─────────────────────────────────────
   * 2. Apollo plugin
   * ──────────────────────────────────── */
  const rateLimitApollo = (): GraphQLRequestListener => {
    return {
      async didResolveOperation(
        requestContext: GraphQLRequestContext
      ): Promise<void> {
        const { request, context } = requestContext;
        // Apollo adds `req` for Express integration, otherwise use headers
        const headers: IncomingHttpHeaders =
          (context?.req?.headers as IncomingHttpHeaders) ??
          (request?.http?.headers?.raw() as unknown as IncomingHttpHeaders) ??
          {};

        const fingerprint = identify(headers);
        const key = buildKey(keyPrefix, fingerprint ?? headers['x-forwarded-for'] ?? 'anon');

        const { allowed, remaining, ttl } = await hitLimit(redis, key, { points, windowSec });

        requestContext.response?.http?.headers.set('X-RateLimit-Limit', points.toString());
        requestContext.response?.http?.headers.set('X-RateLimit-Remaining', remaining.toString());
        requestContext.response?.http?.headers.set('X-RateLimit-Reset', ttl.toString());

        if (!allowed) {
          logger.warn({ key, remaining }, 'GraphQL rate limit exceeded');
          throw new GraphQLRateLimitError('Too many requests', ttl);
        }
      },
    };
  };

  /* ─────────────────────────────────────
   * Public surface
   * ──────────────────────────────────── */
  return {
    rateLimitExpress,
    rateLimitApollo,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Example error-handling boilerplate (Express)
 * ────────────────────────────────────────────────────────────────────────── */

/* eslint-disable @typescript-eslint/no-unused-vars */
export function expressErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof RateLimitExceededError) {
    res.setHeader('Retry-After', err.retryAfterSec.toString());
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: err.message,
      retryAfter: err.retryAfterSec,
    });
    return;
  }

  // Pass through any non rate-limit errors
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
}
/* eslint-enable @typescript-eslint/no-unused-vars */
```