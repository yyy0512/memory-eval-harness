```typescript
/***************************************************************************************************
 * SocialPulse Gateway – Distributed Rate-Limiter
 *
 *  Location : src/module_8.ts
 *  Purpose  : Edge-side, distributed rate-limiter that can be used by both REST controllers and
 *             GraphQL resolvers/directives.  Implements a token-bucket algorithm on top of Redis
 *             using a single, atomic Lua script to guarantee consistency across multiple gateway
 *             instances (horizontal scaling).
 *
 *  Usage (REST)
 *  ------------
 *      app.use(
 *        createRateLimitMiddleware({
 *          points: 60,            // 60 requests
 *          durationSec: 60,       // …per minute
 *          keyExtractor: (req) => req.user?.id ?? req.ip,
 *        }),
 *      );
 *
 *  Usage (GraphQL)
 *  ---------------
 *      const schema = makeExecutableSchema({
 *        typeDefs,
 *        resolvers,
 *        schemaDirectives: { rateLimit: RateLimitDirective },
 *      });
 *
 ***************************************************************************************************/

import type { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';
import ms from 'ms';
import { GraphQLFieldResolver, defaultFieldResolver, GraphQLResolveInfo } from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';

/**
 * -----------------------------
 *  Redis / Lua-script constants
 * -----------------------------
 *
 *  The Lua script implements the token-bucket algorithm atomically:
 *
 *      1. Fetch current bucket state (tokens + last_refill timestamp)
 *      2. Refill tokens based on elapsed time
 *      3. If token available → decrement & return 0
 *      4. Otherwise          → return positive TTL (seconds) until next token
 *
 *  Script result semantics:
 *      -1 : permit (bucket has tokens)
 *      >0 : retry-after seconds (bucket empty)
 */
const LUA_TOKEN_BUCKET = `
local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refillRate  = tonumber(ARGV[2]) -- tokens per millisecond
local now         = tonumber(ARGV[3])

local bucket      = redis.call('HMGET', key, 'tokens', 'timestamp')
local tokens      = bucket[1] and tonumber(bucket[1]) or capacity
local timestamp   = bucket[2] and tonumber(bucket[2]) or now

-- Refill logic ---------------------------------------------------------------
local elapsed     = now - timestamp
local refill      = elapsed * refillRate
tokens            = math.min(capacity, tokens + refill)
timestamp         = now

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'timestamp', timestamp)
  redis.call('PEXPIRE', key, math.ceil((capacity / refillRate)))
  return -1          -- Permit request
else
  local wait = math.ceil((1 - tokens) / refillRate) -- ms until next token
  redis.call('HMSET', key, 'tokens', tokens, 'timestamp', timestamp)
  redis.call('PEXPIRE', key, math.ceil(wait))
  return math.ceil(wait / 1000)                      -- Retry-After (seconds)
