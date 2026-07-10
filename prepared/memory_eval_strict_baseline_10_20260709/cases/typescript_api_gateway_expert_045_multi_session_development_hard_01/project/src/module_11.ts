```typescript
/**************************************************************************************************
 *  SocialPulse Gateway – Rate Limiting Module
 *  File:        src/module_11.ts
 *  Description: Production-grade, Redis-backed token-bucket rate limiter with adapters for both
 *               Express (REST) and ApolloServer (GraphQL).  Designed for high-throughput social
 *               traffic with fine-grained limits on a per-user / per-IP / per-route basis.
 **************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import { ApolloServerPlugin, GraphQLRequestContext } from 'apollo-server-plugin-base';
import { createClient, RedisClientType } from 'redis';
import { EventEmitter } from 'events';

/**
 * Error thrown when a caller exceeds its allotted request budget.
 */
export class RateLimitExceededError extends Error {
  public retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.retryAfter = retryAfter;
    this.name = 'RateLimitExceededError';
  }
}

/**
 * Rate limiter configuration.
 */
export interface RateLimiterConfig {
  bucketSize: number;                 // Maximum number of tokens in the bucket
  refillRate: number;                 // Tokens added per period
  refillPeriod: number;               // Refill period (ms)
  /**
   * Key derivation strategy.  By default we will use 'req.ip' for REST and
   * 'context.user?.id' for GraphQL, but this hook enables custom logic.
   */
  keyGenerator?: (input: {
    req?: Request;
    graphContext?: Record<string, any>;
  }) => string | null | undefined;
  /**
   * Name for metric labels / debugging
   */
  name?: string;
}

/**
 * Token bucket bookkeeping stored in Redis.
 */
interface RedisBucket {
  tokens: number;
  timestamp: number;
}

/**
 * Centralised rate limiter service.
 * The service is a singleton in practice, but the implementation does not enforce that.
 */
export class RateLimiter extends EventEmitter {
  private readonly redis: RedisClientType;
  private readonly cfg: RateLimiterConfig;
  private readonly luaShaPromise: Promise<string>;

  constructor(redisClient?: RedisClientType, cfg?: Partial<RateLimiterConfig>) {
    super();
    // Allow external redis client injection for testability.
    this.redis =
      redisClient ??
      createClient({
        url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      });
    if (!this.redis.isOpen) {
      // Kicking off connection is fire-and-forget—the caller should hook into the promise if needed.
      this.redis.connect().catch((err) => {
        // Soft fail—the in-memory fallback will kick in.
        // Emit event so infra can alarm.
        this.emit('error', err);
      });
    }

    // Merge config with sensible defaults.
    this.cfg = Object.freeze({
      bucketSize: 120,
      refillRate: 120,
      refillPeriod: 60_000, // 1 minute
      ...cfg,
    });

    // Register Lua script once on startup and memoise its SHA for later EVALSHA calls.
    this.luaShaPromise = this.registerLuaScript();
  }

  // -------------------------------------------------------------------------------------------
  //  PUBLIC API
  // -------------------------------------------------------------------------------------------

  /**
   * Attempts to consume N tokens from the subject's bucket.
   *
   * @param subjectKey – canonical identifier for the caller (user ID, IP address, etc.).
   * @param cost       – tokens to consume; defaults to 1.
   *
   * @returns remaining tokens if successful.
   * @throws  RateLimitExceededError if there are insufficient tokens.
   */
  public async consume(subjectKey: string, cost = 1): Promise<number> {
    if (!subjectKey) {
      // We cannot rate limit without a key—allow traffic but emit a warning.
      this.emit('warning', new Error('RateLimiter.consume(): subjectKey was falsy'));
      return this.cfg.bucketSize;
    }

    // Use Redis token bucket.
    try {
      const now = Date.now();
      const sha = await this.luaShaPromise;

      const [tokensRemaining, retryAfterMs] = (await this.redis.evalSha(
        sha,
        {
          keys: [`rate_limit:${subjectKey}`],
          arguments: [
            this.cfg.bucketSize,
            this.cfg.refillRate,
            this.cfg.refillPeriod,
            cost,
            now,
          ],
        }
      )) as [number, number];

      if (tokensRemaining < 0) {
        throw new RateLimitExceededError(
          `Rate limit exceeded for key ${subjectKey}`,
          retryAfterMs
        );
      }

      // Emit metrics for observability.
      this.emit('consume', {
        subjectKey,
        tokensRemaining,
        cost,
        name: this.cfg.name,
      });

      return tokensRemaining;
    } catch (err: any) {
      if (err instanceof RateLimitExceededError) {
        this.emit('blocked', { subjectKey });
        throw err;
      }

      // Redis failure fallback—gracefully allow traffic while alerting ops.
      this.emit('error', err);

      return this.consumeInMemory(subjectKey, cost);
    }
  }

  /**
   * Express middleware for REST endpoints.
   * Adds 'X-RateLimit-*' headers to the response.
   */
  public expressMiddleware =
    (options?: { cost?: number }): ((req: Request, res: Response, next: NextFunction) => void) =>
    async (req, res, next) => {
      const key =
        this.cfg.keyGenerator?.({ req }) ??
        // Fallback—authenticated user id or client IP.
        (req as any).user?.id ??
        req.ip;

      try {
        const tokensRemaining = await this.consume(key, options?.cost ?? 1);
        this.decorateResponseHeaders(res, tokensRemaining);
        next();
      } catch (err) {
        if (err instanceof RateLimitExceededError) {
          res.setHeader('Retry-After', Math.ceil(err.retryAfter / 1000));
          res.status(429).json({ error: 'Too Many Requests' });
          return;
        }
        next(err);
      }
    };

  /**
   * Apollo Server plugin for GraphQL.
   * Rejects requests pre-execution if the caller exceeds rate limit.
   */
  public apolloPlugin = (options?: { cost?: (request: GraphQLRequestContext) => number }): ApolloServerPlugin => {
    const costFn =
      options?.cost ??
      (() => 1);

    return {
      async requestDidStart(requestCtx) {
        const key =
          this.cfg.keyGenerator?.({ graphContext: requestCtx.context ?? {} }) ??
          (requestCtx.context as any).user?.id ??
          requestCtx.request.http?.headers.get('x-forwarded-for') ??
          requestCtx.request.http?.headers.get('x-real-ip');

        try {
          await (async () => {
            const cost = costFn(requestCtx);
            await this.consume(key ?? 'anonymous', cost);
          })();
        } catch (err) {
          if (err instanceof RateLimitExceededError) {
            throw err;
          }
          // Propagate other errors so Apollo can capture them.
          throw err;
        }
      },
    };
  };

  // -------------------------------------------------------------------------------------------
  //  PRIVATE HELPERS
  // -------------------------------------------------------------------------------------------

  /**
   * Decorates rate limit response headers per RFC 6585.
   */
  private decorateResponseHeaders(res: Response, tokensRemaining: number) {
    res.setHeader('X-RateLimit-Remaining', tokensRemaining);
    res.setHeader('X-RateLimit-Limit', this.cfg.bucketSize);
    // Optional: You may include reset time, but this requires extra info from Lua script.
  }

  /**
   * Registers the Lua script used for token bucket enforcement and returns its SHA.
   *
   * Lua Script contract:
   *   KEYS[1]   –   key
   *   ARGV[1]   –   bucketSize
   *   ARGV[2]   –   refillRate
   *   ARGV[3]   –   refillPeriod
   *   ARGV[4]   –   cost
   *   ARGV[5]   –   now (ms since epoch)
   *
   * Returns:
   *   {tokensRemaining, retryAfterMs}
   */
  private async registerLuaScript(): Promise<string> {
    const script = `
      local key           = KEYS[1]
      local bucketSize    = tonumber(ARGV[1])
      local refillRate    = tonumber(ARGV[2])
      local refillPeriod  = tonumber(ARGV[3])
      local cost          = tonumber(ARGV[4])
      local now           = tonumber(ARGV[5])

      local data = redis.call('HMGET', key, 'tokens', 'timestamp')
      local tokens = tonumber(data[1])
      local timestamp = tonumber(data[2])

      if tokens == nil then
        tokens = bucketSize
        timestamp = now
      end

      local delta = math.max(0, now - timestamp)
      local tokensToAdd = math.floor(delta / refillPeriod) * refillRate
      tokens = math.min(bucketSize, tokens + tokensToAdd)
      timestamp = timestamp + math.floor(delta / refillPeriod) * refillPeriod

      local retryAfter = 0
      if tokens >= cost then
        tokens = tokens - cost
      else
        retryAfter = refillPeriod - (now - timestamp)
      end

      redis.call('HMSET', key, 'tokens', tokens, 'timestamp', timestamp)
      redis.call('PEXPIRE', key, refillPeriod * 2)

      return { tokens >= cost and tokens or -1, retryAfter }
    `;

    try {
      return await this.redis.scriptLoad(script);
    } catch (err) {
      // Fallback—not ideal, but ensures process boot doesn't fail.
      this.emit('error', err);
      return '';
    }
  }

  /**
   * Basic in-memory fallback, safe for single-node deployments or when Redis is unavailable.
   * This algorithm is naive (non-persistent and unsafe across clusters) but ensures
   * we never fully switch off rate limiting.
   */
  private inMemoryBuckets: Map<string, RedisBucket> = new Map();

  private async consumeInMemory(subjectKey: string, cost = 1): Promise<number> {
    const now = Date.now();
    const bucket = this.inMemoryBuckets.get(subjectKey) ?? {
      tokens: this.cfg.bucketSize,
      timestamp: now,
    };

    const delta = now - bucket.timestamp;
    const tokensToAdd = Math.floor(delta / this.cfg.refillPeriod) * this.cfg.refillRate;
    bucket.tokens = Math.min(this.cfg.bucketSize, bucket.tokens + tokensToAdd);
    bucket.timestamp += Math.floor(delta / this.cfg.refillPeriod) * this.cfg.refillPeriod;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.inMemoryBuckets.set(subjectKey, bucket);
      return bucket.tokens;
    }

    const retryAfter = this.cfg.refillPeriod - (now - bucket.timestamp);
    throw new RateLimitExceededError(
      `Rate limit exceeded (in-memory fallback) for key ${subjectKey}`,
      retryAfter
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Convenience factory for application bootstrap.
// ------------------------------------------------------------------------------------------------

/**
 * Returns a singleton instance to be reused across the application process.
 */
let singletonInstance: RateLimiter | undefined;

export function getRateLimiter(cfg?: Partial<RateLimiterConfig>): RateLimiter {
  if (!singletonInstance) {
    singletonInstance = new RateLimiter(undefined, cfg);
  }
  return singletonInstance;
}

/**
 * Example usage (REST):
 *
 *    import express from 'express';
 *    import { getRateLimiter } from './module_11';
 *
 *    const app = express();
 *    const rl = getRateLimiter({ bucketSize: 60 });
 *    app.use(rl.expressMiddleware());
 *
 * Example usage (GraphQL):
 *
 *    import { ApolloServer } from 'apollo-server-express';
 *    import { getRateLimiter } from './module_11';
 *
 *    const rl = getRateLimiter();
 *    const server = new ApolloServer({
 *      schema,
 *      plugins: [rl.apolloPlugin()],
 *    });
 *
 **************************************************************************************************/
```