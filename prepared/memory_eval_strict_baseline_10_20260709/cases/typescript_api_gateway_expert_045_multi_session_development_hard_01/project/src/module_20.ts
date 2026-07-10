```typescript
/* ============================================================================
 * File: src/module_20.ts
 * Project: SocialPulse Gateway – Adaptive, Redis–backed rate-limiting layer
 * ----------------------------------------------------------------------------
 * This module supplies a production-grade, adaptive rate-limiter that works for
 * both REST (Express/Fastify) and GraphQL (Apollo/Helix/Envelop) entry-points.
 * It supports:
 *   • User-, IP- and Route-scoped budgets
 *   • Automatic sliding-window refill (token-bucket)
 *   • Configurable penalty scoring for abusive patterns
 *   • Granular configuration per API version
 *   • Centralised, structured logging (pino)
 *   • Clean-architecture boundaries: infrastructure-level service + adapters
 * ==========================================================================*/

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { defaultFieldResolver, GraphQLFieldResolver } from 'graphql';
import { SchemaDirectiveVisitor } from '@graphql-tools/utils';
import Redis, { Redis as RedisClient } from 'ioredis';
import pino from 'pino';

/* ---------------------------------------------------------------------------
 * Logger instance (should ideally come from a shared logging package)
 * -------------------------------------------------------------------------*/
const log = pino({
  name: 'rate-limiter',
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
});

/* ---------------------------------------------------------------------------
 * Types & Interfaces
 * -------------------------------------------------------------------------*/
export interface RateLimitOptions {
  points: number;          // Max number of tokens in the bucket
  duration: number;        // Window size in seconds
  blockDuration?: number;  // Optional: seconds to block once consumed
}

export interface AdaptiveRateLimiterConfig {
  /**
   * Global default limits keyed by API version.
   * E.g. { 'v1': { points: 100, duration: 60 }, 'v2': { points: 75, duration: 60 } }
   */
  defaultLimits: Record<string, RateLimitOptions>;
  redisNamespace?: string;
}

/* ---------------------------------------------------------------------------
 * Internal Helper: Key generator
 * -------------------------------------------------------------------------*/
class RateLimitKeyGenerator {
  constructor(private readonly namespace: string) {}

  public key(options: {
    apiVersion: string;
    route: string;
    identifier: string; // userId|ip
  }): string {
    const routeHash = crypto.createHash('md5').update(options.route).digest('hex');
    return `${this.namespace}:${options.apiVersion}:${routeHash}:${options.identifier}`;
  }
}

/* ---------------------------------------------------------------------------
 * Domain: Result object representing an attempt outcome
 * -------------------------------------------------------------------------*/
export interface RateLimitStatus {
  consumedPoints: number; // Remaining tokens after consumption
  remainingPoints: number;
  isBlocked: boolean;     // If true, consumer must wait blockMs
  blockMs: number;        // Remaining milliseconds in block
}

/* ---------------------------------------------------------------------------
 * Infrastructure Service: AdaptiveRateLimiter
 * -------------------------------------------------------------------------*/
export class AdaptiveRateLimiter {
  private readonly redis: RedisClient;
  private readonly keyGen: RateLimitKeyGenerator;

  constructor(private readonly config: AdaptiveRateLimiterConfig) {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 2,
    });
    this.keyGen = new RateLimitKeyGenerator(config.redisNamespace ?? 'rate-limit');
  }

  /* -----------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------*/

  /**
   * Attempt to consume `cost` tokens for the given identity + route.
   * Returns the new status, throwing on Redis errors.
   */
  public async consume(
    identifier: string, // ip or userId
    route: string,
    apiVersion: string,
    cost = 1,
  ): Promise<RateLimitStatus> {
    const limit = this.resolveLimit(apiVersion);
    const key = this.keyGen.key({ apiVersion, route, identifier });

    // Lua script for atomic token bucket with optional blockDuration
    const lua = `
      local key          = KEYS[1]
      local now          = tonumber(ARGV[1])
      local points       = tonumber(ARGV[2])
      local duration     = tonumber(ARGV[3])
      local cost         = tonumber(ARGV[4])
      local block        = tonumber(ARGV[5])

      local data = redis.call('HMGET', key, 'tokens', 'reset', 'blockUntil')
      local tokens     = tonumber(data[1]) or points
      local reset      = tonumber(data[2]) or (now + duration)
      local blockUntil = tonumber(data[3]) or 0

      -- Still blocked?
      if blockUntil > now then
        return { tokens, reset, 1, blockUntil - now }
      end

      -- Refill if window has passed
      if now >= reset then
        tokens = points
        reset  = now + duration
      end

      if cost > tokens then
        -- Deplete tokens and set block if configured
        tokens = tokens - cost
        local blockTo = (block > 0) and (now + block) or now
        redis.call('HMSET', key, 'tokens', tokens, 'reset', reset, 'blockUntil', blockTo)
        redis.call('EXPIRE', key, math.max(block, duration))
        return { tokens, reset, 1, blockTo - now }
      else
        tokens = tokens - cost
        redis.call('HMSET', key, 'tokens', tokens, 'reset', reset, 'blockUntil', 0)
        redis.call('EXPIRE', key, duration + 1)
        return { tokens, reset, 0, 0 }
      end
    `;

    const now = Math.floor(Date.now() / 1000);
    const result = await this.redis.eval(lua, 1, key, now,
      limit.points, limit.duration, cost, limit.blockDuration ?? 0) as (number | string)[];

    const [tokens, reset, blocked, blockFor] = result.map(Number);

    return {
      consumedPoints: tokens,
      remainingPoints: Math.max(tokens, 0),
      isBlocked: blocked === 1,
      blockMs: blockFor * 1000,
    };
  }

  /**
   * Cleanly stop Redis connection.
   */
  public async dispose(): Promise<void> {
    await this.redis.quit();
  }

  /* -----------------------------------------------------------------------
   * Private Helpers
   * ---------------------------------------------------------------------*/
  private resolveLimit(apiVersion: string): RateLimitOptions {
    const limits = this.config.defaultLimits[apiVersion];

    if (!limits) {
      // Fallback to newest version if unspecified
      const newest = Object.values(this.config.defaultLimits)[0];
      log.warn({ apiVersion }, 'No rate-limit config for requested version. Using newest.');
      return newest;
    }
    return limits;
  }
}

/* ---------------------------------------------------------------------------
 * Infrastructure Adapter: Express middleware
 * -------------------------------------------------------------------------*/
export const createRateLimitMiddleware =
  (limiter: AdaptiveRateLimiter) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Strategy: prefer authenticated userId, fallback to IP
        const identifier = (req as any).user?.id ?? req.ip;
        const route = `${req.method}:${req.baseUrl}${req.path}`;
        const apiVersion = (req.headers['x-api-version'] as string) || 'v1';

        const status = await limiter.consume(identifier, route, apiVersion);

        res.setHeader('X-RateLimit-Remaining', status.remainingPoints);
        if (status.isBlocked) {
          log.info({ identifier, route, apiVersion }, 'Rate-limit exceeded – blocking');
          res.setHeader('Retry-After', Math.ceil(status.blockMs / 1000));
          res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate-limit exceeded. Retry after ${Math.ceil(status.blockMs / 1000)} seconds.`,
          });
          return;
        }
        next();
      } catch (err) {
        // Fail-open approach: log but allow traffic if Redis unavailable
        log.error({ err }, 'Rate-limiter failure – passing through (fail-open)');
        next();
      }
    };

