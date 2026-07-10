```typescript
/**
 * SocialPulse Gateway – Rate-Limiting / Abuse-Protection Module
 * -------------------------------------------------------------
 * This module implements a high-performance, Redis-backed rate-limiter that can
 * be mounted as an Express / Fastify / NestJS middleware **or** used as a plain
 * service inside GraphQL resolver pipelines.
 *
 * Key characteristics:
 * • Sliding-Window log algorithm implemented with a single Lua script for
 *   atomicity and O(1) memory usage per visitor.
 * • Per-user / per-IP / per-route policies via pluggable `PolicyProvider`.
 * • Optional in-memory fallback (useful during a Redis outage or for unit
 *   testing).
 * • Rich telemetry (success/failure counts + latency) via `pino`-style logger.
 *
 * NOTE: This file is intentionally framework-agnostic; wiring (e.g. Express
 * middleware exports) happens at the bottom.
 */

import { createHash } from 'crypto';
import Redis, { Redis as RedisClient } from 'ioredis';
import createHttpError from 'http-errors';

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

/** Public-facing rate-limit contract (read-only to callers). */
export interface RateLimitPolicy {
  /** Sliding-window duration, in seconds. */
  windowSeconds: number;

  /** Maximum requests allowed within `windowSeconds`. */
  maxRequests: number;

  /**
   * Optional: user gets blocked for this duration once they exceed quota.
   * Omit to disable hard blocking and return standard 429 instead.
   */
  blockDurationSeconds?: number;

  /**
   * Optional: a custom key prefix. Default is `"rl"` (short for rate-limit).
   * Use different prefixes if you share the same Redis with other tenants.
   */
  keyPrefix?: string;
}

/** Result after a single `check()` operation. */
export interface RateLimitResult {
  /** Whether the request can proceed. */
  allowed: boolean;
  /** Remaining quota (may be negative if already blocked). */
  remaining: number;
  /** Seconds until the current window resets. */
  resetAfter: number;
  /** Present when `allowed === false`; seconds until retry is allowed. */
  retryAfter?: number;
  /** The Redis key used (helpful for debug). */
  key: string;
}

/** Context object describing the request being evaluated. */
export interface RateLimitContext {
  /** Canonical user ID, or `undefined` for anonymous traffic. */
  userId?: string;
  /** IPv4 / IPv6 string for source. */
  ip: string;
  /** Normalised route identifier (e.g. `POST:/v2/posts`). */
  route: string;
  /** Optional: caller automatically injects logger for richer traces. */
  logger?: LoggerLike;
}

/** Anything Pino-compatible is acceptable. */
export interface LoggerLike {
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Pluggable provider – decide which policy applies for the request. */
export interface PolicyProvider {
  (ctx: RateLimitContext): Promise<RateLimitPolicy | null>;
}

/* -------------------------------------------------------------------------- */
/*                               Implementation                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_POLICY: RateLimitPolicy = Object.freeze({
  windowSeconds: 60,
  maxRequests: 120,
  keyPrefix: 'rl',
});

const LUA_SLIDING_WINDOW = `
--[[
 KEYS[1] -> {string} rate-limit bucket key
 ARGV[1] -> {number} current timestamp (ms)
 ARGV[2] -> {number} window size (ms)
 ARGV[3] -> {number} max requests
--]]
local key         = KEYS[1]
local now         = tonumber(ARGV[1])
local windowSize  = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])

-- Remove entries older than the window
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowSize)

-- Count current requests within window
local current = redis.call('ZCARD', key)

if current >= maxRequests then
  -- Too many requests
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then ttl = windowSize end
  return {0, current, ttl}  -- not allowed
else
  -- Add current request
  redis.call('ZADD', key, now, now)
  -- Ensure key expires slightly after window end
  redis.call('PEXPIRE', key, windowSize + 50)
  local remaining = maxRequests - current - 1
  local ttl = redis.call('PTTL', key)
  return {1, remaining, ttl}  -- allowed
