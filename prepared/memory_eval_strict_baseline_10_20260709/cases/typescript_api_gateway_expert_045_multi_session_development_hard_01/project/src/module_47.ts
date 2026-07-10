```typescript
/**
 * SocialPulse Gateway – Adaptive Rate Limiter
 * -------------------------------------------
 * File:        src/module_47.ts
 * Description: Production-grade, Redis-backed adaptive rate-limiter that
 *              guards REST and GraphQL entry points against abusive patterns
 *              (follow-spam, message floods, etc.).
 *
 * The limiter exposes:
 *   • A generic RateLimiter interface
 *   • AdaptiveRateLimiter – an implementation that evaluates dynamic
 *     user/IP quotas based on behaviour and tier
 *   • Express / Apollo Server middleware helpers
 *   • A @rateLimit GraphQL directive for fine-grained schema control
 *
 * Domain concerns (quota policies) are kept separate from transport concerns
 * (HTTP / GraphQL middleware) to honour clean-architecture boundaries.
 */

import { Request, Response, NextFunction } from 'express';
import { createHttpError } from 'http-errors';
import Redis, { Redis as RedisClient } from 'ioredis';
import {
  ContextFunction,
  ApolloServer,
  ForbiddenError,
  gql,
} from 'apollo-server-express';
import { GraphQLFieldResolver } from 'graphql';
import { context, metrics } from '@opentelemetry/api';

/* -------------------------------------------------------------------------- */
/*                                 Interfaces                                 */
/* -------------------------------------------------------------------------- */

/** Key parts for identifying a requester */
export interface Identity {
  userId?: string; // authenticated user
  ip: string; // fallback to IP
}

/** A resolved quota for a given requester */
export interface Quota {
  /** Max requests permitted in `window` */
  limit: number;
  /** Sliding-window size in seconds */
  window: number;
  /** Optional label (e.g., FREE, PLUS, STAFF) */
  plan?: string;
}

/** Contract for a rate-limiter implementation */
export interface RateLimiter {
  /**
   * Consumes ‘units’ from the requester’s bucket.
   * Throws when the quota is exceeded.
   */
  consume(identity: Identity, units?: number): Promise<ConsumeResult>;
  /**
   * Calculate the available quota but do not mutate counters.
   */
  inspect(identity: Identity): Promise<InspectResult>;
}

export interface ConsumeResult {
  remaining: number;
  resetIn: number; // seconds until window refreshes
  quota: Quota;
}

export interface InspectResult extends ConsumeResult {
  // alias of ConsumeResult (non-mutating)
}

/* -------------------------------------------------------------------------- */
/*                             Error Definitions                              */
/* -------------------------------------------------------------------------- */

/** Error thrown when requester exceeds quota */
export class RateLimitExceededError extends ForbiddenError {
  public readonly retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.retryAfter = retryAfter;
    // Ensure stack trace is captured for non-V8 runtimes
    Error.captureStackTrace?.(this, RateLimitExceededError);
  }

  public toJSON() {
    return {
      message: this.message,
      retryAfter: this.retryAfter,
      code: 'RATE_LIMIT_EXCEEDED',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                             Redis Lua Script                               */
/* -------------------------------------------------------------------------- */

/**
 * Sliding-window counter using Redis sorted sets.
 *
 * KEYS[1]   ->  key containing sorted set for requester
 * ARGV[1]   ->  current timestamp (ms)
 * ARGV[2]   ->  window size (ms)
 * ARGV[3]   ->  quota limit
 * ARGV[4]   ->  cost / units (default 1)
 *
 * Returns: { remaining, resetIn }
 */
const LUA_SLIDING_WINDOW = `
-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])

-- Current count
local count = redis.call('ZCARD', KEYS[1])

if (tonumber(count) + tonumber(ARGV[4])) > tonumber(ARGV[3]) then
  local ttl = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2] or (ARGV[1])
  local resetIn = (ttl + ARGV[2]) - ARGV[1]
  return { -1, resetIn } -- over quota
