```typescript
/**
 * SocialPulse Gateway – Adaptive, pluggable rate-limiter middleware
 * ---------------------------------------------------------------
 * Layer      : Infrastructure > Middleware
 * Purpose    : Guard public-facing REST/GraphQL endpoints against abusive traffic
 * Features   :
 *   • Supports both Fixed-Window and Sliding-Window algorithms
 *   • Built-in analytics publishing (Redis Stream) for anomaly detection
 *   • Typed, dependency-injected via TypeDI for testability/override
 *   • RFC-standard response headers (X-RateLimit-*)
 *
 * Usage:
 *   import { createRateLimiterMiddleware } from './module_53';
 *   app.use(createRateLimiterMiddleware({ windowInSeconds: 60, limit: 100 }));
 */

import { Request, Response, NextFunction } from 'express';
import { Service, Inject, Token } from 'typedi';
import Redis, { Redis as RedisClient } from 'ioredis';
import winston from 'winston';
import crypto from 'crypto';

/* -------------------------------------------------------------------------- */
/*                              Injection Tokens                              */
/* -------------------------------------------------------------------------- */

export const REDIS_CLIENT_TOKEN = new Token<RedisClient>('REDIS_CLIENT');
export const LOGGER_TOKEN = new Token<winston.Logger>('LOGGER');

/* -------------------------------------------------------------------------- */
/*                               Type Declarations                            */
/* -------------------------------------------------------------------------- */

export interface RateLimiterOptions {
  /** Max requests allowed within the window */
  limit: number;
  /** Size of the window (seconds) */
  windowInSeconds: number;
  /**
   * Strategy to use; default = SLIDING_WINDOW for smoother UX
   * FIXED_WINDOW: naive counter reset at each window boundary
   * SLIDING_WINDOW: log timestamps & count those within window
   */
  strategy?: 'FIXED_WINDOW' | 'SLIDING_WINDOW';
  /** Prefix for redis keys; helps isolate env or service */
  keyPrefix?: string;
  /** If true, analytics events are pushed onto Redis stream */
  publishAnalytics?: boolean;
}

type StrategyImpl = (
  redis: RedisClient,
  redisKey: string,
  opts: RateLimiterOptions
) => Promise<{ remaining: number; reset: number }>;

/* -------------------------------------------------------------------------- */
/*                        Strategy – Fixed Window Counter                     */
/* -------------------------------------------------------------------------- */

const fixedWindowStrategy: StrategyImpl = async (
  redis,
  redisKey,
  { limit, windowInSeconds }
) => {
  const ttl = windowInSeconds;
  const [count] = await redis
    .multi()
    .incr(redisKey)
    .expire(redisKey, ttl)
    .exec();

  // ioredis multi() returns [ [ null, result ] ]
  const current = (count?.[1] as number) ?? 0;
  const remaining = Math.max(limit - current, 0);

  // Reset is now + ttl (optimistic; exact reset may be lower if already existing TTL)
  const resetEpoch = Math.floor(Date.now() / 1000) + ttl;

  return { remaining, reset: resetEpoch };
};

/* -------------------------------------------------------------------------- */
/*                       Strategy – Sliding Window Log                        */
/* -------------------------------------------------------------------------- */

const slidingWindowStrategy: StrategyImpl = async (
  redis,
  redisKey,
  { limit, windowInSeconds }
) => {
  const now = Date.now();
  const minTimestamp = now - windowInSeconds * 1000;

  // Remove outdated entries & add current timestamp
  const tx = redis.multi();
  tx.zremrangebyscore(redisKey, 0, minTimestamp);
  tx.zadd(redisKey, String(now), String(now));
  tx.zcard(redisKey);
  tx.expire(redisKey, windowInSeconds);

  const execRes = await tx.exec();
  // ExecRes = [ [err,null], [err,null], [err,card], ... ]
  const card = (execRes[2]?.[1] as number) ?? 0;
  const remaining = Math.max(limit - card, 0);

  // Determine reset – when the earliest timestamp will fall out
  const earliestTimestampRes = await redis.zrange(redisKey, 0, 0);
  const earliestTs = earliestTimestampRes.length
    ? parseInt(earliestTimestampRes[0], 10)
    : now;

  const resetEpoch = Math.floor((earliestTs + windowInSeconds * 1000) / 1000);

  return { remaining, reset: resetEpoch };
};

/* -------------------------------------------------------------------------- */
/*                        AdaptiveRateLimiter Service                         */
/* -------------------------------------------------------------------------- */

@Service()
export class AdaptiveRateLimiter {
  private readonly keyPrefix: string;
  private readonly strategyImpl: StrategyImpl;

  constructor(
    @Inject(REDIS_CLIENT_TOKEN) private readonly redis: RedisClient,
    @Inject(LOGGER_TOKEN) private readonly logger: winston.Logger,
    private readonly opts: RateLimiterOptions
  ) {
    this.keyPrefix = opts.keyPrefix ?? 'rl';
    this.strategyImpl =
      opts.strategy === 'FIXED_WINDOW'
        ? fixedWindowStrategy
        : slidingWindowStrategy;
  }

  /**
   * Core execution logic (algorithm-agnostic)
   */
  async evaluate(request: Request): Promise<{
    remaining: number;
    reset: number;
  }> {
    const redisKey = this.buildRedisKey(request);
    return this.strategyImpl(this.redis, redisKey, this.opts);
  }

  async publishAnalytics(
    request: Request,
    state: { remaining: number; reset: number }
  ): Promise<void> {
    if (!this.opts.publishAnalytics) return;

    try {
      await this.redis.xadd(
        'rate_limit_events',
        '*',
        'ip',
        request.ip,
        'userId',
        String(this.getUserId(request) ?? 'anonymous'),
        'route',
        request.originalUrl,
        'remaining',
        String(state.remaining),
        'reset',
        String(state.reset)
      );
    } catch (err) {
      this.logger.warn('Failed to push rate-limit analytics', {
        err,
        route: request.originalUrl,
      });
    }
  }

  private buildRedisKey(request: Request): string {
    const identifier = this.getUserId(request) ?? this.hashIp(request.ip);
    return `${this.keyPrefix}:${identifier}`;
  }

  /**
   * Uses session/user identifier if available, else null.
   * Extensible: plug in auth middleware to populate req.user.
   */
  private getUserId(request: Request): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (request as any).user as { id?: string } | undefined;
    return user?.id ?? null;
  }

  private hashIp(ip: string): string {
    return crypto.createHash('sha1').update(ip).digest('hex');
  }
}

/* -------------------------------------------------------------------------- */
/*                       Express Middleware Factory                           */
/* -------------------------------------------------------------------------- */

/**
 * Creates an Express middleware instance with injected dependencies.
 * NOTE: Intended to be registered high in the middleware stack
 */
export function createRateLimiterMiddleware(
  opts: RateLimiterOptions
): (req: Request, res: Response, next: NextFunction) => void {
  if (!opts.limit || !opts.windowInSeconds) {
    throw new Error('RateLimiterOptions.limit & windowInSeconds are mandatory');
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    // Retrieve DI container scoped per request or the global one
    const container = (req as any).container ?? Service;
    const limiter = container.get(AdaptiveRateLimiter, [opts]);

    try {
      const state = await limiter.evaluate(req);

      // Attach rate-limit headers (RFC 6585)
      res.setHeader('X-RateLimit-Limit', opts.limit);
      res.setHeader('X-RateLimit-Remaining', state.remaining);
      res.setHeader('X-RateLimit-Reset', state.reset);

      // Publish analytics asynchronously (fire & forget)
      void limiter.publishAnalytics(req, state);

      if (state.remaining <= 0) {
        limiter['logger'].info('Rate limit exceeded', {
          ip: req.ip,
          route: req.originalUrl,
        });

        return res.status(429).json({
          error: 'RATE_LIMIT_EXCEEDED',
          message: `You have exceeded the request limit of ${opts.limit} within ${opts.windowInSeconds}s`,
        });
      }

      return next();
    } catch (err) {
      const logger: winston.Logger = container.get(LOGGER_TOKEN);
      logger.error('Rate limiter internal error', { err });

      // Graceful degradation: allow request rather than fail closed
      return next();
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                          Default Dependency Setup                          */
/* -------------------------------------------------------------------------- */

/**
 * The following is a convenience initializer for typical production
 * deployments. In tests, mocks can be registered against the DI container.
 */
(function bootstrapDefaultDependencies() {
  const globalContainer = Service;

  // Redis singleton (reuse if already registered)
  if (!globalContainer.has(REDIS_CLIENT_TOKEN)) {
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
    globalContainer.set(
      REDIS_CLIENT_TOKEN,
      new Redis(redisUrl, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      })
    );
  }

  if (!globalContainer.has(LOGGER_TOKEN)) {
    const logger = winston.createLogger({
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
      transports: [new winston.transports.Console()],
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple()
      ),
    });
    globalContainer.set(LOGGER_TOKEN, logger);
  }
})();
```