```typescript
/***************************************************************************************************
 *  SocialPulse Gateway – module_38.ts
 *
 *  Feature: Distributed, pluggable rate-limiting for REST (Express) and GraphQL (Apollo) entry
 *  points. Implements a token-bucket algorithm backed by Redis with automatic key expiration and
 *  adaptive limits (per-IP, per-user, and global fall-back). A single Lua script guarantees
 *  atomicity under heavy concurrent traffic.
 *
 *  Usage
 *  ─────
 *    import {
 *      createRateLimitMiddleware,
 *      RateLimitDirective,
 *      RateLimiter,
 *    } from './module_38';
 *
 *    // REST
 *    app.use('/api', createRateLimitMiddleware(redis, logger));
 *
 *    // GraphQL
 *    const schema = makeExecutableSchema({
 *      typeDefs: [typeDefs, RateLimitDirective.typeDefs],
 *      resolvers: [resolvers],
 *      schemaDirectives: { rateLimit: RateLimitDirective },
 *    });
 *
 ***************************************************************************************************/

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis from 'ioredis';
import { GraphQLFieldResolver, defaultFieldResolver, GraphQLDirective, DirectiveLocation } from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';
import * as winston from 'winston';

/**
 * Configuration contract for a single rate-limit bucket.
 */
export interface BucketConfig {
  /**
   * Maximum number of requests that can be executed during the refill interval.
   */
  readonly capacity: number;
  /**
   * Interval (in milliseconds) after which the bucket is fully refilled.
   */
  readonly refillMs: number;
}

/**
 * High-level limits accepted by the gateway. You can add app specific buckets
 * (e.g., `mutation`, `query/heavy`, etc.) by extending this enum.
 */
export enum BucketType {
  PER_IP = 'PER_IP',
  PER_USER = 'PER_USER',
  GLOBAL = 'GLOBAL',
}

/**
 * Comprehensive configuration inserted at bootstrap time.
 */
export interface RateLimiterConfig {
  buckets: Record<BucketType, BucketConfig>;
  /**
   * Optional namespace prefix to avoid collisions when multiple stacks share the same Redis
   * cluster (e.g., staging vs. prod).
   */
  namespace?: string;
}

/**
 * Detailed result of a `consume()` operation.
 */
export interface ConsumeResult {
  /**
   * `true` if the token allocation succeeded and the request may proceed.
   */
  readonly accepted: boolean;
  /**
   * When the visitor is throttled, indicates after how many milliseconds she
   * can retry without penalty. `null` if `accepted` is true.
   */
  readonly retryAfterMs: number | null;
  /**
   * Remaining tokens available in the bucket used for this request.
   */
  readonly remaining: number;
}

const LUA_TOKEN_BUCKET = /* lua */ `
local key           = KEYS[1]
local capacity      = tonumber(ARGV[1])
local refill_ms     = tonumber(ARGV[2])
local now           = tonumber(ARGV[3])
local ttl           = tonumber(ARGV[4])

local state = redis.call("HMGET", key, "tokens", "last")
local tokens = tonumber(state[1]) or capacity
local last   = tonumber(state[2]) or now

-- Refill calculation
local elapsed = now - last
local refill  = math.floor(elapsed * capacity / refill_ms)
tokens = math.min(capacity, tokens + refill)
last = last + refill * refill_ms / capacity

if tokens <= 0 then
  -- Already exhausted. Compute retry delay.
  local retry = math.ceil((1 - tokens) * refill_ms / capacity)
  redis.call("PEXPIRE", key, ttl)
  return {0, retry, tokens}
end

-- Consume a single token
tokens = tokens - 1

-- Save new state and TTL
redis.call("HMSET", key, "tokens", tokens, "last", last)
redis.call("PEXPIRE", key, ttl)

