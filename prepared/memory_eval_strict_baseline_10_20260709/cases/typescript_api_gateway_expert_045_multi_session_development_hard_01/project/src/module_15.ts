```typescript
/*****************************************************************************************
 * SocialPulse Gateway – Redis-backed Sliding-Window Rate Limiter
 * ---------------------------------------------------------------------------------------
 * This module provides an application-layer, per-consumer rate limiter that can be used
 * both in REST (Express) and GraphQL contexts.  It implements a distributed sliding window
 * algorithm on top of Redis sorted-sets, enabling the API-gateway to throttle abusive
 * patterns such as follow-spam and message flood attacks.  The implementation is fully
 * asynchronous, production-ready, and safe for clustered deployments.
 *
 * Key features:
 *   • Sliding-window algorithm (granular & fair compared to fixed window)
 *   • Customisable rules (per route, per GraphQL field, per consumer plan…)
 *   • Pluggable key generator (IP-based, user-id based, session-token based…)
 *   • Express middleware and GraphQL directive helpers
 *   • Typed errors & structured logging hooks
 *****************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import { defaultFieldResolver, GraphQLFieldResolver, GraphQLSchema } from 'graphql';
import {
  SchemaDirectiveVisitor,
  makeExecutableSchema,
} from '@graphql-tools/schema';
import HTTP_STATUS from 'http-status-codes';

/* ──────────────────────────────── Logger contract ──────────────────────────────── */
/*  We reference the project-wide structured logger via a thin interface.           */
interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string | Error, meta?: Record<string, unknown>): void;
}

/* ─────────────────────────────── Error definition ──────────────────────────────── */
export class RateLimitExceededError extends Error {
  public readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterSec} seconds.`);
    this.name = 'RateLimitExceededError';
    this.retryAfterSec = retryAfterSec;
    Error.captureStackTrace(this, RateLimitExceededError);
  }
}

/* ─────────────────────────────── Type contracts ────────────────────────────────── */
export interface RateLimitRule {
  /** Sliding-window size in seconds */
  readonly windowSizeInSec: number;
  /** Maximum number of requests allowed within the window */
  readonly maxRequests: number;
}

export interface RateLimiterOptions {
  /** Which logger implementation to use */
  logger?: ILogger;
  /**
   * Generates a consumer key (e.g., userId, API key, session token) from an HTTP
   * request.  The key partitions the rate limit counter.
   */
  keyGenerator?(req: Request): string;
  /** Redis key prefix to avoid collisions with other modules */
  redisKeyPrefix?: string;
}

/* ─────────────────────────────── Implementation ────────────────────────────────── */
export class RedisSlidingWindowRateLimiter {
  private readonly redis: RedisClient;
  private readonly rules: Map<string, RateLimitRule>;
  private readonly logger: ILogger;
  private readonly keyGenerator: (req: Request) => string;
  private readonly redisKeyPrefix: string;

  constructor(redisClient: RedisClient, opts: RateLimiterOptions = {}) {
    this.redis = redisClient;
    this.rules = new Map<string, RateLimitRule>();
    this.logger =
      opts.logger ??
      ({
        debug: () => void 0,
        info: () => void 0,
        warn: () => void 0,
        error: () => void 0,
      } as ILogger);
    this.keyGenerator =
      opts.keyGenerator ??
      ((req: Request) => {
        // Prefer authenticated principal, fallback to remote IP
        return (req as any).user?.id ?? req.ip;
      });
    this.redisKeyPrefix = opts.redisKeyPrefix ?? 'spg:rate';
  }

  /** Registers or overrides a rate-limiting rule for a logical identifier */
  public registerRule(identifier: string, rule: RateLimitRule): void {
    if (rule.windowSizeInSec <= 0 || rule.maxRequests <= 0) {
      throw new Error('RateLimitRule values must be positive integers');
    }
    this.rules.set(identifier, rule);
    this.logger.info(`Registered rate limit rule`, { identifier, rule });
  }

