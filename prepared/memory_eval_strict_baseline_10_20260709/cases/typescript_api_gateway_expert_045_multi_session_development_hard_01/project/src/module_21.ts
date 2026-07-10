```typescript
/* ----------------------------------------------------------------------
 * SocialPulse Gateway – src/module_21.ts
 *
 * Production-grade, cross-layer rate-limiting module
 * --------------------------------------------------
 * Responsibilities
 *  • Perform distributed, token-bucket rate limiting backed by Redis.
 *  • Expose helpers for:
 *      – REST (Express) middleware
 *      – GraphQL directive (@rateLimit)
 *  • Provide per-route / per-field configurability as well as
 *    identity-aware key derivation (userId, IP, API key, …).
 *  • Fail-safe:  Gracefully degrades to in-memory limiter when Redis
 *    is unavailable, while emitting structured logs and metrics.
 *
 * Clean-architecture mapping
 *  • Domain         – RateLimitPolicy (value object)
 *  • Application    – RateLimiter service (+ DTOs & errors)
 *  • Infrastructure – Redis adapter, GraphQL/REST integrations
 * ------------------------------------------------------------------- */

import { Request, Response, NextFunction } from 'express';
import { defaultFieldResolver, GraphQLFieldResolver, GraphQLSchema } from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';
import { StatusCodes } from 'http-status-codes';
import * as uuid from 'uuid';
import Redis, { Script } from 'ioredis';
import pino from 'pino';

/* ------------------------------------------------------------------ */
/* Domain layer                                                       */
/* ------------------------------------------------------------------ */

/**
 * Immutable value object describing a rate-limit policy.
 */
export interface RateLimitPolicy {
  windowMs: number; // Sliding window size in ms
  maxRequests: number; // Max requests per window
  /**
   * Unique policy identifier used for key derivation
   * (e.g. `POST_/v1/timeline`).
   */
  policyId: string;
}

/* ------------------------------------------------------------------ */
/* Application layer                                                  */
/* ------------------------------------------------------------------ */

export interface RateLimiterCtx {
  userId?: string;
  ip?: string;
  apiKey?: string;
}

export class RateLimitExceededError extends Error {
  public readonly retryAfterSec: number;

  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = 'RateLimitExceededError';
    this.retryAfterSec = retryAfterSec;
  }
}

export interface RateLimiter {
  /**
   * Consumes 1 token from the bucket associated with the provided policy.
   * @throws {RateLimitExceededError} when the bucket is empty.
   */
  consume(policy: RateLimitPolicy, ctx: RateLimiterCtx): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Infrastructure layer: Redis-backed implementation                  */
/* ------------------------------------------------------------------ */

const logger = pino({ name: 'rate-limiter' });

/**
 * Lua script implementing sliding-window log algorithm.
 * KEYS[1] – bucket key
 * ARGV[1] – current timestamp (ms)
 * ARGV[2] – window (ms)
 * ARGV[3] – max requests
 *
 * Returns: (number) remaining tokens
 */
const SLIDING_WINDOW_LUA = `
  local key        = KEYS[1]
  local now        = tonumber(ARGV[1])
  local window     = tonumber(ARGV[2])
  local maxReq     = tonumber(ARGV[3])
  -- purge entries outside of window
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  -- add current request
  redis.call('ZADD', key, now, now)
  local count = tonumber(redis.call('ZCARD', key))
  redis.call('EXPIRE', key, math.ceil(window / 1000))
  return maxReq - count
