```typescript
/**
 * SocialPulse Gateway
 * src/module_33.ts
 *
 * BehavioralAnalyticsGuard – runtime protection against abusive behaviour such as
 * follow-spam, message floods, or timeline write-storms.  Works as framework-agnostic
 * middleware that can be plugged into both REST (Express/Fastify) and GraphQL
 * resolver pipelines.
 *
 * The guard relies on Redis for a low-latency/sliding-window counter implementation
 * and applies differentiated thresholds per social action type.  When a violation is
 * detected the guard:
 *   1. Emits a structured log entry (pino)
 *   2. Publishes a domain event (e.g. to Kafka) for downstream handling
 *   3. Responds with 429 / throws a GatewayError that bubbles up the stack
 *
 * NOTE: This module purposefully avoids framework-specific types (NestJS, Apollo,
 *       Fastify, etc.) to keep coupling low—the export surface is a simple,
 *       dependency-free function returning standard (req, res, next) middleware or a
 *       scoped async `protect()` helper suitable for GraphQL resolvers.
 */

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import Redis, { Redis as RedisClient } from 'ioredis';
import pino from 'pino';

// ────────────────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────────────────

/**
 * ActionType – enumerates the high-level user-initiated activities we monitor.
 * If you introduce a new high-fan-out feature, you should add a new entry here
 * and update the threshold table down below.
 */
export enum ActionType {
  FOLLOW   = 'FOLLOW',
  MESSAGE  = 'MESSAGE',
  POST     = 'POST',
  REACTION = 'REACTION',
  LIKE     = 'LIKE',
}

/**
 * Thresholds (per action type) expressed as { windowSizeInSec, maxHits } tuple.
 * Example: A user may perform at most 15 FOLLOW actions in any rolling 60-second
 *          window before being blocked for an exponentially-increasing duration.
 *
 * Values are battle-tested on production traffic but can be made configurable at
 * runtime via dynamic config providers or admin panels.
 */
const ACTION_THRESHOLDS: Record<ActionType, { windowSize: number; maxHits: number }> = {
  [ActionType.FOLLOW]:   { windowSize: 60,  maxHits: 15 },   // anti follow-spam
  [ActionType.MESSAGE]:  { windowSize: 30,  maxHits: 25 },   // throttle DMs
  [ActionType.POST]:     { windowSize: 120, maxHits: 10 },   // timeline write storm
  [ActionType.REACTION]: { windowSize: 10,  maxHits: 50 },   // like / react spam
  [ActionType.LIKE]:     { windowSize: 10,  maxHits: 50 },
};

/**
 * Duration (seconds) the offending principal is temporarily blocked after the
 * Nth strike.  Applied via exponential back-off: ban = BASE * 2^(strike-1)
 */
const BASE_TEMP_BLOCK_SECONDS = 60;

// ────────────────────────────────────────────────────────────────────────────
// Utility Types / Interfaces
// ────────────────────────────────────────────────────────────────────────────

export interface Principal {
  id: string;            // internal user id, if authenticated
  ip: string;            // fallback id for unauthenticated requests
}

export interface GuardOptions {
  /**
   * Optional external Redis client to reuse connection pools in the gateway.
   * When omitted, the guard creates a new client using REDIS_URL env.
   */
  redis?: RedisClient;

  /**
   * Optional pino logger instance – defaults to a child of root logger.
   */
  logger?: pino.Logger;

  /**
   * Number of consecutive strikes before we additionally report to security
   * operations for manual review.
   */
  reportThreshold?: number;
}

/**
 * Lightweight domain error thrown when behavioural limits are exceeded.
 * Upstream layers map this to 429 Too Many Requests or appropriate GraphQL
 * error codes.
 */
export class RateLimitError extends Error {
  public readonly action: ActionType;
  public readonly principal: Principal;
  public readonly retryAfter: number;

  constructor(action: ActionType, principal: Principal, retryAfter: number) {
    super(`Rate limit exceeded for action=${action}, principal=${principal.id || principal.ip}`);
    this.name = 'RateLimitError';
    this.action = action;
    this.principal = principal;
    this.retryAfter = retryAfter;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sliding-Window Counter (Redis)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Implementation detail: For each request we create a Redis key of the form
 *   abuse:{action}:{principalId}
 * and store timestamped hits in a sorted set (ZSET).  The clean-up + count is
 * executed via a Lua script to keep round-trip latency low and guarantee
 * atomicity.
 */
class SlidingWindowCounter {
  private readonly redis: RedisClient;

  // Pre-loaded SHA of Lua script for faster evaluation
  private readonly scriptShaPromise: Promise<string>;

  constructor(redis: RedisClient) {
    this.redis = redis;
    this.scriptShaPromise = this.loadScript();
  }

  /**
   * registerHit – record a single action and return the total number of hits
   * in the sliding window after the insert.
   */
  public async registerHit(
    key: string,
    windowSizeSec: number,
    expireSec: number,
    now: number = Date.now(),
  ): Promise<number> {
    const scriptSha = await this.scriptShaPromise;
    const hits: number = await this.redis.evalsha(
      scriptSha,
      1,                // number of KEYS
      key,
      now,
      windowSizeSec * 1000,
      expireSec,
    );

    return hits;
  }

  private async loadScript(): Promise<string> {
    const luaScript = `
      --[[
        KEYS[1]  abuse:{action}:{principal}
        ARGV[1]  currentTimeMillis
        ARGV[2]  windowSizeMillis
        ARGV[3]  keyExpirySeconds
      ]]
      local key              = KEYS[1]
      local now              = tonumber(ARGV[1])
      local windowStart      = now - tonumber(ARGV[2])
      local keyExpirySeconds = tonumber(ARGV[3])

      -- add current hit
      redis.call("ZADD", key, now, now)

      -- trim old
      redis.call("ZREMRANGEBYSCORE", key, 0, windowStart)

      -- count in window
      local count = redis.call("ZCARD", key)

      -- set TTL for automatic clean-up
      redis.call("EXPIRE", key, keyExpirySeconds)

      return count
    `;

    // load and store SHA
    return this.redis.script('LOAD', luaScript);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// BehavioralAnalyticsGuard
// ────────────────────────────────────────────────────────────────────────────

export class BehavioralAnalyticsGuard {
  private readonly redis: RedisClient;
  private readonly logger: pino.Logger;
  private readonly counter: SlidingWindowCounter;
  private readonly reportThreshold: number;

  constructor(opts: GuardOptions = {}) {
    this.redis  = opts.redis ?? new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    this.logger = opts.logger
      ? opts.logger.child({ module: 'behavioral-guard' })
      : pino({ name: 'behavioral-guard' });

    this.counter = new SlidingWindowCounter(this.redis);
    this.reportThreshold = opts.reportThreshold ?? 3;
  }

  /**
   * protect – generic method that can be awaited in GraphQL resolvers or other
   * imperative flows.
   *
   * Throws RateLimitError when the action must be blocked.
   */
  public async protect(action: ActionType, principal: Principal): Promise<void> {
    // Unauthenticated traffic is identified by IP only (IPv4/6)
    const principalId = principal.id ?? principal.ip;
    if (!principalId) {
      // Fail "closed" – cannot determine identity
      this.logger.warn({ action }, 'Missing principal information; blocking request');
      throw new RateLimitError(action, principal, BASE_TEMP_BLOCK_SECONDS);
    }

    const { windowSize, maxHits } = ACTION_THRESHOLDS[action];
    const redisKey = `abuse:${action}:${principalId}`;

    // We keep the key around for up to 5 * windowSize to cover exponential ban
    const hits = await this.counter.registerHit(redisKey, windowSize, windowSize * 5);

    if (hits <= maxHits) {
      return; // all good
    }

    // Exceeded threshold: increment strike counter and possibly ban
    const strikeKey = `abuse:${action}:${principalId}:strikes`;
    const strikes   = await this.redis.incr(strikeKey);

    // Keep strike counter for 24h, after which we forgive
    await this.redis.expire(strikeKey, 24 * 3600);

    const retryAfter = BASE_TEMP_BLOCK_SECONDS * Math.pow(2, strikes - 1);

    // Log & publish event
    this.logger.warn(
      { action, principalId, hits, strikes, retryAfter },
      'Behavioural threshold exceeded',
    );

    // TODO: Publish to central event bus (Kafka/NATS) for security analytics
    // await eventBus.publish(new AbuseDetectedEvent(...));

    if (strikes >= this.reportThreshold) {
      // Additional reporting can be plugged in here
      // securityOps.notify(...);
    }

    throw new RateLimitError(action, principal, retryAfter);
  }

  /**
   * expressMiddleware – converts the guard into drop-in Express compatible
   * middleware.  Requires the caller to provide `actionType` and extraction
   * logic for the principal (user/ip).
   *
   * Example:
   *   const guard   = new BehavioralAnalyticsGuard();
   *   app.post('/v1/follow', guard.expressMiddleware(ActionType.FOLLOW, req => ({
   *     id: req.auth?.userId,
   *     ip: req.ip,
   *   })), followController.handle);
   */
  public expressMiddleware(
    action: ActionType,
    principalExtractor: (req: Request) => Principal,
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await this.protect(action, principalExtractor(req));
        next();
      } catch (err) {
        if (err instanceof RateLimitError) {
          res.setHeader('Retry-After', err.retryAfter.toString());
          res.status(429).json({
            error: 'RATE_LIMIT_EXCEEDED',
            message: err.message,
          });
          return;
        }
        next(err);
      }
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Factory Helper for DI Containers
// ────────────────────────────────────────────────────────────────────────────

/**
 * createBehavioralAnalyticsGuard – convenience factory for frameworks that use
 * inversion of control (e.g. Inversify, NestJS).  The singleton instance is
 * cached via module scope.
 */
let singletonInstance: BehavioralAnalyticsGuard | null = null;

export function createBehavioralAnalyticsGuard(opts: GuardOptions = {}): BehavioralAnalyticsGuard {
  if (!singletonInstance) {
    singletonInstance = new BehavioralAnalyticsGuard(opts);
  }
  return singletonInstance;
}

// ────────────────────────────────────────────────────────────────────────────
// Example usage (commented out to avoid side-effects on import)
//
// import express from 'express';
// import { ActionType, createBehavioralAnalyticsGuard } from './module_33';
//
// const app     = express();
// const guard   = createBehavioralAnalyticsGuard();
//
// app.post(
//   '/v1/follows',
//   guard.expressMiddleware(ActionType.FOLLOW, req => ({
//     id: req.headers['x-user-id'] as string | undefined,
//     ip: req.ip,
//   })),
//   (req, res) => res.sendStatus(204),
// );
//
// app.listen(8080, () => console.log('API Gateway up on :8080'));
//
// ────────────────────────────────────────────────────────────────────────────
```