```typescript
/***************************************************************************************************
 * File:        src/module_76.ts
 * Project:     SocialPulse Gateway (api_gateway)
 * Description: Adaptive, behavior-aware rate-limiter intended to guard REST & GraphQL entry points
 *              against abusive patterns (e.g. follow-spam, message floods).  Implements a
 *              distributed token-bucket algorithm backed by Redis, with an in-memory fallback for
 *              non-critical paths or degraded modes.
 *
 * Key Points
 *  - Version-aware → separate quota per public API version (v1, v2 …)
 *  - Identity heuristics → user-id preferred, then API-key, finally IP
 *  - Burst window & sustained rate controls
 *  - Prometheus-compatible metrics, structured logs
 *  - Express / Apollo Server middleware factory
 *
 * NOTE:
 *  External modules prefixed with @socialpulse/… are part of the gateway’s internal mono-repo.
 **************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { createHash } from 'crypto';

import { Logger } from '@socialpulse/logging';
import { Counter, Histogram } from '@socialpulse/observability'; // Prometheus façade

/* -------------------------------------------------------------------------------------------------
 * Types & Interfaces
 * -----------------------------------------------------------------------------------------------*/

/**
 * Functional options for the adaptive rate limiter.
 */
export interface RateLimiterOptions {
  /**
   * Max sustained requests per second.
   */
  readonly rps: number;

  /**
   * Maximum burst capacity (tokens).
   */
  readonly burst: number;

  /**
   * Time-to-live for Redis keys (seconds).  Should exceed worst-case bucket drain time by a margin.
   */
  readonly ttlSeconds: number;

  /**
   * If true, allow in-memory fallback when Redis is unavailable.
   */
  readonly allowMemoryFallback: boolean;

  /**
   * Function used to extract a stable identity from request.
   * Return undefined to skip rate limiting for the request.
   */
  readonly identityResolver?: (req: Request) => string | undefined;

  /**
   * Optional name for logging/metrics.  Defaults to "global".
   */
  readonly name?: string;
}

/**
 * Contract for a token bucket implementation.
 */
interface TokenBucket {
  /**
   * Attempt to consume a single token.
   * Returns milliseconds until next token is available (0 if granted).
   */
  consume(identity: string): Promise<number>;
}

/**
 * Custom gateway error returned when rate limit is exceeded.
 */
export class RateLimitError extends Error {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Redis-backed token bucket
 * -----------------------------------------------------------------------------------------------*/

const LUA_TOKEN_BUCKET = `
  --[[
    KEYS[1] - bucket key
    ARGV[1] - now (ms)
    ARGV[2] - rps
    ARGV[3] - burst
    ARGV[4] - ttl
  ]]
  local bucket = redis.call("HMGET", KEYS[1], "tokens", "last")
  local tokens = tonumber(bucket[1]) or tonumber(ARGV[3])
  local last   = tonumber(bucket[2]) or tonumber(ARGV[1])
  local now    = tonumber(ARGV[1])
  local rps    = tonumber(ARGV[2])
  local burst  = tonumber(ARGV[3])

  -- replenish
  local elapsed = math.max(0, now - last)
  tokens = math.min(burst, tokens + (elapsed * rps) / 1000)

  local granted = 0
  if tokens >= 1 then
    tokens = tokens - 1
    granted = 1
  end

  redis.call("HMSET", KEYS[1], "tokens", tokens, "last", now)
  redis.call("PEXPIRE", KEYS[1], ARGV[4])

  return { granted, tokens }