`;

export class RedisRateLimiter implements RateLimiter {
  private readonly redis: Redis.Redis & Script;
  private readonly fallbackMemCache: Map<string, number> = new Map();

  constructor(redisClient?: Redis.Redis) {
    // Attach Lua script
    this.redis =
      (redisClient || new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379')) as
        Redis.Redis & Script;
    (this.redis as any).defineCommand('swConsume', {
      numberOfKeys: 1,
      lua: SLIDING_WINDOW_LUA,
    });
  }

  public async consume(policy: RateLimitPolicy, ctx: RateLimiterCtx): Promise<void> {
    const key = this.buildKey(policy, ctx);
    try {
      const remaining: number = await (this.redis as any).swConsume(
        key,
        Date.now(),
        policy.windowMs,
        policy.maxRequests,
      );

      if (remaining < 0) {
        // Token bucket empty
        const retryAfterSec = Math.ceil(policy.windowMs / 1000);
        throw new RateLimitExceededError('Rate limit exceeded', retryAfterSec);
      }
    } catch (err: any) {
      if (err instanceof RateLimitExceededError) {
        throw err;
      }
      // Redis failure fallback
      logger.warn({ err }, 'Redis unavailable – falling back to in-memory limiter');
      this.consumeInMemory(key, policy);
    }
  }

  /* ---------------------------------- */
  /* Internal helpers                   */
  /* ---------------------------------- */

  private buildKey(policy: RateLimitPolicy, ctx: RateLimiterCtx): string {
    const identity =
      ctx.userId ?? ctx.apiKey ?? ctx.ip ?? uuid.v4(); // last-ditch uniq key
    return `rl:${policy.policyId}:${identity}`;
  }

  private consumeInMemory(key: string, policy: RateLimitPolicy): void {
    const now = Date.now();
    // Map value: timestamp[] (sliding window log)
    const timestamps = (this.fallbackMemCache.get(key) ?? []) as number[];
    const fresh = timestamps.filter((ts) => ts > now - policy.windowMs);
    fresh.push(now);
    this.fallbackMemCache.set(key, fresh);

    if (fresh.length > policy.maxRequests) {
      throw new RateLimitExceededError(
        'Rate limit exceeded (memory fallback)',
        Math.ceil(policy.windowMs / 1000),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* REST (Express) middleware                                          */
/* ------------------------------------------------------------------ */

export interface RestRateLimitOptions extends RateLimitPolicy {
  identify: (req: Request) => RateLimiterCtx;
}

export const rateLimit =
  (limiter: RateLimiter, opts: RestRateLimitOptions) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await limiter.consume(
        { policyId: opts.policyId, windowMs: opts.windowMs, maxRequests: opts.maxRequests },
        opts.identify(req),
      );
      return next();
    } catch (err: any) {
      if (err instanceof RateLimitExceededError) {
        res.setHeader('Retry-After', err.retryAfterSec.toString());
        return res
          .status(StatusCodes.TOO_MANY_REQUESTS)
          .json({ error: 'rate_limit_exceeded', retryAfter: err.retryAfterSec });
      }
      logger.error({ err }, 'Unexpected rate-limiter error');
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ error: 'internal_error' });
    }
  };

/* ------------------------------------------------------------------ */
/* GraphQL directive (@rateLimit)                                     */
/* ------------------------------------------------------------------ */

interface GraphQLRateLimitArgs {
  window: string; // ISO duration e.g. "PT1M" or "60" (seconds)
  max: number;
  identity?: 'USER' | 'IP' | 'API_KEY' | 'ANON';
}

const parseWindow = (input: string): number => {
  // Very naive ISO8601 + seconds fallback parser
  if (/^\d+$/.test(input)) return parseInt(input, 10) * 1000;
  const match = /PT(\d+)M?(\d+)?S?/.exec(input);
  if (match) {
    const minutes = parseInt(match[1] || '0', 10);
    const seconds = parseInt(match[2] || '0', 10);
    return (minutes * 60 + seconds) * 1000;
  }
  throw new Error(`Invalid window specification: ${input}`);
};

export class RateLimitDirective extends SchemaDirectiveVisitor {
  private readonly limiter: RateLimiter;

  constructor(config: any, limiter: RateLimiter) {
    super(config);
    this.limiter = limiter;
  }

  public visitFieldDefinition(field: any): void {
    const { resolve = defaultFieldResolver } = field;
    const args = this.args as GraphQLRateLimitArgs;
    const policy: RateLimitPolicy = {
      policyId: `GQL:${this.getPath()}`, // e.g. Query.feed
      windowMs: parseWindow(args.window),
      maxRequests: args.max,
    };

    field.resolve = async (
      parent: any,
      params: any,
      ctx: any,
      info: any,
    ): Promise<any> => {
      const identity = this.buildCtx(ctx, args.identity);
      await this.limiter.consume(policy, identity);
      return (resolve as GraphQLFieldResolver<any, any>)(parent, params, ctx, info);
    };
  }

  private buildCtx(reqCtx: any, identityArg?: string): RateLimiterCtx {
    const source = identityArg ?? 'USER';
    switch (source) {
      case 'USER':
        return { userId: reqCtx.user?.id };
      case 'API_KEY':
        return { apiKey: reqCtx.apiKey };
      case 'IP':
        return { ip: reqCtx.ip };
      default:
        return {};
    }
  }

  private getPath(): string {
    return (this as any)._fieldName; // utils does not expose directly
  }
}

/**
 * Helper to attach directive to an Apollo schema.
 */
export const attachRateLimitDirective = (
  schema: GraphQLSchema,
  limiter: RateLimiter,
): GraphQLSchema => {
  return SchemaDirectiveVisitor.visitSchemaDirectives(schema, {
    rateLimit: (config: any) => new RateLimitDirective(config, limiter),
  }) as unknown as GraphQLSchema;
};

/* ------------------------------------------------------------------ */
/* Example bootstrap                                                  */
/* ------------------------------------------------------------------ */

// Direct usage example. In real application this would be wired via DI container.

if (require.main === module) {
  (async () => {
    const redisClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    const limiter = new RedisRateLimiter(redisClient);

    // Simple self-test
    const policy: RateLimitPolicy = {
      policyId: 'selftest',
      windowMs: 10_000,
      maxRequests: 3,
    };

    for (let i = 0; i < 5; i++) {
      try {
        await limiter.consume(policy, { ip: '127.0.0.1' });
        logger.info(`Request ${i + 1} allowed`);
      } catch (e) {
        logger.error({ e }, `Request ${i + 1} blocked`);
      }
    }

    redisClient.disconnect();
  })().catch((e) => {
    logger.error({ e }, 'Self-test failed');
    process.exit(1);
  });
}
```