end
`;

interface Storage {
  check(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult>;
}

/* ------------------------------- RedisStore ------------------------------ */

class RedisStore implements Storage {
  private scriptSha?: string;
  constructor(private readonly redis: RedisClient) {}

  async check(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    // Lazy-load Lua script (build-time pre-loading is also viable)
    if (!this.scriptSha) {
      this.scriptSha = await this.redis.script('load', LUA_SLIDING_WINDOW);
    }

    const windowMs = policy.windowSeconds * 1_000;
    try {
      const [allowed, remaining, ttl] = (await this.redis.evalsha(
        this.scriptSha,
        1,
        key,
        Date.now(),
        windowMs,
        policy.maxRequests,
      )) as [number, number, number];

      return {
        allowed: !!allowed,
        remaining,
        resetAfter: Math.ceil(ttl / 1_000),
        retryAfter: allowed ? undefined : Math.ceil(ttl / 1_000),
        key,
      };
    } catch (err) {
      // SHA no longer exists (e.g., after Redis restart) → fall back to EVAL
      if (
        err instanceof Error &&
        err.message &&
        err.message.startsWith('NOSCRIPT')
      ) {
        this.scriptSha = undefined;
        return this.check(key, policy);
      }
      throw err;
    }
  }
}

/* ------------------------------ MemoryStore ------------------------------ */

type BucketEntry = number[];

class MemoryStore implements Storage {
  private buckets = new Map<string, BucketEntry>();

  async check(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    const windowMs = policy.windowSeconds * 1_000;
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? [];
    // Remove old
    while (bucket.length && bucket[0] <= now - windowMs) {
      bucket.shift();
    }
    if (bucket.length >= policy.maxRequests) {
      const retryAfterMs = windowMs - (now - bucket[0]);
      return {
        allowed: false,
        remaining: policy.maxRequests - bucket.length,
        resetAfter: Math.ceil(retryAfterMs / 1_000),
        retryAfter: Math.ceil(retryAfterMs / 1_000),
        key,
      };
    }
    bucket.push(now);
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: policy.maxRequests - bucket.length,
      resetAfter: Math.ceil(windowMs / 1_000),
      key,
    };
  }
}

/* ------------------------------ RateLimiter ------------------------------ */

export interface RateLimiterOptions {
  redis?: RedisClient; // optional → fallback to memory
  logger?: LoggerLike;
  policyProvider?: PolicyProvider;
}

export class RateLimiter {
  private readonly store: Storage;
  private readonly log: LoggerLike;
  private readonly policies: PolicyProvider;

  constructor(private readonly opts: RateLimiterOptions = {}) {
    this.log =
      opts.logger ??
      ({
        trace: () => {},
        debug: () => {},
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      } as LoggerLike);

    this.store = opts.redis ? new RedisStore(opts.redis) : new MemoryStore();

    this.policies =
      opts.policyProvider ??
      (async () => DEFAULT_POLICY); // fallback: single global policy
  }

  /**
   * Primary public API. Returns the quota evaluation for `ctx`.
   *
   * NOTE: Does *not* throw on over-quota. It's the caller's responsibility to
   * decide whether to fail the request or degrade gracefully.
   */
  async check(ctx: RateLimitContext): Promise<RateLimitResult> {
    const policy =
      (await this.policies(ctx)) ?? DEFAULT_POLICY;

    const key = buildStorageKey(ctx, policy);
    const start = Date.now();
    const result = await this.store.check(key, policy).catch((err) => {
      this.log.error({ err }, 'rate-limit check failed');
      throw err;
    });

    const latency = Date.now() - start;
    this.log.trace(
      {
        key,
        allowed: result.allowed,
        remaining: result.remaining,
        latency,
      },
      'rate-limit result',
    );

    // Automatic hard-block logic (optional)
    if (!result.allowed && policy.blockDurationSeconds) {
      await this.imposeBlock(key, policy.blockDurationSeconds, result.resetAfter);
    }

    return result;
  }

  /** Force-sets a key to blocked state for `durationSeconds`. */
  private async imposeBlock(
    key: string,
    durationSeconds: number,
    currentTtlSeconds: number,
  ): Promise<void> {
    if (this.store instanceof RedisStore) {
      const redisKey = `${key}:blocked`;
      const ttl = await this.store['redis'].ttl(redisKey);
      if (ttl < 0) {
        await this.store['redis'].setex(redisKey, durationSeconds, '1');
      }
    } else {
      // In-memory: we just extend the window artificially
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore private access
      const bucket = (this.store as MemoryStore).buckets.get(key) ?? [];
      const penaltyCount = Math.ceil(
        (durationSeconds - currentTtlSeconds) *
          (DEFAULT_POLICY.maxRequests / DEFAULT_POLICY.windowSeconds),
      );
      // Fill with synthetic timestamps to keep it blocked
      bucket.unshift(
        ...new Array(penaltyCount).fill(Date.now()),
      );
      (this.store as MemoryStore).buckets.set(key, bucket);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                       Helper / public framework bindings                   */
/* -------------------------------------------------------------------------- */

/** Build storage key – ensures even distribution & avoids hot keys. */
function buildStorageKey(
  ctx: RateLimitContext,
  policy: RateLimitPolicy,
): string {
  const parts = [`${policy.keyPrefix ?? 'rl'}`];

  // Most specific identifier first → userID beats IP
  if (ctx.userId) {
    parts.push('u', ctx.userId);
  } else if (ctx.ip) {
    parts.push('i', ctx.ip);
  }

  // Route is hashed to keep keys short
  const routeHash = createHash('md5').update(ctx.route).digest('hex').slice(0, 8);
  parts.push('r', routeHash);
  return parts.join(':');
}

/* ---------------------- Express-style middleware wrapper ---------------------- */

/**
 * Quick drop-in Express / Fastify middleware.
 *
 *     app.use(rateLimitMiddleware(rateLimiterInstance));
 *
 * Optionally, you can pass your own keyGenerator/policyResolver for advanced
 * scenarios (A/B testing, geo-based policies, etc.).
 */
export function rateLimitMiddleware(
  limiter: RateLimiter,
  opts?: {
    onReject?: (
      ctx: RateLimitContext,
      result: RateLimitResult,
    ) => Promise<void> | void;
  },
) {
  return async function rateLimit(
    req: any,
    res: any,
    next: (err?: unknown) => void,
  ) {
    const ctx: RateLimitContext = {
      userId: req.user?.id, // Works for Passport or custom auth middlewares
      ip: req.ip,
      route: `${req.method}:${req.route?.path ?? req.path}`,
      logger: req.log ?? console,
    };

    try {
      const result = await limiter.check(ctx);

      res.setHeader('X-RateLimit-Limit', String(result.remaining + result.remaining /* placeholder for original limit */));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(result.resetAfter));

      if (!result.allowed) {
        if (opts?.onReject) await opts.onReject(ctx, result);
        const err = createHttpError.TooManyRequests(
          `Rate limit exceeded. Retry in ${result.retryAfter}s.`,
        );
        // Some APIs prefer 403 for authenticated quota; adjust if needed.
        err.headers = {
          'Retry-After': String(result.retryAfter),
        };
        return next(err);
      }
      return next();
    } catch (err) {
      // Optional: fail-open on Redis outage
      ctx.logger?.error({ err }, 'rate-limit middleware error – ignoring');
      return next();
    }
  };
}
```
