```typescript
/***************************************************************************************************
 * File:          src/module_42.ts
 * Project:       SocialPulse Gateway (api_gateway)
 * Description:   High-performance, Redis-backed adaptive rate-limiter with version-aware key-space
 *                and sliding-window semantics. Designed to protect REST/GraphQL entry-points from
 *                abusive patterns (follow-spam, message floods, etc.) while remaining highly
 *                concurrent and horizontally scalable.
 *
 *                – Sliding-window implementation powered by an atomic Lua script
 *                – Versioned routing support (`v1`, `v2`, …) so roll-outs do not interfere
 *                – Dynamic request “cost” for heavier operations (e.g. media upload = 10 tokens)
 *                – Automatic hard-blocking for the configured duration once the limit is breached
 *                – Fully instrumented with structured logging hooks
 *
 * Usage:
 *    const limiter = new AdaptiveRateLimiter(redis, { window: '1m', limit: 120, blockDuration: '10m' }, logger);
 *    const result  = await limiter.consume({ identifier: userId, cost: 2, version: 'v2' });
 *    if (result.blocked) throw new RateLimitBlockedError(result);
 ***************************************************************************************************/

import { Redis } from 'ioredis';
import ms from 'ms';

/* ──────────────────────────────────────────────────────────────────────────────
 * Logger interface – keeps the implementation agnostic (Pino, Winston, Bunyan…)
 * ──────────────────────────────────────────────────────────────────────────── */
export interface LoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Public DTOs
 * ──────────────────────────────────────────────────────────────────────────── */
export interface RateLimitConfig {
  /** Sliding-window size – e.g. `"1m"` or `60000` (ms) */
  window: string | number;
  /** Max tokens within the window */
  limit: number;
  /** How long to block the identity once limit is exceeded (default: same as window) */
  blockDuration?: string | number;
  /** Optional key prefix, defaults to `"rate_limit"` */
  prefix?: string;
}

export interface ConsumeInput {
  /** Unique identity to throttle (user-id, IP, API-key, …) */
  identifier: string;
  /** “Weight” of this request (1 = cheap, 10 = expensive) */
  cost?: number;
  /** API version (v1, v2…), affects key namespacing */
  version?: string;
  /** Timestamp override – mostly for unit tests */
  now?: number;
}

export interface RateLimitResult {
  /** Whether request is fully allowed */
  allowed: boolean;
  /** Whether request is *throttled* (soft-limit breached) */
  throttled: boolean;
  /** Whether request is *blocked* (hard-block in effect) */
  blocked: boolean;
  /** Remaining tokens in the window (0 if throttled/blocked) */
  remaining: number;
  /** Epoch-ms when the window resets (approximate) */
  resetAt: number;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Error helpers – consumers can catch these for fine-grained control
 * ──────────────────────────────────────────────────────────────────────────── */
export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimiterError';
  }
}

export class RateLimitBlockedError extends RateLimiterError {
  constructor(public readonly details: RateLimitResult) {
    super('Request blocked by rate-limiter');
    this.name = 'RateLimitBlockedError';
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Internal helpers
 * ──────────────────────────────────────────────────────────────────────────── */
type LuaNumber = number; // ioredis returns numbers as JS numbers (double)

/** Lua script for atomic sliding-window rate-limit acquisition. */
const LUA_SLIDING_WINDOW = `
-- KEYS[1]   -> sorted-set key
-- ARGV[1]   -> now (epoch-ms)
-- ARGV[2]   -> window-size (ms)
-- ARGV[3]   -> limit
-- ARGV[4]   -> cost
local key       = KEYS[1]
local now       = tonumber(ARGV[1])
local window    = tonumber(ARGV[2])
local limit     = tonumber(ARGV[3])
local cost      = tonumber(ARGV[4])

-- purge old entries
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

-- current number of tokens
local current = redis.call('ZCARD', key)

-- would this exceed the limit?
if (current + cost) > limit then
  return -1
end

-- append <cost> unique members
for i = 1, cost do
  redis.call('ZADD', key, now, tostring(now) .. '-' .. tostring(i) .. '-' .. tostring(math.random(0, 100000)))
end

-- ensure key auto-expires
redis.call('PEXPIRE', key, window)