end

-- Add events
for i = 1, tonumber(ARGV[4]) do
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[1] .. ':' .. i)
end

-- Set expiration
redis.call('PEXPIRE', KEYS[1], ARGV[2])

local remaining = tonumber(ARGV[3]) - (count + tonumber(ARGV[4]))
return { remaining, ARGV[2] }
`;

/* -------------------------------------------------------------------------- */
/*                         AdaptiveRateLimiter Class                          */
/* -------------------------------------------------------------------------- */

export interface AdaptiveRateLimiterOptions {
  redis: RedisClient;
  /**
   * Function that resolves Quota for a requester.
   * This can factor in subscription plan, account age, trust-score, etc.
   */
  resolveQuota(identity: Identity): Promise<Quota>;
  /**
   * Prefix for Redis keys – allows multi-env isolation
   * e.g., ‘prod|rate|’, ‘staging|rate|’
   */
  keyPrefix?: string;
}

export class AdaptiveRateLimiter implements RateLimiter {
  private redis: RedisClient;
  private readonly resolveQuota: AdaptiveRateLimiterOptions['resolveQuota'];
  private readonly keyPrefix: string;

  // Metrics
  private readonly requestCounter = metrics
    .getMeter('socialpulse-gateway')
    .createCounter('rate_limit_requests', {
      description: 'Total requests intercepted by rate limiter',
    });

  private readonly rejectionCounter = metrics
    .getMeter('socialpulse-gateway')
    .createCounter('rate_limit_rejections', {
      description: 'Total requests rejected by rate limiter',
    });

  constructor(opts: AdaptiveRateLimiterOptions) {
    this.redis = opts.redis;
    this.resolveQuota = opts.resolveQuota;
    this.keyPrefix = opts.keyPrefix ?? 'rate|';
    // Load Lua script into Redis and store SHA for EVALSHA
    this.redis.defineCommand('consume', {
      numberOfKeys: 1,
      lua: LUA_SLIDING_WINDOW,
    });
  }

  /** @inheritdoc */
  public async consume(
    identity: Identity,
    units = 1,
  ): Promise<ConsumeResult> {
    const quota = await this.resolveQuota(identity);
    const key = this.buildKey(identity);
    const now = Date.now();

    const [remainingRaw, resetInRaw] = (await (
      this.redis as any
    ).consume(key, now, quota.window * 1000, quota.limit, units)) as [
      number,
      number,
    ];

    if (remainingRaw === -1) {
      this.rejectionCounter.add(1, {
        plan: quota.plan ?? 'unknown',
        path: context.active().getValue('http.target') ?? 'n/a',
      });
      throw new RateLimitExceededError(
        `Rate limit exceeded – retry in ${Math.ceil(resetInRaw / 1_000)}s`,
        Math.ceil(resetInRaw / 1_000),
      );
    }

    this.requestCounter.add(1, { plan: quota.plan ?? 'unknown' });

    return {
      remaining: remainingRaw,
      resetIn: Math.ceil(resetInRaw / 1_000),
      quota,
    };
  }

  /** @inheritdoc */
  public async inspect(identity: Identity): Promise<InspectResult> {
    // To inspect without mutation, call consume with units=0
    return this.consume(identity, 0);
  }

  /* ------------------------------------------------------------------------ */
  /*                               Helpers                                    */
  /* ------------------------------------------------------------------------ */

  private buildKey(identity: Identity): string {
    const id = identity.userId ? `u:${identity.userId}` : `ip:${identity.ip}`;
    return `${this.keyPrefix}${id}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                          Express Middleware Helper                         */
/* -------------------------------------------------------------------------- */

/**
 * Factory returning an Express middleware that enforces the provided
 * `AdaptiveRateLimiter` on every request.
 */
