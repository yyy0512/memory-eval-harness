```typescript
/*  ===========================================================================
    module_22.ts
    ----------------------------------------------------------------------------
    SocialPulse Gateway – Centralised, distributed rate-limiting component.
    Implements:
      • Redis–backed sliding-window rate-limiter
      • Express middleware (REST)
      • GraphQL schema-directive (Apollo / @graphql-tools)
    ========================================================================== */

import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import ms from 'ms';
import {
  defaultFieldResolver,
  GraphQLFieldResolver,
  GraphQLField,
  GraphQLResolveInfo,
} from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';
import { Logger } from './infrastructure/logger'; // <— project-local structured logger

/* ---------------------------------------------------------------------------
 * Type-level contracts
 * ------------------------------------------------------------------------- */

export interface RateLimitRule {
  /** Maximum number of operations allowed within the window. */
  max: number;
  /** Time window in milliseconds. */
  windowMs: number;
}

export interface RateLimiterOptions {
  /** Redis key-space prefix (namespacing) */
  prefix?: string;
  /**
   * Fallback (default) rule when no custom rule is resolved for a
   * particular identifier (route / GraphQL field / etc.).
   */
  defaultRule: RateLimitRule;
  /**
   * Optional resolver returning a rule at runtime. It allows per-user,
   * per-route, or per-subscription customisation.
   */
  resolveRule?(
    identifier: string,
    requestContext: RequestContext,
  ): Promise<RateLimitRule | undefined> | RateLimitRule | undefined;
}

/**
 * Minimal shared context between REST/GraphQL environments.
 * Extend as necessary.
 */
export interface RequestContext {
  /** Unique end-user identifier when authenticated, otherwise undefined. */
  userId?: string;
  /** Remote IP address (proxy aware). */
  ip: string;
}

/* ---------------------------------------------------------------------------
 * Redis-backed sliding-window rate-limiter implementation
 * ------------------------------------------------------------------------- */
export class RateLimiter {
  private readonly redis: Redis.Redis;
  private readonly options: RateLimiterOptions;
  private readonly logger = new Logger('RateLimiter');

  /** Lua script SHA loaded at bootstrap for atomic sliding-window ops. */
  private luaSha?: string;

  constructor(redis: Redis.Redis, options: RateLimiterOptions) {
    this.redis = redis;
    this.options = {
      prefix: 'rl',
      ...options,
    };
    this.bootstrapLuaScript().catch((err) => {
      this.logger.error(`Failed to load Lua script: ${err.message}`, { err });
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                              */
  /* ----------------------------------------------------------------------- */

  /**
   * Checks & consumes a single token for the specified identifier.
   * @returns remaining – how many tokens are still available within the window
   */
  public async consume(
    identifier: string,
    ctx: RequestContext,
  ): Promise<{ remaining: number; resetAt: number }> {
    const rule =
      (await this.options.resolveRule?.(identifier, ctx)) ??
      this.options.defaultRule;
    const key = this.key(identifier, ctx);
    const now = Date.now();

    // Execute atomic Lua script (defined below).
    const [allowed, remaining, resetAt] = (await this.redis.evalsha(
      this.luaSha!,
      1,
      key,
      rule.max,
      rule.windowMs,
      now,
    )) as [number, number, number];

    if (!allowed) {
      throw new RateLimitExceededError({
        remaining,
        resetAt,
        rule,
      });
    }

    return { remaining, resetAt };
  }

  /* ----------------------------------------------------------------------- */
  /* Private helpers                                                         */
  /* ----------------------------------------------------------------------- */

  private key(identifier: string, ctx: RequestContext): string {
    const subject = ctx.userId ?? ctx.ip;
    return `${this.options.prefix}:${identifier}:${subject}`;
  }

  /**
   * Loads a small Lua script implementing sliding-window rate limiting.
   * Ensures atomicity & single-roundtrip performance.
   *
   * KEYS[1]  – Redis key
   * ARGV[1]  – max
   * ARGV[2]  – windowMs
   * ARGV[3]  – now (ms)
   *
   * Returns: {allowed, remaining, resetAt}
   */
  private async bootstrapLuaScript(): Promise<void> {
    const script = `
      local key       = KEYS[1]
      local max       = tonumber(ARGV[1])
      local windowMs  = tonumber(ARGV[2])
      local now       = tonumber(ARGV[3])

      -- Remove outdated entries from the sorted-set window
      redis.call("ZREMRANGEBYSCORE", key, 0, now - windowMs)

      -- Current operation count
      local count = tonumber(redis.call("ZCARD", key))

      local allowed = count < max
      if allowed then
        -- score == timestamp; member == unique id to avoid collisions
        redis.call("ZADD", key, now, tostring(now) .. ":" .. math.random())
      end

      -- Time when the oldest request will fall out of window
      local earliest = tonumber(redis.call("ZRANGE", key, 0, 0, "WITHSCORES")[2]) or now
      local resetAt  = earliest + windowMs

      -- Set TTL to be sure keys disappear, but keep it ≥ window
      redis.call("PEXPIRE", key, windowMs * 2)

      return { allowed and 1 or 0, math.max(0, max - count - (allowed and 1 or 0)), resetAt }
    `;

    const sha = await this.redis.script('LOAD', script);
    this.luaSha = sha;
    this.logger.debug('Loaded Lua rate-limiter script', { sha });
  }
}

/* ---------------------------------------------------------------------------
 * Custom error type
 * ------------------------------------------------------------------------- */
export class RateLimitExceededError extends Error {
  public readonly remaining: number;
  public readonly resetAt: number;
  public readonly rule: RateLimitRule;

  constructor(params: { remaining: number; resetAt: number; rule: RateLimitRule }) {
    super('Rate limit exceeded');
    Object.setPrototypeOf(this, new.target.prototype);
    this.remaining = params.remaining;
    this.resetAt = params.resetAt;
    this.rule = params.rule;
  }
}

/* ---------------------------------------------------------------------------
 * REST middleware factory
 * ------------------------------------------------------------------------- */

export function createRateLimitMiddleware(
  rateLimiter: RateLimiter,
  identifierExtractor: (req: Request) => string,
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const identifier = identifierExtractor(req);

    const ctx: RequestContext = {
      userId: (req as any).user?.id,
      ip: req.headers['x-forwarded-for']?.toString() ?? req.socket.remoteAddress ?? '',
    };

    try {
      const { remaining, resetAt } = await rateLimiter.consume(identifier, ctx);
      res.setHeader('X-RateLimit-Limit', rateLimiter['options'].defaultRule.max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000)); // seconds
      next();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        res.setHeader('Retry-After', Math.ceil((err.resetAt - Date.now()) / 1000));
        res.setHeader('X-RateLimit-Limit', err.rule.max);
        res.setHeader('X-RateLimit-Remaining', err.remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(err.resetAt / 1000));
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
        });
        return;
      }
      next(err);
    }
  };
}

/* ---------------------------------------------------------------------------
 * GraphQL directive:  @rateLimit(max: Int = 20, window: String = "1m")
 * ------------------------------------------------------------------------- */

interface RateLimitDirectiveArgs {
  max?: number;
  window?: string;
}

export class RateLimitDirective extends SchemaDirectiveVisitor {
  public visitFieldDefinition(field: GraphQLField<any, any>): void {
    const { resolve = defaultFieldResolver } = field;
    const { max = 20, window = '1m' } = this.args as RateLimitDirectiveArgs;

    const windowMs = typeof window === 'number' ? window : ms(window);

    field.resolve = buildRateLimitedResolver(resolve, {
      max,
      windowMs,
    });
  }
}

/**
 * Wraps the original resolver with rate-limiting logic.
 */
function buildRateLimitedResolver<TSource, TArgs, TContext>(
  originalResolver: GraphQLFieldResolver<TSource, TContext, TArgs>,
  rule: RateLimitRule,
): GraphQLFieldResolver<TSource, TContext, TArgs> {
  return async function rateLimitedResolver(
    source: TSource,
    args: TArgs,
    context: any,
    info: GraphQLResolveInfo,
  ) {
    const rateLimiter: RateLimiter = context.rateLimiter;
    if (!rateLimiter) {
      throw new Error(
        'RateLimiter instance missing from GraphQL context. ' +
          'Ensure you pass { rateLimiter } into ApolloServer context.',
      );
    }

    const identifier = `${info.parentType.name}.${info.fieldName}`;
    const requestContext: RequestContext = {
      userId: context.user?.id,
      ip: context.ip,
    };

    await rateLimiter.consume(identifier, requestContext);

    return originalResolver.call(this, source, args, context, info);
  };
}

/* ---------------------------------------------------------------------------
 * Convenience helpers for consumers
 * ------------------------------------------------------------------------- */

/**
 * Builds a default RateLimiter suitable for most REST/GraphQL usage
 * (100 req / 15 minutes).
 */
export function defaultRateLimiter(redis: Redis.Redis): RateLimiter {
  return new RateLimiter(redis, {
    prefix: 'rl',
    defaultRule: { max: 100, windowMs: ms('15m') },
  });
}

/**
 * Express middleware using path + HTTP method as identifier.
 */
export function restRateLimiterMiddleware(rateLimiter: RateLimiter) {
  return createRateLimitMiddleware(
    rateLimiter,
    (req) => `${req.method}:${req.baseUrl}${req.path}`,
  );
}
```