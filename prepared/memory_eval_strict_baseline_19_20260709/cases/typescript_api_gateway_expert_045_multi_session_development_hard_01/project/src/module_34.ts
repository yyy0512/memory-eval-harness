```typescript
/**
 * SocialPulse Gateway – Behavioral Analytics / Anti-Abuse Module
 * ---------------------------------------------------------------
 * File:        src/module_34.ts
 * Description: Centralised behavioural analytics guard used by the
 *              request-rate-limiting and safety middleware layers.
 *              It records user actions (follow, message, like…) into
 *              Redis-backed sliding windows and evaluates whether the
 *              behaviour exceeds configurable abuse thresholds.
 *
 *              The service:
 *               • Is stateless from the caller’s perspective
 *               • Leverages Redis ZSETs for O(log N) inserts & queries
 *               • Emits structured logs for observability
 *               • Surfaces typed domain outcomes that upper layers
 *                 (controllers, GraphQL resolvers, etc.) can enforce.
 *
 * Usage:
 *  const analytics = container.resolve(BehaviorAnalyticsService);
 *  const evaluation = await analytics.recordAction(userId, 'FOLLOW');
 *  if (!evaluation.allowed) throw new TooManyRequestsError(evaluation);
 *
 * Author: SocialPulse Engineering
 */

import { injectable, inject } from 'inversify';
import { Logger } from '@socialpulse/shared/logger';
import { Redis } from 'ioredis';
import { v4 as uuid } from 'uuid';

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Domain Types
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Enumerates all user-initiated social actions that are monitored
 * by the behavioural analytics subsystem.
 */
export enum BehaviorAction {
  FOLLOW = 'FOLLOW',
  MESSAGE = 'MESSAGE',
  COMMENT = 'COMMENT',
  POST = 'POST',
  LIKE = 'LIKE',
}

/**
 * Outcome returned to callers after recording / evaluating an action.
 */
export interface BehaviorEvaluationResult {
  /** Whether the action is allowed to proceed. */
  allowed: boolean;
  /** Optional human-readable reason (e.g. ‘FOLLOW_RATE_LIMIT_EXCEEDED’). */
  reason?: string;
  /** Aggregate score for the user (0 = benign, >100 = definitely abusive). */
  userScore: number;
  /** Internal correlation id for tracing across services. */
  correlationId: string;
}

/**
 * Configuration schema. Values are typically hydrated from the
 * central config service and hot-reloaded at runtime.
 */
export interface BehaviorAnalyticsConfig {
  /**
   * Action-specific maximum number of events allowed inside the
   * sliding window.
   */
  thresholds: Partial<Record<BehaviorAction, number>>;
  /**
   * Sliding-window size in seconds.
   * Example: For message flood protection we might use 60 seconds.
   */
  windowSeconds: number;
  /** When a user breaks a threshold, how long should detection
   *  increase score for (seconds). */
  penaltySeconds: number;
  /** Multiplier applied to user score on each infraction. */
  penaltyMultiplier: number;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Constants & Default Config
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

const REDIS_KEY_PREFIX = 'behavior';
const DEFAULT_CONFIG: BehaviorAnalyticsConfig = {
  thresholds: {
    [BehaviorAction.FOLLOW]: 20,   // 20 follows per window
    [BehaviorAction.MESSAGE]: 60,  // 60 messages per window
    [BehaviorAction.COMMENT]: 50,
    [BehaviorAction.POST]: 10,
    [BehaviorAction.LIKE]: 300,
  },
  windowSeconds: 60,
  penaltySeconds: 60 * 30,     // escalate for 30 minutes
  penaltyMultiplier: 5,
};

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Service
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

@injectable()
export class BehaviorAnalyticsService {
  constructor(
    @inject('Redis') private readonly redis: Redis,
    @inject('Logger') private readonly logger: Logger,
    @inject('BehaviorAnalyticsConfig') private readonly config: BehaviorAnalyticsConfig = DEFAULT_CONFIG,
  ) {}

  /**
   * Records a user action and returns evaluation result synchronously.
   *
   * This method performs three O(log N) Redis commands:
   *  1. ZADD  – Add event with timestamp
   *  2. ZREMRANGEBYSCORE – Trim events outside of window
   *  3. ZCARD – Count events in window
   *
   * Depending on the count it updates a separate ‘score’ key.
   */
  async recordAction(
    userId: string,
    action: BehaviorAction,
  ): Promise<BehaviorEvaluationResult> {
    const correlationId = uuid();
    const now = Date.now();
    const windowStart = now - this.config.windowSeconds * 1000;
    const key = this.getActionKey(userId, action);

    try {
      // 1. ZADD: add new event
      await this.redis.zadd(key, `${now}`, `${now}-${correlationId}`);

      // 2. Trim old events
      await this.redis.zremrangebyscore(key, 0, windowStart);

      // 3. Count current events
      const count = await this.redis.zcard(key);

      const threshold = this.getThreshold(action);
      const allowed = count <= threshold;

      // Update user score
      const score = await this.adjustUserScore(userId, allowed);

      // Expire key to avoid unbounded growth
      // (auto-expire after penalty window to auto clean rarely used keys)
      await this.redis.expire(key, this.config.windowSeconds + 60);

      if (!allowed) {
        // Emit structured log for SIEM
        this.logger.warn(
          { userId, action, count, threshold, correlationId, score },
          'Behavior threshold exceeded',
        );
      }

      return {
        allowed,
        reason: allowed ? undefined : `${action}_RATE_LIMIT_EXCEEDED`,
        userScore: score,
        correlationId,
      };
    } catch (err) {
      // Fail-open: If Redis is unavailable we do NOT block the user request,
      // but we record a critical log entry for immediate ops attention.
      this.logger.error(
        { err, userId, action, correlationId },
        'BehaviorAnalyticsService failed – allowing action by default',
      );

      return {
        allowed: true,
        userScore: 0,
        correlationId,
      };
    }
  }

  /**
   * Getter for the user’s current behaviour score.
   * A higher score means more suspicious activity.
   */
  async getUserScore(userId: string): Promise<number> {
    const scoreKey = this.getScoreKey(userId);
    const raw = await this.redis.get(scoreKey);
    return raw ? Number(raw) : 0;
  }

  /**
   * Completely resets stored behaviour for a user.
   * Intended for admin/customer-support tooling.
   */
  async resetUser(userId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(this.getScoreKey(userId));

    // Delete all action keys
    (Object.values(BehaviorAction) as BehaviorAction[]).forEach((action) =>
      pipeline.del(this.getActionKey(userId, action)),
    );

    await pipeline.exec();
    this.logger.info({ userId }, 'Behavior analytics reset for user');
  }

  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
  // Internal Helpers
  ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

  private getActionKey(userId: string, action: BehaviorAction): string {
    return `${REDIS_KEY_PREFIX}:${userId}:${action}`;
  }

  private getScoreKey(userId: string): string {
    return `${REDIS_KEY_PREFIX}:score:${userId}`;
  }

  /** Returns threshold or falls back to default. */
  private getThreshold(action: BehaviorAction): number {
    return (
      this.config.thresholds[action] ??
      DEFAULT_CONFIG.thresholds[action] ??
      Number.POSITIVE_INFINITY
    );
  }

  /**
   * Adjusts the user’s score based on whether the action was allowed.
   * If disallowed, score += penaltyMultiplier
   * If allowed, score decays linearly (Redis TTL).
   */
  private async adjustUserScore(
    userId: string,
    allowed: boolean,
  ): Promise<number> {
    const scoreKey = this.getScoreKey(userId);

    if (!allowed) {
      const newScore = await this.redis.incrby(
        scoreKey,
        this.config.penaltyMultiplier,
      );
      // Reset TTL
      await this.redis.expire(scoreKey, this.config.penaltySeconds);
      return newScore;
    }

    // If action allowed, decay is passive via TTL (no change).
    const current = await this.redis.get(scoreKey);
    return current ? Number(current) : 0;
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// IoC bindings (for completeness but will be overridden by the composition root)
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

// In real code this would live in an inversify module/binding file
// Here it is collocated for single-file completeness.

import container from '@socialpulse/shared/container';
import RedisClient from '@socialpulse/shared/redis';

/* istanbul ignore next – Binding is environment-specific */
(() => {
  try {
    container
      .bind<BehaviorAnalyticsService>(BehaviorAnalyticsService)
      .toSelf()
      .inSingletonScope();

    container.bind<BehaviorAnalyticsConfig>('BehaviorAnalyticsConfig').toConstantValue(
      DEFAULT_CONFIG,
    );

    if (!container.isBound('Redis')) {
      container.bind<Redis>('Redis').toConstantValue(RedisClient);
    }
  } catch (err) {
    // Ignore duplicate binding errors when hot-reloading in dev
  }
})();
```