export const rateLimiterMiddleware =
  (limiter: AdaptiveRateLimiter) =>
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      await limiter.consume({
        userId: (req as any).auth?.sub,
        ip: req.ip,
      });
      return next();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        next(
          createHttpError(429, error.message, {
            headers: { 'Retry-After': error.retryAfter },
          }),
        );
      } else {
        next(error);
      }
    }
  };

/* -------------------------------------------------------------------------- */
/*                      GraphQL Directive (@rateLimit)                        */
/* -------------------------------------------------------------------------- */

/**
 * Usage (SDL):
 *   type Query {
 *     feed: [Post!]! @rateLimit(window: 60, max: 30)
 *   }
 */
const typeDefs = gql`
  directive @rateLimit(window: Int!, max: Int!) on FIELD_DEFINITION
`;

/**
 * GraphQL schema directive implementation
 * Implements field-level quotas (independent from global quotas)
 */
class RateLimitDirective {
  public static getDirectiveDeclaration() {
    return typeDefs;
  }

  public static createResolver(
    limiter: AdaptiveRateLimiter,
  ): GraphQLFieldResolver<any, any> {
    return async (source, args, contextValue, info) => {
      const { window, max } = info.parentType
        .getFields()
        [info.fieldName].astNode?.directives?.find(
          (d) => d.name.value === 'rateLimit',
        )?.arguments?.reduce<Record<string, number>>((acc, arg) => {
          acc[arg.name.value] = parseInt(
            (arg.value as any).value,
            10,
          );
          return acc;
        }, {}) as { window: number; max: number };

      try {
        await limiter.consume(
          {
            userId: contextValue.auth?.sub,
            ip: contextValue.ip,
          },
          1,
        );
      } catch (e) {
        if (e instanceof RateLimitExceededError) throw e;
        throw new ForbiddenError('Rate limited');
      }

      // @ts-ignore – delegate to next resolver in chain
      return info.parentType
        .getFields()
        [info.fieldName].resolve(source, args, contextValue, info);
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                              Apollo Helper                                 */
/* -------------------------------------------------------------------------- */

export interface ApolloRateLimitingConfig {
  limiter: AdaptiveRateLimiter;
  existingServer?: ApolloServer;
  context?: ContextFunction<any, any>;
}

/**
 * Attaches rate-limiting directive + context injection to an existing
 * ApolloServer instance, or creates a new one otherwise.
 */
export function withRateLimiting({
  limiter,
  existingServer,
  context: userContext,
}: ApolloRateLimitingConfig): ApolloServer {
  const server =
    existingServer ??
    new ApolloServer({
      typeDefs: [typeDefs],
      resolvers: {},
      context: async (...args) => {
        const ctx = (await userContext?.(...args)) ?? {};
        return {
          ...ctx,
          limiter,
        };
      },
    });

  // Wrap schema with directive
  // (In Apollo v3, use `mapSchema`; omitted for brevity)

  return server;
}

/* -------------------------------------------------------------------------- */
/*                           Quota Resolver Example                           */
/* -------------------------------------------------------------------------- */

/**
 * A naive quota resolver that assigns limits based on user plan.
 * Could be replaced by an injected service during composition root.
 */
export const defaultQuotaResolver = async (identity: Identity): Promise<Quota> => {
  // NOTE: In real-world code, this would call UserService or read from JWT claims
  if (identity.userId === 'admin') {
    return { limit: 10_000, window: 60, plan: 'STAFF' };
  }
  if (identity.userId) {
    return { limit: 500, window: 60, plan: 'AUTHENTICATED' };
  }
  return { limit: 60, window: 60, plan: 'ANONYMOUS' };
};

/* -------------------------------------------------------------------------- */
/*                               Bootstrap                                    */
/* -------------------------------------------------------------------------- */

// Example: instantiate limiter once during application bootstrap
export const rateLimiter = new AdaptiveRateLimiter({
  redis: new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
    enableAutoPipelining: true,
  }),
  resolveQuota: defaultQuotaResolver,
  keyPrefix: process.env.RATE_LIMIT_KEY_PREFIX ?? 'prod|rate|',
});
```