return current + cost
`;

/* ──────────────────────────────────────────────────────────────────────────────
 * AdaptiveRateLimiter – main export
 * ──────────────────────────────────────────────────────────────────────────── */
export class AdaptiveRateLimiter {
  /** SHA1 of the Lua script after registration */
  private readonly scriptName = 'acquire_sliding_window';
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly blockMs: number;
  private readonly prefix: string;

  constructor(
    private readonly redis: Redis,
    rawConfig: RateLimitConfig,
    private readonly logger: LoggerLike,
  ) {
    // Normalise config
    this.windowMs = typeof rawConfig.window === 'number' ? rawConfig.window : ms(rawConfig.window);
    this.limit = rawConfig.limit;
    this.blockMs = rawConfig.blockDuration
      ? typeof rawConfig.blockDuration === 'number'
        ? rawConfig.blockDuration
        : ms(rawConfig.blockDuration)
      : this.windowMs;
    this.prefix = rawConfig.prefix ?? 'rate_limit';

    // Register Lua script with ioredis so we can use redis.<scriptName>(...)
    this.redis.defineCommand(this.scriptName, {
      numberOfKeys: 1,
      lua: LUA_SLIDING_WINDOW,
    });

    this.logger.info(
      `[rate-limiter] initialised – window=${this.windowMs}ms limit=${this.limit} ` +
        `block=${this.blockMs}ms prefix="${this.prefix}"`,
    );
  }

  /** Human-friendly key generator (ensures predictable cardinality) */
  private baseKey(version: string, id: string): string {
    return `${this.prefix}:${version}:${id}`;
  }

  /** Blocking key – controls hard blocks via Redis TTL */
  private blockKey(base: string): string {
    return `${base}:blocked`;
  }

  /** Consume <cost> tokens for identifier. */
  async consume(input: ConsumeInput): Promise<RateLimitResult> {
    const cost = input.cost ?? 1;
    const version = input.version ?? 'v1';
    const now = input.now ?? Date.now();

    const keyBase = this.baseKey(version, input.identifier);
    const blockKey = this.blockKey(keyBase);

    try {
      /* ─── 1. Hard-block check ─────────────────────────────────────────── */
      const isBlocked = (await this.redis.exists(blockKey)) === 1;
      if (isBlocked) {
        this.logger.warn({ id: input.identifier, version }, 'rate-limit hard-block in effect');
        return {
          allowed: false,
          throttled: false,
          blocked: true,
          remaining: 0,
          resetAt: now + this.blockMs,
        };
      }

      /* ─── 2. Attempt to acquire tokens via Lua script ─────────────────── */
      const newCount: LuaNumber = (await (this.redis as any)[this.scriptName](
        keyBase,
        now,
        this.windowMs,
        this.limit,
        cost,
      )) as LuaNumber;

      /* ─── 3. Evaluate result ──────────────────────────────────────────── */
      if (newCount === -1) {
        // Breach – apply hard block
        await this.redis.psetex(blockKey, this.blockMs, '1');
        this.logger.warn(
          { id: input.identifier, version, limit: this.limit, cost },
          'rate-limit breached – user blocked',
        );
        return {
          allowed: false,
          throttled: false,
          blocked: true,
          remaining: 0,
          resetAt: now + this.blockMs,
        };
      }

      // Allowed
      const remaining = Math.max(this.limit - newCount, 0);

      // Approximate earliest timestamp in the window to compute resetAt
      const oldest = (await this.redis.zrange(keyBase, 0, 0, 'WITHSCORES')) as string[];
      const oldestScore = oldest.length === 2 ? parseInt(oldest[1], 10) : now;
      const resetAt = oldestScore + this.windowMs;

      return {
        allowed: true,
        throttled: false,
        blocked: false,
        remaining,
        resetAt,
      };
    } catch (err) {
      // Safety – never break the production flow because redis hiccuped
      this.logger.error({ err }, 'rate-limiter failure (allowing request)');
      return {
        allowed: true,
        throttled: false,
        blocked: false,
        remaining: this.limit,
        resetAt: Date.now() + this.windowMs,
      };
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Example wiring (commented – for reference only):
 *
 *    import Redis from 'ioredis';
 *    import pino  from 'pino';
 *
 *    const redis  = new Redis(process.env.REDIS_URL!);
 *    const logger = pino({ name: 'rate-limiter' });
 *
 *    const limiter = new AdaptiveRateLimiter(redis, {
 *      window: '1m',
 *      limit: 100,
 *      blockDuration: '15m',
 *      prefix: 'rate_limit',
 *    }, logger);
 *
 *    // Inside an Express/Koa/GraphQL middleware:
 *    const res = await limiter.consume({ identifier: ctx.state.userId, cost: 1, version: 'v2' });
 *    if (res.blocked) {
 *      ctx.status = 429;
 *      ctx.body   = { error: 'Too many requests', retry_after: res.resetAt };
 *      return;
 *    }
 * ──────────────────────────────────────────────────────────────────────────── */
```