  /** Express middleware factory for given rule identifier */
  public expressMiddleware =
    (identifier: string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const key = this.keyGenerator(req);
        await this.consume(identifier, key);
        next();
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          res.setHeader('Retry-After', err.retryAfterSec);
          res
            .status(HTTP_STATUS.TOO_MANY_REQUESTS)
            .json({ error: err.message, retryAfter: err.retryAfterSec });
          return;
        }
        next(err);
      }
    };

  /**
   * GraphQL directive factory
   *
   * Usage in schema SDL:
   *   directive @rateLimit(rule: String!) on FIELD_DEFINITION
   *
   * Directive wiring:
   *   const schema = makeExecutableSchema({ typeDefs, resolvers, schemaDirectives: rateLimiter.graphQLDirectiveMap() })
   */
  public graphQLDirectiveMap() {
    // `this` is captured via closure
    const limiter = this;
    class RateLimitDirective extends SchemaDirectiveVisitor {
      public visitFieldDefinition(field: any): void {
        const { resolve = defaultFieldResolver } = field;
        const ruleIdentifier = this.args.rule as string;
        field.resolve = async function (
          source,
          args,
          context,
          info
        ): Promise<unknown> {
          const key: string =
            context?.user?.id ?? context?.ip ?? 'anonymous-gql';
          await limiter.consume(ruleIdentifier, key);
          return resolve.call(this, source, args, context, info);
        };
      }
    }

    return { rateLimit: RateLimitDirective };
  }

  /* ─────────────────────────── Core algorithm ──────────────────────────────── */
  /**
   * Consumes 1 token for the supplied consumer key & rule identifier.  Throws
   * RateLimitExceededError if the bucket is exhausted.
   */
  public async consume(identifier: string, consumerKey: string): Promise<void> {
    const rule = this.rules.get(identifier);
    if (!rule) {
      // No rule → no throttling
      return;
    }

    const { windowSizeInSec, maxRequests } = rule;
    const nowMs = Date.now();
    const windowStartBoundary = nowMs - windowSizeInSec * 1000;
    const redisKey = this.composeRedisKey(identifier, consumerKey);

    try {
      /* Lua-less implementation using MULTI; for true atomicity under heavy
       * contention, a Lua script could be employed. */
      const txn = this.redis.multi();
      txn.zremrangebyscore(redisKey, 0, windowStartBoundary);
      txn.zadd(redisKey, String(nowMs), String(nowMs)); // score == member
      txn.zcard(redisKey);
      txn.expire(redisKey, windowSizeInSec); // auto-cleanup
      const [, , [, requestCount]] = await txn.exec();

      if (typeof requestCount !== 'number') {
        throw new Error('Unexpected Redis response for ZCARD');
      }

      if (requestCount > maxRequests) {
        const retryAfter =
          windowSizeInSec - Math.floor((nowMs - windowStartBoundary) / 1000);
        this.logger.warn('Rate limit hit', {
          identifier,
          consumerKey,
          requestCount,
          maxRequests,
        });
        throw new RateLimitExceededError(retryAfter);
      }

      this.logger.debug('Rate limit allowance', {
        identifier,
        consumerKey,
        requestCount,
        maxRequests,
      });
    } catch (err) {
      if (err instanceof RateLimitExceededError) {
        throw err;
      }
      this.logger.error(err as Error, { identifier, consumerKey });
      // Fail-open on infrastructure errors to preserve availability
    }
  }

  /* ───────────────────────────── Helper methods ────────────────────────────── */
  private composeRedisKey(ruleId: string, consumerKey: string): string {
    return `${this.redisKeyPrefix}:${ruleId}:${consumerKey}`;
  }
}

/* ───────────────────────────── Example wiring ───────────────────────────────── */
/*
import express from 'express';
import Redis from 'ioredis';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { ApolloServer } from 'apollo-server-express';

const redis = new Redis({ host: 'redis-master' });
const rateLimiter = new RedisSlidingWindowRateLimiter(redis, { logger });

rateLimiter.registerRule('PUBLIC_TIMELINE', { windowSizeInSec: 60, maxRequests: 120 });
rateLimiter.registerRule('POST_MUTATION', { windowSizeInSec: 300, maxRequests: 30 });

const app = express();

// REST usage
app.get(
  '/v1/timeline/public',
  rateLimiter.expressMiddleware('PUBLIC_TIMELINE'),
  timelineController.getPublicTimeline
);

// GraphQL usage
const typeDefs = `
  directive @rateLimit(rule: String!) on FIELD_DEFINITION

  type Mutation {
    createPost(input: PostInput!): Post! @rateLimit(rule: "POST_MUTATION")
  }
`;
const resolvers = { ... };
const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
  schemaDirectives: rateLimiter.graphQLDirectiveMap(),
});
const apollo = new ApolloServer({ schema, context: ({ req }) => ({ user: req.user, ip: req.ip }) });
apollo.applyMiddleware({ app });
*/
```