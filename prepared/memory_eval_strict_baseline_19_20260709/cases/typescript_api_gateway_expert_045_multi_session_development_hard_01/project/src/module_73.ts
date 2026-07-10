```typescript
/**************************************************************************************************
 *  SocialPulse Gateway – Behavioral Rate-Limiting & Abuse-Detection Module
 *  File:          src/module_73.ts
 *  Description:   Centralised behavioural rate-limiter backed by Redis that throttles requests
 *                 based on action-type (follow, like, message, etc.) and user reputation score.
 *                 Designed to mitigate abusive patterns such as follow-spam or message floods.
 *
 *  Layer:         Infrastructure → Adapters
 *
 *  Public API:
 *     ‑ BehavioralRateLimiter          (class)
 *     ‑ ActionType                     (enum)
 *     ‑ BehavioralRateLimiterOptions   (interface)
 *
 *  Usage (Express middleware example):
 *     const limiter = new BehavioralRateLimiter({ redis, logger });
 *     app.post('/api/v1/follow', limiter.guard(ActionType.FOLLOW), followController);
 *
 **************************************************************************************************/

import { promisify } from 'util';
import { EventEmitter } from 'events';
import semver from 'semver';
import pino, { Logger } from 'pino';
import Redis, { Redis as RedisClient } from 'ioredis';

/* ======================================= *
 *            Shared Type-Aliases          *
 * ======================================= */

export enum ActionType {
  FOLLOW = 'FOLLOW',
  LIKE = 'LIKE',
  MESSAGE = 'MESSAGE',
  COMMENT = 'COMMENT',
  LOGIN = 'LOGIN',
}

export interface BehavioralRateLimiterOptions {
  redis: RedisClient;
  logger?: Logger;
  /**
   * slidingWindow: evaluation window (in seconds)
   * limit:         maximum number of events allowed in the window
   */
  rules?: Partial<Record<ActionType, { slidingWindow: number; limit: number }>>;
  /**
   * Minimum semver client version that can bypass strict limits, e.g. mobile apps > 3.2.0
   */
  clientVersionExemption?: string;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds?: number;
}

/* ======================================= *
 *   Low-level Sliding-Window Limiter      *
 * ======================================= */

class SlidingWindowLimiter {
  private redis: RedisClient;
  private logger: Logger;

  constructor(redis: RedisClient, logger: Logger) {
    this.redis = redis;
    this.logger = logger;
  }

  /**
   * Increments the counter for the (key, window) pair and returns the new total count.
   * Implemented using Redis INCR + EXPIRE for atomicity and efficiency.
   */
  public async bump(
    key: string,
    windowSeconds: number,
  ): Promise<{ total: number; remainingTtl: number }> {
    // Pipeline for atomicity
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.ttl(key);
    pipeline.expire(key, windowSeconds);
    const [incrRes, ttlRes] = (await pipeline.exec()) as [any, any];

    const total = incrRes[1] as number;
    const ttl = ttlRes[1] as number;

    // ttl could be ‑2 (key does not exist) or ‑1 (no expiry) -> reset expiry
    const remainingTtl = ttl > 0 ? ttl : windowSeconds;

    this.logger.debug({ key, total, remainingTtl }, 'SlidingWindowLimiter.bump');
    return { total, remainingTtl };
  }
}

/* ======================================= *
 *          Behavior Analytics             *
 * ======================================= */

class BehaviorAnalyticsService extends EventEmitter {
  private redis: RedisClient;
  private logger: Logger;

  constructor(redis: RedisClient, logger: Logger) {
    super();
    this.redis = redis;
    this.logger = logger.child({ module: 'BehaviorAnalyticsService' });
  }

  /**
   * Computes a simple user reputation score based on historical abuse flags.
   * More sophisticated ML models could be plugged here.
   */
  public async getReputationScore(userId: string): Promise<number> {
    const score = await this.redis.get(`user:reputation:${userId}`);
    return score ? parseInt(score, 10) : 100; // default neutral score
  }

  /**
   * Penalises reputation when abuse is detected.
   */
  public async penalise(userId: string, delta: number): Promise<void> {
    const key = `user:reputation:${userId}`;
    await this.redis.decrby(key, delta);
    await this.redis.expire(key, 60 * 60 * 24 * 7); // decay after 1 week
    this.emit('reputation:changed', { userId, delta: -delta });
  }
}

/* ======================================= *
 *        High-level Behaviour Limiter     *
 * ======================================= */

export class BehavioralRateLimiter {
  private limiter: SlidingWindowLimiter;
  private analytics: BehaviorAnalyticsService;
  private logger: Logger;
  private rules: Required<BehavioralRateLimiterOptions>['rules'];
  private clientVersionExemption?: string;

  constructor(opts: BehavioralRateLimiterOptions) {
    if (!opts?.redis) {
      throw new Error('BehavioralRateLimiter requires a connected Redis instance.');
    }

    this.logger = (opts.logger ?? pino()).child({ module: 'BehavioralRateLimiter' });
    this.limiter = new SlidingWindowLimiter(opts.redis, this.logger);
    this.analytics = new BehaviorAnalyticsService(opts.redis, this.logger);

    // Default anti-spam thresholds; tuned for social-network dynamics
    this.rules = {
      [ActionType.FOLLOW]: { slidingWindow: 60, limit: 30 },  // 30 follows / min
      [ActionType.LIKE]: { slidingWindow: 10, limit: 50 },    // 50 likes / 10 sec
      [ActionType.MESSAGE]: { slidingWindow: 60, limit: 20 }, // 20 DMs / min
      [ActionType.COMMENT]: { slidingWindow: 60, limit: 40 }, // 40 comments / min
      [ActionType.LOGIN]: { slidingWindow: 300, limit: 15 },  // 15 logins / 5 min
      ...opts.rules,
    } as Required<BehavioralRateLimiterOptions>['rules'];

    this.clientVersionExemption = opts.clientVersionExemption;
  }

  /* ---------------------------------------------------------------------- *
   *  Express / Fastify-style middleware to guard endpoints.
   * ---------------------------------------------------------------------- */

  public guard(action: ActionType) {
    return async (req: any, res: any, next: any) => {
      try {
        const userId = this.extractUserId(req);
        const clientVersion = req.headers['x-client-version'] as string | undefined;

        // Early exit when client version is whitelisted
        if (
          this.clientVersionExemption &&
          clientVersion &&
          semver.gte(clientVersion, this.clientVersionExemption)
        ) {
          return next();
        }

        const decision = await this.check(action, userId);
        res.setHeader('X-RateLimit-Remaining', decision.remaining);
        if (!decision.allowed) {
          res.setHeader('Retry-After', decision.retryAfterSeconds ?? 0);
          return res.status(429).json({
            error: 'Too many requests',
            action,
            retryAfterSeconds: decision.retryAfterSeconds,
          });
        }

        return next();
      } catch (err) {
        this.logger.error({ err }, 'Error inside BehavioralRateLimiter.guard');
        return res.status(500).json({ error: 'Internal Server Error' });
      }
    };
  }

  /* ---------------------------------------------------------------------- *
   *  Core decision algorithm – can be used outside middleware as well
   * ---------------------------------------------------------------------- */

  public async check(action: ActionType, userId: string): Promise<RateLimitDecision> {
    const rule = this.rules[action];
    const repScore = await this.analytics.getReputationScore(userId);

    // Low reputation → dynamically tighten thresholds by up to 50%
    const dynamicLimit =
      repScore >= 100 ? rule.limit : Math.max(1, Math.floor(rule.limit * (repScore / 200)));

    const key = `rl:${userId}:${action}`;
    const { total, remainingTtl } = await this.limiter.bump(key, rule.slidingWindow);

    const allowed = total <= dynamicLimit;
    const remaining = Math.max(0, dynamicLimit - total);

    if (!allowed) {
      // Penalise reputation slightly for every breach
      await this.analytics.penalise(userId, 1);
    }

    this.logger.debug(
      { userId, action, total, dynamicLimit, allowed },
      'BehavioralRateLimiter.check',
    );

    return {
      allowed,
      remaining,
      retryAfterSeconds: !allowed ? remainingTtl : undefined,
    };
  }

  /* ---------------------------------------------------------------------- *
   *  Helper(s)
   * ---------------------------------------------------------------------- */

  private extractUserId(req: any): string {
    if (req.user?.id) return String(req.user.id);
    if (req.headers['x-user-id']) return String(req.headers['x-user-id']);

    throw new Error('BehavioralRateLimiter: unable to resolve user identifier from request.');
  }
}

/* ======================================= *
 *               Health Probe              *
 * ======================================= */

/**
 * Lightweight readiness probe to ensure Redis connectivity and internal state are healthy.
 * Can be wired into /healthz.
 */
export async function rateLimiterHealthProbe(
  redis: RedisClient,
): Promise<{ status: 'ok' | 'error'; message?: string }> {
  try {
    const ping = await redis.ping();
    if (ping !== 'PONG') {
      return { status: 'error', message: 'Unexpected PING response from Redis' };
    }
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}
```