```typescript
// File: src/module_83.ts
// Description: High-performance, distributed rate-limiter with Redis backend and
//              graceful in-memory fallback. Exposes an agnostic service layer
//              interface, an Express middleware, and a GraphQL directive for
//              clean integration in the SocialPulse API gateway.
//
// Note: This module purposefully avoids importing any project-local code to keep
//       the file self-contained for demonstration purposes. In a real code-base
//       the service would be wired through dependency-injection containers.

import { Request, Response, NextFunction } from 'express';
import { defaultFieldResolver, GraphQLFieldResolver } from 'graphql';
import { SchemaDirectiveVisitor } from 'graphql-tools';
import Redis, { Redis as RedisClient } from 'ioredis';

/* -------------------------------------------------------------------------- */
/*                                Public Types                                */
/* -------------------------------------------------------------------------- */

/**
 * A granular view of the current rate-limit state for a specific consumer.
 */
export interface RateLimitState {
  remaining: number;
  resetAt: number; // unix timestamp (seconds)
  totalAllowed: number;
}

/**
 * General configuration understood by any rate-limiter implementation.
 */
export interface RateLimiterOptions {
  /**
   * The maximum amount of requests permitted per window. The window is defined
   * by `windowInSeconds`.
   */
  points: number;
  /**
   * Length of the rolling window, in seconds.
   */
  windowInSeconds: number;
  /**
   * Optional namespace prefix for keys written to the backing store.
   */
  namespace?: string;
  /**
   * Optional function that returns the Redis client. Allows lazy
   * initialization and central management of connections.
   */
  redisFactory?: () => RedisClient;
}

/* -------------------------------------------------------------------------- */
/*                                Error Types                                 */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when the consumer has exhausted their quota.
 */
export class RateLimitExceededError extends Error {
  public readonly state: RateLimitState;

  constructor(state: RateLimitState, message = 'Too Many Requests') {
    super(message);
    this.state = state;
    this.name = 'RateLimitExceededError';
  }
}

/* -------------------------------------------------------------------------- */
/*                            Service-Layer Contract                          */
/* -------------------------------------------------------------------------- */

export interface RateLimiterService {
  /**
   * Consume a single token for `key` and return the updated rate-limit state.
   * @throws RateLimitExceededError if no tokens remain.
   */
  consume(key: string): Promise<RateLimitState>;

  /**
   * Peek the current state without mutating it.
   */
  getState(key: string): Promise<RateLimitState>;
}

/* -------------------------------------------------------------------------- */
/*                     Redis-backed Production Implementation                 */
/* -------------------------------------------------------------------------- */

const DEFAULT_SCRIPT = `
--[[ 
  KEYS[1] -> bucket key
  ARGV[1] -> window in seconds
  ARGV[2] -> max points
]]
local current = redis.call("INCR", KEYS[1])

if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end