end
`;

/**
 * Rate-limit options shared by both middleware and directive implementations.
 */
export interface RateLimitOptions {
  /**
   * Maximum number of requests (tokens) allowed within `durationSec`.
   */
  points: number;

  /**
   * Time-window for the defined points. Expressed in seconds.
   */
  durationSec: number;

  /**
   * Optional custom Redis key-prefix for isolating different limiters.
   * (e.g., 'login', 'public_api', 'graphqlMutation')
   */
  keyPrefix?: string;

  /**
   * Human-readable name of the limiter that will show up in response headers.
   */
  label?: string;

  /**
   * If true, the limiter will add `X-RateLimit-…` headers to the response.
   * Enabled by default.
   */
  addHeaders?: boolean;
}

/**
 * DistributedRateLimiter
 * ----------------------
 * Encapsulates the Redis script and exposes `consume()` to
 * subtract a token or return the wait-time (in seconds) the caller must wait.
 */
export class DistributedRateLimiter {
  private readonly redis: Redis;
  private readonly options: Required<RateLimitOptions>;
  private readonly tokenRefillRate: number; // Tokens per millisecond

  constructor(redis: Redis, options: RateLimitOptions) {
    this.redis = redis;

    // Fill default options
    this.options = {
      keyPrefix: 'rl:',
      label: 'generic',
      addHeaders: true,
      ...options,
    };

    if (this.options.points <= 0) {
      throw new Error('RateLimit `points` must be greater than 0.');
    }
    if (this.options.durationSec <= 0) {
      throw new Error('RateLimit `durationSec` must be greater than 0.');
    }

    // points / duration(ms)
    this.tokenRefillRate =
      this.options.points / (this.options.durationSec * 1000);
  }

  /**
   * consume
   * -------
   * Atomically consume one token for `key`. Returns:
   *    - `null` when the request is allowed
   *    - number of seconds to wait before retrying otherwise
   */
  async consume(key: string): Promise<number | null> {
    const now = Date.now();
    const redisKey = `${this.options.keyPrefix}${key}`;

    const scriptResult = await this.redis.eval(
      LUA_TOKEN_BUCKET,
      1,
      redisKey,
      this.options.points,
      this.tokenRefillRate,
      now,
    );

    // Lua returns a number (allowed → -1, blocked → waitSecs)
    const numericResult = typeof scriptResult === 'number'
      ? scriptResult
      : parseInt(scriptResult as string, 10);

    return numericResult === -1 ? null : numericResult;
  }

  /**
   * Generates header values compatible with RFC-6585 (RateLimit headers draft).
   */
  public generateHeaders(retryAfterSec?: number): Record<string, string> {
    if (!this.options.addHeaders) return {};

    return {
      'X-RateLimit-Limit': this.options.points.toString(),
      'X-RateLimit-Remaining':
        retryAfterSec !== undefined ? '0' : '1', // We only store bucket­full state
      ...(retryAfterSec !== undefined && {
        'Retry-After': retryAfterSec.toString(),
      }),
      'X-RateLimit-Policy': `${this.options.points};w=${this.options.durationSec}`,
      'X-RateLimit-Name': this.options.label,
    };
  }
}

/**
 * -----------------------------------------------------------------------------
 * Express / Fastify middleware
 * -----------------------------------------------------------------------------
 */

type KeyExtractor = (req: Request) => string | null;

export interface RateLimitMiddlewareOptions extends RateLimitOptions {
  /**
   * Function that extracts a unique bucket key from the request
   * (IP address, user ID, API token, etc.). Returning `null` disables
   * rate-limiting for that request.
   */
  keyExtractor: KeyExtractor;
}

/**
 * Factory that returns an Express-compatible rate-limit middleware.
 */
export function createRateLimitMiddleware(
  redis: Redis,
  opts: RateLimitMiddlewareOptions,
) {
  const limiter = new DistributedRateLimiter(redis, opts);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const key = opts.keyExtractor(req);
      if (!key) return next();

      const waitSec = await limiter.consume(key);
      const headers = limiter.generateHeaders(waitSec ?? undefined);
      Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));

      if (waitSec === null) {
        return next();
      }

      // Too Many Requests
      res.status(429).json({
        error: 'TooManyRequests',
        message: `Rate limit exceeded. Retry in ${waitSec}s.`,
        retryAfter: waitSec,
        traceId: uuid(),
      });
    } catch (err) {
      // Fail-open: if Redis is unreachable, we allow requests but log the incident
      console.error('[RateLimiter] Redis error → allowing request', err);
      return next();
    }
  };
}

/**
 * -----------------------------------------------------------------------------
 * GraphQL Directive (@rateLimit)
 * -----------------------------------------------------------------------------
 *
 *  Directive definition example:
 *
 *    directive @rateLimit(
 *      points: Int!
 *      duration: String!   # e.g., "1m", "24h"
 *      key: RateLimitScope = USER
 *    ) on FIELD_DEFINITION
 *
 *  To keep the demo focus, we support a fixed set of scopes.
 */
export enum RateLimitScope {
  IP = 'IP',
  USER = 'USER',
  API_KEY = 'API_KEY',
}

interface DirectiveArgs {
  points: number;
  duration: string; // Parsed with `ms`
  key: keyof typeof RateLimitScope;
}

/**
 * GraphQL schema-directive visitor that applies DistributedRateLimiter
 * to individual fields / mutations.
 */
export class RateLimitDirective extends SchemaDirectiveVisitor {
  public visitFieldDefinition(
    field: any,
  ): void | GraphQLFieldResolver<any, any> {
    const {
      points,
      duration,
      key: keyScope,
    } = this.args as DirectiveArgs;

    const durationMs = ms(duration);
    if (typeof durationMs !== 'number') {
      throw new Error(
        `@rateLimit invalid duration "${duration}". Use values like "60s" or "1h".`,
      );
    }

    const originalResolve =
      field.resolve || defaultFieldResolver;

    const redis: Redis = (this.context as any).redis; // Injected per-request
    const limiter = new DistributedRateLimiter(redis, {
      points,
      durationSec: durationMs / 1000,
      keyPrefix: `gql:${field.name}:`,
      label: `gql:${field.name}`,
      addHeaders: false, // GraphQL responses rarely include rate headers
    });

    field.resolve = async (
      source: any,
      args: Record<string, any>,
      context: any,
      info: GraphQLResolveInfo,
    ) => {
      const bucketKey = resolveGraphQLKey(keyScope, context);
      if (bucketKey) {
        const waitSec = await limiter.consume(bucketKey);
        if (waitSec !== null) {
          throw new Error(
            `Rate limit exceeded for field "${field.name}". Retry after ${waitSec}s.`,
          );
        }
      }

      return originalResolve.call(this, source, args, context, info);
    };
  }
}

/**
 * Helper that resolves limiter key based on selected scope.
 */
function resolveGraphQLKey(
  scope: RateLimitScope,
  ctx: Record<string, any>,
): string | null {
  switch (scope) {
    case RateLimitScope.USER:
      return ctx.user?.id ?? null;
    case RateLimitScope.API_KEY:
      return ctx.apiKey ?? null;
    case RateLimitScope.IP:
    default:
      return ctx.ip ?? null;
  }
}
```