`;

class RedisTokenBucket implements TokenBucket {
  private readonly redis: Redis;
  private readonly rps: number;
  private readonly burst: number;
  private readonly ttlMillis: number;
  private readonly name: string;

  constructor(redis: Redis, opts: Required<RateLimiterOptions>) {
    this.redis = redis;
    this.rps = opts.rps;
    this.burst = opts.burst;
    this.ttlMillis = opts.ttlSeconds * 1000;
    this.name = opts.name ?? 'global';
  }

  public async consume(identity: string): Promise<number> {
    const now = Date.now();
    const key = `sp:ratelimit:${this.name}:${identity}`;
    const [granted, tokens] = (await this.redis.eval(
      LUA_TOKEN_BUCKET,
      1,
      key,
      now,
      this.rps,
      this.burst,
      this.ttlMillis,
    )) as [number, number];

    if (granted === 1) {
      return 0;
    }

    // Compute time until next token
    const msPerToken = 1000 / this.rps;
    const retryAfter = Math.ceil(msPerToken * (1 - tokens));
    return retryAfter;
  }
}

/* -------------------------------------------------------------------------------------------------
 * In-Memory fallback
 * -----------------------------------------------------------------------------------------------*/

interface BucketState {
  last: number;
  tokens: number;
}

class InMemoryTokenBucket implements TokenBucket {
  private readonly state: Map<string, BucketState> = new Map();
  private readonly rps: number;
  private readonly burst: number;
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(opts: Required<RateLimiterOptions>) {
    this.rps = opts.rps;
    this.burst = opts.burst;

    // Periodic cleanup of stale buckets to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const ttl = opts.ttlSeconds * 1000;
      for (const [key, bucket] of this.state) {
        if (now - bucket.last > ttl) {
          this.state.delete(key);
        }
      }
    }, 30_000).unref(); // Do not block process exit
  }

  public async consume(identity: string): Promise<number> {
    const now = Date.now();
    const bucket = this.state.get(identity) ?? {
      last: now,
      tokens: this.burst,
    };

    // Refill
    const elapsed = Math.max(0, now - bucket.last);
    bucket.tokens = Math.min(
      this.burst,
      bucket.tokens + (elapsed * this.rps) / 1000,
    );
    bucket.last = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.state.set(identity, bucket);
      return 0;
    }

    this.state.set(identity, bucket);
    const msPerToken = 1000 / this.rps;
    return Math.ceil(msPerToken * (1 - bucket.tokens));
  }

  public dispose(): void {
    clearInterval(this.cleanupInterval);
  }
}

/* -------------------------------------------------------------------------------------------------
 * AdaptiveRateLimiter facade
 * -----------------------------------------------------------------------------------------------*/

export class AdaptiveRateLimiter {
  private readonly bucket: TokenBucket;
  private readonly identityResolver: (req: Request) => string | undefined;
  private readonly name: string;
  private static readonly logger = new Logger('AdaptiveRateLimiter');

  // Metrics
  private readonly metricAllowed: Counter;
  private readonly metricRejected: Counter;
  private readonly metricLatency: Histogram;

  constructor(
    redis: Redis | undefined,
    opts: RateLimiterOptions,
  ) {
    const defaults = {
      identityResolver: AdaptiveRateLimiter.defaultIdentityResolver,
      allowMemoryFallback: true,
      name: 'global',
    };

    const merged: Required<RateLimiterOptions> = {
      ...defaults,
      ...opts,
    };

    this.name = merged.name;
    this.identityResolver = merged.identityResolver;

    if (redis) {
      this.bucket = new RedisTokenBucket(redis, merged);
    } else if (merged.allowMemoryFallback) {
      AdaptiveRateLimiter.logger.warn(
        `Redis unavailable, falling back to in-memory token bucket for limiter '${merged.name}'.`,
      );
      this.bucket = new InMemoryTokenBucket(merged);
    } else {
      throw new Error(
        `Rate limiter '${merged.name}' requires Redis but none was provided.`,
      );
    }

    // Metrics
    this.metricAllowed = Counter.get(
      `sp_rate_limit_allowed_total{limiter="${this.name}"}`,
    );
    this.metricRejected = Counter.get(
      `sp_rate_limit_rejected_total{limiter="${this.name}"}`,
    );
    this.metricLatency = Histogram.get(
      `sp_rate_limit_latency_ms{limiter="${this.name}"}`,
      [10, 25, 50, 100, 250, 500, 1000],
    );
  }

  /**
   * Express-compatible middleware.  Usage:
   *
   *   app.use(rateLimiter.middleware()) // global
   *   app.get('/v2/timeline', rateLimiter.middleware('timeline_v2'), timelineHandler)
   */
  public middleware(
    overrideName?: string,
  ): (req: Request, res: Response, next: NextFunction) => void {
    const limiter = overrideName ? this.cloneWithName(overrideName) : this;
    return async (req, _res, next) => {
      const stop = limiter.metricLatency.startTimer();
      try {
        await limiter.handle(req);
        stop();
        next();
      } catch (err) {
        stop();
        next(err);
      }
    };
  }

  /**
   * Core handler used by middleware & programmatic checks (e.g., WebSocket).
   * Throws RateLimitError if quota is exhausted.
   */
  public async handle(req: Request): Promise<void> {
    const identity = this.identityResolver(req);
    if (!identity) {
      // Bypass
      return;
    }

    const retryAfter = await this.bucket.consume(identity);
    if (retryAfter === 0) {
      this.metricAllowed.inc();
      return;
    }

    this.metricRejected.inc();
    AdaptiveRateLimiter.logger.debug(
      {
        limiter: this.name,
        identity,
        retryAfter,
      },
      'Rate limit exceeded',
    );

    throw new RateLimitError(
      `Too many requests. Retry after ${retryAfter}ms.`,
      retryAfter,
    );
  }

  /**
   * Clone the limiter but with a different name (used for per-route quotas).
   */
  private cloneWithName(name: string): AdaptiveRateLimiter {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    return new AdaptiveRateLimiter(
      ('redis' in (this.bucket as any) ? (this.bucket as any).redis : undefined),
      {
        ...this.getOptions(),
        name,
      },
    );
  }

  private getOptions(): RateLimiterOptions {
    // Reflection back to options for clone; could be improved by storing opts passed in ctor.
    const bucket: any = this.bucket;
    return {
      rps: bucket.rps,
      burst: bucket.burst,
      ttlSeconds: bucket.ttlMillis
        ? bucket.ttlMillis / 1000
        : 60,
      allowMemoryFallback: bucket instanceof InMemoryTokenBucket,
      identityResolver: this.identityResolver,
      name: this.name,
    };
  }

  /**
   * Default identity resolver:
   *   1. `req.user.id` (populated by auth middleware)
   *   2. `x-api-key` header (for service clients)
   *   3. SHA-1(IP) for anonymous traffic
   * Returns undefined to bypass rate limiting (e.g., admin users).
   */
  private static defaultIdentityResolver(req: Request): string | undefined {
    // Skip GraphQL introspection queries
    if (
      req.method === 'POST' &&
      req.path === '/graphql' &&
      req.body?.operationName === 'IntrospectionQuery'
    ) {
      return undefined;
    }

    // 1. Authenticated user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId: string | undefined = (req as any).user?.id;
    if (userId) {
      return `u:${userId}`;
    }

    // 2. API key
    const apiKey = req.header('x-api-key');
    if (apiKey) {
      return `k:${apiKey}`;
    }

    // 3. IP
    const ip = req.ip || req.connection.remoteAddress;
    if (ip) {
      // Hash to avoid leaking raw IP in Redis
      const hashedIp = createHash('sha1').update(ip).digest('hex');
      return `ip:${hashedIp}`;
    }

    return undefined;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Express error handler helper
 * -----------------------------------------------------------------------------------------------*/

/**
 * Translates RateLimitError to HTTP 429 response.
 */
export function rateLimitErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof RateLimitError) {
    res
      .status(429)
      .set({
        'Retry-After': (err.retryAfterMs / 1000).toFixed(0),
        'X-RateLimit-Reason': 'quota_exceeded',
      })
      .json({
        error: 'Too many requests',
        retryAfterMs: err.retryAfterMs,
      });
  } else {
    next(err);
  }
}

/* -------------------------------------------------------------------------------------------------
 * Example initialization (would normally live in a DI container / bootstrapping module)
 * -----------------------------------------------------------------------------------------------*/

// Create shared Redis client; in real code loaded from shared infrastructure layer
const redisClient = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

// Global limiter: 30 RPS sustained, burst of 60 requests, 60s TTL
export const globalRateLimiter = new AdaptiveRateLimiter(redisClient, {
  rps: 30,
  burst: 60,
  ttlSeconds: 60,
  allowMemoryFallback: true,
  name: 'global',
});
```