/* ---------------------------------------------------------------------------
 * Infrastructure Adapter: GraphQL @rateLimit directive
 * -------------------------------------------------------------------------*/
interface GraphQLRateLimitArgs {
  cost?: number;
  identifierArg?: string; // Name of argument carrying userId (e.g. mutation target)
  apiVersion?: string;
}

export class RateLimitDirective extends SchemaDirectiveVisitor {
  public visitFieldDefinition(field: any): void {
    const { cost = 1, identifierArg, apiVersion = 'v1' } = this.args as GraphQLRateLimitArgs;
    const limiter: AdaptiveRateLimiter = this.context.limiter;

    const originalResolve: GraphQLFieldResolver<any, any> =
      field.resolve || defaultFieldResolver;

    // eslint-disable-next-line func-names
    field.resolve = async function (source, args, context, info) {
      const identifier =
        (context.user && context.user.id) ||
        (identifierArg && args[identifierArg]) ||
        context.req.ip;

      const route = `GRAPHQL:${info.parentType.name}.${info.fieldName}`;

      const status = await limiter.consume(identifier, route, apiVersion, cost);

      if (status.isBlocked) {
        log.info({ identifier, field: route, apiVersion }, 'GraphQL rate-limit exceeded');
        throw new Error('Too Many Requests – slow down.');
      }

      return originalResolve.call(this, source, args, context, info);
    };
  }
}

/* ---------------------------------------------------------------------------
 * Factory Helper: build a fully configured limiter instance
 * -------------------------------------------------------------------------*/
export function buildDefaultLimiter(): AdaptiveRateLimiter {
  return new AdaptiveRateLimiter({
    defaultLimits: {
      v1: { points: 120, duration: 60, blockDuration: 15 }, // 120 req/min
      v2: { points: 90, duration: 60, blockDuration: 30  }, // 90  req/min, stricter
    },
    redisNamespace: 'spg:rl',
  });
}

/* ---------------------------------------------------------------------------
 * Example Bootstrapping (to be placed in server/init, shown here for reference)
 * -------------------------------------------------------------------------*/
/*
import express from 'express';
import { ApolloServer, gql } from 'apollo-server-express';

(async () => {
  const limiter = buildDefaultLimiter();

  // REST
  const app = express();
  app.use(createRateLimitMiddleware(limiter));
  // ...register routes

  // GraphQL
  const server = new ApolloServer({
    schema: makeExecutableSchema({
      typeDefs: gql`
        directive @rateLimit(
          cost: Int = 1,
          identifierArg: String,
          apiVersion: String = "v1"
        ) on FIELD_DEFINITION
      `,
      resolvers,
      schemaDirectives: { rateLimit: RateLimitDirective },
    }),
    context: ({ req }) => ({ user: req.user, limiter, req }),
  });
  await server.start();
  server.applyMiddleware({ app });

  app.listen(3000, () => log.info('API Gateway running on :3000'));
})();
*/
```