local ttl = redis.call("TTL", KEYS[1])
return { current, ttl }
`;

/**
 * A Lua script registered in Redis that performs atomic increments & TTL
 * retrieval, guaranteeing consistent behaviour across nodes.
 */
const scriptShaCache: Record<string, string | null> = {};

/**
 * Production-grade implementation using Redis for global quota enforcement.
 */
export class RedisRateLimiter implements RateLimiterService {
  private readonly opts: Required<RateLimiterOptions>;
  private readonly redis: RedisClient;

  constructor(opts: RateLimiterOptions) {
    if (!opts.points || !opts.windowInSeconds) {
      throw new Error('points and windowInSeconds are required');
    }

    this.opts = {
      namespace: 'rate',
      redisFactory: () => new Redis(), // default client
      ...opts,
    } as Required<RateLimiterOptions>;

    this.redis = this.opts.redisFactory();
  }

  private buildKey(key: string): string {
    return `${this.opts.namespace}:${key}`;
  }

  private async runScript(key: string): Promise<[number, number]> {
    const lua = DEFAULT_SCRIPT;
    const shaCacheKey = 'default';

    let sha = scriptShaCache[shaCacheKey];
    try {
      if (!sha) {
        sha = await this.redis.script('LOAD', lua);
        scriptShaCache[shaCacheKey] = sha;
      }
      return (await this.redis.evalsha(
        sha,
        1,
        key,
        this.opts.windowInSeconds,
        this.opts.points,
      )) as [number, number];
    } catch (e: unknown) {
      // Script might be flushed; re-attempt once using EVAL
      return (await this.redis.eval(
        lua,
        1,
        key,
        this.opts.windowInSeconds,
        this.opts.points,
      )) as [number, number];
    }
  }

  public async consume(key: string): Promise<RateLimitState> {
    const redisKey = this.buildKey(key);
    const [currentCount, ttlSeconds] = await this.runScript(redisKey);
    const remaining = this.opts.points - currentCount;

    const state: RateLimitState = {
      remaining: Math.max(0, remaining),
      resetAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      totalAllowed: this.opts.points,
    };

    if (remaining < 0) {
      throw new RateLimitExceededError(state);
    }

    return state;
  }

  public async getState(key: string): Promise<RateLimitState> {
    const redisKey = this.buildKey(key);
    const [currentStr, ttlStr] = await this.redis
      .multi()
      .get(redisKey)
      .ttl(redisKey)
      .exec()
      .then((res) => res.map((r) => r[1])) as [string | null, number];

    const current = Number(currentStr ?? 0);
    const remaining = this.opts.points - current;
    const state: RateLimitState = {
      remaining: Math.max(0, remaining),
      resetAt:
        ttlStr === -1
          ? Math.floor(Date.now() / 1000) + this.opts.windowInSeconds
          : Math.floor(Date.now() / 1000) + ttlStr,
      totalAllowed: this.opts.points,
    };
    return state;
  }
}

/* -------------------------------------------------------------------------- */
/*                         In-Memory Fallback (Test)                          */
/* -------------------------------------------------------------------------- */

interface MemoryBucket {
  count: number;
  expiresAt: number;
}

export class InMemoryRateLimiter implements RateLimiterService {
  private readonly opts: Required<RateLimiterOptions>;
  private readonly buckets = new Map<string, MemoryBucket>();

  constructor(opts: RateLimiterOptions) {
    if (!opts.points || !opts.windowInSeconds) {
      throw new Error('points and windowInSeconds are required');
    }

    this.opts = {
      namespace: 'rate',
      ...opts,
    } as Required<RateLimiterOptions>;
  }

  private now(): number {
    return Math.floor(Date.now() / 1000); // seconds
  }

  private sweep() {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  public async consume(key: string): Promise<RateLimitState> {
    this.sweep();

    const bucketKey = `${this.opts.namespace}:${key}`;
    const bucket = this.buckets.get(bucketKey) ?? {
      count: 0,
      expiresAt: this.now() + this.opts.windowInSeconds,
    };

    bucket.count += 1;
    this.buckets.set(bucketKey, bucket);

    const remaining = this.opts.points - bucket.count;

    const state: RateLimitState = {
      remaining: Math.max(0, remaining),
      resetAt: bucket.expiresAt,
      totalAllowed: this.opts.points,
    };

    if (remaining < 0) {
      throw new RateLimitExceededError(state);
    }

    return state;
  }

  public async getState(key: string): Promise<RateLimitState> {
    this.sweep();

    const bucketKey = `${this.opts.namespace}:${key}`;
    const bucket = this.buckets.get(bucketKey) ?? {
      count: 0,
      expiresAt: this.now() + this.opts.windowInSeconds,
    };

    return {
      remaining: Math.max(0, this.opts.points - bucket.count),
      resetAt: bucket.expiresAt,
      totalAllowed: this.opts.points,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Helper Functions                              */
/* -------------------------------------------------------------------------- */

/**
 * Extracts a unique identifier from the request to be used as the rate-limit
 * key. Prefers authenticated user id over IP address to avoid punishing shared
 * networks.
 */
function defaultKeyExtractor(req: Request): string {
  // @ts-ignore – implementation detail of gateway�s auth middleware
  const user = req.user as { id: string } | undefined;
  return user?.id ?? req.ip;
}

/* -------------------------------------------------------------------------- */
/*                           Express.js Middleware                            */
/* -------------------------------------------------------------------------- */

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiterService;
  /**
   * Optional extractor function to override default user/ip detection.
   */
  keyExtractor?: (req: Request) => string;
  /**
   * If true, adds the standard RateLimit-* headers to the response.
   */
  setHeaders?: boolean;
}

export function rateLimitMiddleware(
  opts: RateLimitMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { limiter, keyExtractor = defaultKeyExtractor, setHeaders = true } = opts;

  return async (req, res, next): Promise<void> => {
    try {
      const key = keyExtractor(req);
      const state = await limiter.consume(key);

      if (setHeaders) {
        res.setHeader('RateLimit-Limit', state.totalAllowed.toString());
        res.setHeader('RateLimit-Remaining', state.remaining.toString());
        res.setHeader('RateLimit-Reset', state.resetAt.toString());
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        const { state } = err;
        if (setHeaders) {
          res.setHeader('RateLimit-Limit', state.totalAllowed.toString());
          res.setHeader('RateLimit-Remaining', '0');
          res.setHeader('RateLimit-Reset', state.resetAt.toString());
        }
        res.status(429).json({
          error: 'Too Many Requests',
          retry_after: state.resetAt,
        });
      } else {
        next(err);
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                          GraphQL Directive (SDL)                           */
/* -------------------------------------------------------------------------- */

export const rateLimitDirectiveTypeDefs = /* GraphQL */ `
  directive @rateLimit(
    points: Int! = 100,
    window: Int! = 60,
    key: String
  ) on FIELD_DEFINITION
`;

/**
 * GraphQL directive implementation that wires into the rate-limiter service.
 * Should be registered with ApolloServer or similar.
 */
export class RateLimitDirective extends SchemaDirectiveVisitor {
  private getService(context: any): RateLimiterService {
    // The gateway registers the limiter on context for reuse.
    // Fallback to an in-memory limiter for isolated unit tests.
    return (
      context.rateLimiter ??
      new InMemoryRateLimiter({ points: 10_000, windowInSeconds: 60 })
    );
  }

  public visitFieldDefinition(field: any): void {
    const { resolve = defaultFieldResolver } = field;
    const { points, window, key: keyArg } = this.args as {
      points: number;
      window: number;
      key?: string;
    };

    field.resolve = async (
      ...resolverArgs: Parameters<GraphQLFieldResolver<any, any>>
    ) => {
      const [, , ctx, info] = resolverArgs;
      const limiter = this.getService(ctx);

      const key =
        keyArg ||
        // Prefer authenticated user id > ip > fieldName to isolate costs.
        ctx?.user?.id ||
        ctx?.ip ||
        info.fieldName;

      try {
        await limiter.consume(key);
        return resolve.apply(this, resolverArgs);
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          throw new Error('Rate limit exceeded. Try again later.');
        }
        throw err;
      }
    };
  }
}
```