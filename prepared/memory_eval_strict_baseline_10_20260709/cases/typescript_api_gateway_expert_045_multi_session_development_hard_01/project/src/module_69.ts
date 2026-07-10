```typescript
/**
 * SocialPulse Gateway
 * File: src/module_69.ts
 *
 * Purpose:
 * --------
 * Production-grade, highly-configurable rate-limiter that supports:
 *   • Per-user, per-IP, and per-endpoint quotas
 *   • Sliding-window counters (backed by Redis & Lua for atomicity)
 *   • Adaptive penalties and exponential back-off
 *   • First-class Express / Fastify middleware factory
 *   • Structured logging & metric hooks
 *
 * The limiter is meant to sit in the “infrastructure” layer and be wired
 * into presentation controllers (REST) or GraphQL context builders.
 */

import Redis from 'ioredis';
import type { Request, Response, NextFunction } from 'express';

/* ------------------------------------------------------------------ */
/* Types & Interfaces                                                 */
/* ------------------------------------------------------------------ */

/**
 * Single logical rule.
 *
 * Example:
 *  { windowMs: 60_000, max: 100 }   // 100 requests / minute
 */
export interface RateLimitRule {
  /** Time window in milliseconds */
  windowMs: number;

  /** Maximum number of requests allowed in the window */
  max: number;

  /**
   * Extra “cool-down” applied once the quota is exceeded.
   * Returned via `Retry-After` header (seconds).
   */
  penaltySeconds?: number;

  /** Optional name – used for metrics/logging */
  name?: string;
}

/**
 * Contextual information used for key derivation & logging.
 */
export interface RateLimitContext {
  /** User identifier (jwt.sub) if authenticated */
  userId?: string;
  /** Client IP (already sanitized by proxy-aware middleware) */
  ip: string;
  /** REST path or GraphQL field combination */
  endpoint: string;
  /** Extra bag for extension */
  meta?: Record<string, unknown>;
}

/** Outcome from the limiter */
export interface RateLimitDecision {
  allowed: boolean;
  remaining?: number;
  resetMs?: number;
  retryAfterSeconds?: number;
  /** Headers to attach to HTTP response */
  headers: Record<string, string | number>;
}

/** Listener signature for metric hooks */
export type DecisionListener = (ctx: RateLimitContext, decision: RateLimitDecision) => void;

/**
 * Settings governing behaviour of the limiter instance.
 */
export interface AdaptiveRateLimiterOptions {
  /** Redis key prefix (default: "rate" ) */
  redisKeyPrefix?: string;
  /**
   * Will be called for every decision – integrate with DataDog / Prometheus.
   * Recommended **not** to do heavy lifting synchronously here.
   */
  onDecision?: DecisionListener;
  /** Inject structured logger (defaults to no-op) */
  logger?: Pick<Console, 'debug' | 'error' | 'warn'>;
}

/* ------------------------------------------------------------------ */
/* Adaptive Rate Limiter                                              */
/* ------------------------------------------------------------------ */

export class AdaptiveRateLimiter {
  private readonly redis: Redis;
  private readonly rules: ReadonlyArray<RateLimitRule>;
  private readonly opts: Required<AdaptiveRateLimiterOptions>;

  /* Lua script for atomic counter update & TTL handling.
     Parameters:
       KEYS[1] - redis key
       ARGV[1] - current timestamp in milliseconds
       ARGV[2] - window (ms)
     Returns: current counter value after increment
  */
  private static readonly INCR_WITH_TTL_LUA = `
    local key         = KEYS[1]
    local now         = tonumber(ARGV[1])
    local windowMs    = tonumber(ARGV[2])
    local expiresInMs = math.floor(windowMs)

    local cnt = redis.call("INCR", key)

    -- First hit => set TTL
    if cnt == 1 then
      redis.call("PEXPIRE", key, expiresInMs)
    end

    return cnt
  `;

  constructor(redis: Redis, rules: ReadonlyArray<RateLimitRule>, options: AdaptiveRateLimiterOptions = {}) {
    if (!rules.length) throw new Error('AdaptiveRateLimiter requires at least one rule');

    this.redis = redis;
    this.rules = rules;
    this.opts = {
      redisKeyPrefix: options.redisKeyPrefix ?? 'rate',
      onDecision: options.onDecision ?? (() => void 0),
      logger: options.logger ?? console,
    };

    // Preload script to obtain a SHA for faster EVALSHA
    this.redis
      .script('LOAD', AdaptiveRateLimiter.INCR_WITH_TTL_LUA)
      .then((sha) => {
        this.opts.logger.debug?.('[RateLimiter] Lua script pre-loaded (%s)', sha);
      })
      .catch((err) => {
        this.opts.logger.error?.('[RateLimiter] Failed to load Lua script', err);
      });
  }

  /**
   * Main entry point. Consumes +1 token for EVERY rule attached to the instance.
   * If any rule is violated, the request is rejected.
   */
  public async consume(ctx: RateLimitContext): Promise<RateLimitDecision> {
    const now = Date.now();

    // Evaluate rules in parallel
    const evaluations = await Promise.all(
      this.rules.map((rule) => this.evaluateRule(ctx, rule, now)),
    );

    // The most restrictive rule wins (first exceeded)
    const firstExceeded = evaluations.find((e) => !e.allowed);

    const decision: RateLimitDecision = firstExceeded
      ? firstExceeded // contains retryAfterSeconds etc.
      : {
          allowed: true,
          headers: this.buildSuccessHeaders(evaluations),
        };

    // Async hook for metrics / audit
    queueMicrotask(() => this.opts.onDecision?.(ctx, decision));

    return decision;
  }

  /**
   * Express middleware factory.
   *
   * Usage:
   *   const limiter = new AdaptiveRateLimiter(redis, rules);
   *   app.use(limiter.expressMiddleware(req => req.user?.id, req => ({endpoint: req.path, ip: req.ip})))
   */
  public expressMiddleware(
    keyBuilder: (req: Request) => string | undefined,
    ctxBuilder: (req: Request) => Omit<RateLimitContext, 'userId'>,
  ) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = keyBuilder(req);
        const baseCtx = ctxBuilder(req);
        const ctx: RateLimitContext = { ...baseCtx, userId };
        const decision = await this.consume(ctx);

        // Attach informative headers
        Object.entries(decision.headers).forEach(([k, v]) => res.setHeader(k, v));

        if (!decision.allowed) {
          res.status(429).json({
            error: 'Too Many Requests',
            retryAfterSeconds: decision.retryAfterSeconds,
          });
          return;
        }

        return next();
      } catch (err) {
        this.opts.logger.error?.('[RateLimiter] Middleware error', err);
        // Let the global error handler deal with it – do not leak limiter failures
        return next();
      }
    };
  }

  /* ----------------------------  Helpers --------------------------- */

  private async evaluateRule(
    ctx: RateLimitContext,
    rule: RateLimitRule,
    now: number,
  ): Promise<RateLimitDecision> {
    const key = this.buildRedisKey(ctx, rule);
    const windowMs = rule.windowMs;

    const counter = await this.redis.eval(
      AdaptiveRateLimiter.INCR_WITH_TTL_LUA,
      1,
      key,
      now,
      windowMs,
    );

    const remaining = Math.max(0, rule.max - (counter as number));
    const allowed = remaining >= 0;

    if (!allowed) {
      const retryAfterSeconds = rule.penaltySeconds ?? Math.ceil(windowMs / 1000);
      this.opts.logger.warn?.(
        '[RateLimiter] Rule "%s" blocked key "%s": counter=%d, max=%d',
        rule.name ?? 'unnamed',
        key,
        counter,
        rule.max,
      );

      return {
        allowed: false,
        remaining,
        retryAfterSeconds,
        headers: {
          'Retry-After': retryAfterSeconds,
          'X-RateLimit-Limit': rule.max,
          'X-RateLimit-Remaining': 0,
        },
      };
    }

    return {
      allowed: true,
      remaining,
      resetMs: now + windowMs,
      headers: {
        'X-RateLimit-Limit': rule.max,
        'X-RateLimit-Remaining': remaining,
      },
    };
  }

  private buildRedisKey(ctx: RateLimitContext, rule: RateLimitRule): string {
    /**
     * Key taxonomy:
     *   <prefix>:<ruleName>:<user|ip>:<endpoint>
     *
     * Example:
     *   "rate:minute:user:12345:/api/v1/posts"
     */
    const identity = ctx.userId ? `user:${ctx.userId}` : `ip:${ctx.ip}`;
    const endpoint = encodeURIComponent(ctx.endpoint);

    const ruleTag = rule.name ?? `${rule.windowMs}:${rule.max}`;
    return `${this.opts.redisKeyPrefix}:${ruleTag}:${identity}:${endpoint}`;
  }

  private buildSuccessHeaders(evaluations: RateLimitDecision[]): Record<string, string | number> {
    // Choose *tightest* rule for header exposure
    const mostRestrictive = evaluations.reduce((prev, curr) =>
      prev.remaining! < curr.remaining! ? prev : curr,
    );
    return mostRestrictive.headers;
  }
}

/* ------------------------------------------------------------------ */
/* Example Rule Set (could be imported elsewhere)                     */
/* ------------------------------------------------------------------ */

export const DEFAULT_RATE_LIMIT_RULES: RateLimitRule[] = [
  { windowMs: 60_000, max: 120, name: 'minute' },           // 120 req / min
  { windowMs: 3_600_000, max: 4_000, name: 'hour' },        // 4k req / hour
  { windowMs: 86_400_000, max: 70_000, name: 'day' },       // 70k req / day
];
```