return {1, 0, tokens}
`;

/**
 * Implements a distributed token-bucket leveraging a Lua script for atomicity.
 */
export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private readonly redis: Redis.Redis;
  private readonly log: winston.Logger;
  private readonly scriptShaPromise: Promise<string>;

  constructor(config: RateLimiterConfig, redisInstance: Redis.Redis, logger: winston.Logger) {
    this.config = config;
    this.redis = redisInstance;
    this.log = logger.child({ module: 'RateLimiter' });
    // Preload Lua script for performance. If this fails, fallback to eval.
    this.scriptShaPromise = this.redis.script('LOAD', LUA_TOKEN_BUCKET).catch(() => '');
  }

  /**
   * Attempts to consume a token from the specified bucket.
   */
  public async consume(bucket: BucketType, identifier: string): Promise<ConsumeResult> {
    const bucketCfg = this.config.buckets[bucket];
    if (!bucketCfg) {
      throw new Error(`RateLimiter: bucket "${bucket}" is not configured.`);
    }

    const key = this.key(bucket, identifier);
    const ttl = bucketCfg.refillMs * 2; // allow full cycle of inactivity before eviction
    const now = Date.now();

    // Lua arguments
    const keys = [key];
    const args = [
      bucketCfg.capacity.toString(),
      bucketCfg.refillMs.toString(),
      now.toString(),
      ttl.toString(),
    ];

    // Use EVALSHA when possible (faster); fallback to EVAL when script is missing
    const sha = await this.scriptShaPromise;
    let response: [number, number, number];
    try {
      response = (await this.redis.evalsha(sha, keys.length, ...keys, ...args)) as [number, number, number];
    } catch (err: any) {
      if (err.message?.includes('NOSCRIPT')) {
        response = (await this.redis.eval(LUA_TOKEN_BUCKET, keys.length, ...keys, ...args)) as [
          number,
          number,
          number,
        ];
      } else {
        this.log.error('Redis error during rate-limit evaluation', { err });
        throw err;
      }
    }

    const [acceptedFlag, retryMs, remaining] = response;
    return {
      accepted: acceptedFlag === 1,
      retryAfterMs: acceptedFlag === 1 ? null : retryMs,
      remaining,
    };
  }

  private key(bucket: BucketType, identifier: string): string {
    const ns = this.config.namespace ?? 'spl';
    return `${ns}:rate:${bucket}:${identifier}`;
  }
}

/**
 * Factory that creates an Express middleware bound to the given Redis instance & logger.
 */
export function createRateLimitMiddleware(
  redis: Redis.Redis,
  logger: winston.Logger,
  overrideConfig?: Partial<RateLimiterConfig>,
): RequestHandler {
  const defaultConfig: RateLimiterConfig = {
    namespace: 'spl',
    buckets: {
      [BucketType.PER_IP]: { capacity: 100, refillMs: 60_000 }, // 100 requests per minute, per IP
      [BucketType.PER_USER]: { capacity: 300, refillMs: 60_000 }, // 300 requests per minute, per user
      [BucketType.GLOBAL]: { capacity: 5_000, refillMs: 60_000 }, // 5k requests per minute global
    },
  };

  const config: RateLimiterConfig = {
    ...defaultConfig,
    ...overrideConfig,
    buckets: { ...defaultConfig.buckets, ...(overrideConfig?.buckets ?? {}) },
  };

  const limiter = new RateLimiter(config, redis, logger);

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // 1️⃣  Determine the identifier
      const ip = req.ip;
      const userId = (req as any).auth?.userId as string | undefined; // rely on upstream auth middleware
      const identifier = userId ?? ip;

      // 2️⃣  Evaluate per-user/IP bucket, fallback to global
      const result =
        (userId
          ? await limiter.consume(BucketType.PER_USER, userId)
          : await limiter.consume(BucketType.PER_IP, ip)) ?? (await limiter.consume(BucketType.GLOBAL, 'g'));

      // 3️⃣  Set headers for client awareness
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
      res.setHeader('X-RateLimit-Limit', String(config.buckets.BUCKET ?? ''));
      if (!result.accepted && result.retryAfterMs !== null) {
        res.setHeader('Retry-After', Math.ceil(result.retryAfterMs / 1000).toString());
      }

      // 4️⃣  Allow or reject
      if (result.accepted) {
        return next();
      }
      res.status(429).json({
        error: 'RATE_LIMITED',
        reason: 'Too many requests',
        retryAfterMs: result.retryAfterMs,
      });
    } catch (err: any) {
      logger.error('Rate-limit middleware failure', { err });
      // Fail-open – do not block user if rate-limiter infrastructure is unavailable
      return next();
    }
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 🕸  GraphQL rate-limit directive                                         */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * GraphQL directive definition usable as:
 *
 *   type Query {
 *     viewerTimeline(limit: Int): [Post] @rateLimit(bucket: PER_USER)
 *   }
 */
export class RateLimitDirective extends SchemaDirectiveVisitor {
  public static readonly typeDefs = /* GraphQL */ `
    directive @rateLimit(bucket: BucketType = PER_USER) on FIELD_DEFINITION

    enum BucketType {
      PER_IP
      PER_USER
      GLOBAL
    }
  `;

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  public static create(
    redis: Redis.Redis,
    logger: winston.Logger,
    config?: Partial<RateLimiterConfig>,
  ): typeof RateLimitDirective {
    const limiter = new RateLimiter(
      {
        namespace: 'spl',
        buckets: {
          [BucketType.PER_IP]: { capacity: 60, refillMs: 60_000 },
          [BucketType.PER_USER]: { capacity: 500, refillMs: 60_000 },
          [BucketType.GLOBAL]: { capacity: 10_000, refillMs: 60_000 },
        },
        ...config,
      },
      redis,
      logger,
    );

    return class extends RateLimitDirective {
      // @ts-ignore – Generic overridden by dynamic class
      public visitFieldDefinition(field: any): void {
        const { bucket = BucketType.PER_USER } = this.args as { bucket: BucketType };
        const { resolve = defaultFieldResolver } = field;

        const self = this;

        field.resolve = async function rateLimitedResolver(
          ...resolverArgs: [any, any, any, any]
        ): Promise<unknown> {
          const [, , ctx] = resolverArgs;
          const identifier: string = ctx.user?.id ?? ctx.ip ?? 'anonymous';

          const outcome = await limiter.consume(bucket, identifier);
          if (!outcome.accepted) {
            const error = new RateLimitGraphQLError(
              'Too many requests.',
              Math.ceil((outcome.retryAfterMs ?? 0) / 1000),
            );
            (error as any).extensions = {
              code: 'RATE_LIMITED',
              retryAfter: outcome.retryAfterMs,
            };
            throw error;
          }
          return resolve.apply(this, resolverArgs as unknown as Parameters<GraphQLFieldResolver<any, any>>);
        };
      }
    };
  }
}

/**
 * Minimal GraphQL error with HTTP semantics for Apollo.
 */
export class RateLimitGraphQLError extends Error {
  public readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 🛈  Helpers                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

export function setupDefaultLogger(): winston.Logger {
  return winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json(),
    ),
    transports: [new winston.transports.Console()],
  });
}
```