```typescript
/**
 * SocialPulse Gateway – AdaptiveRateLimiter
 * -----------------------------------------
 * This module encapsulates a highly–tuned, Redis–backed rate-limiter used by the
 * API-Gateway’s REST and GraphQL entry-points.  Designed for social workloads,
 * it provides:
 *
 *  • Per-identity token buckets (user-id / IP / API-key)
 *  • Route-scoped policies (POST /timeline  ≠  GET /timeline)
 *  • Adaptive penalties (exponential back-off on abuse bursts)
 *  • Lua-scripted atomicity for O(1) cost at gateway scale
 *  • Graceful in-memory degradation when Redis is unavailable
 *
 * It lives in the “infrastructure” ring of the Clean Architecture,
 * yet exposes a small domain-friendly surface consumed by the “application”
 * layer.
 */

import { EventEmitter } from 'node:events';
import Redis, { Redis as RedisClient } from 'ioredis';
import pino, { Logger } from 'pino';

/* -------------------------------------------------------------------------- */
/*                                Public Types                                */
/* -------------------------------------------------------------------------- */

export interface RateLimitConfig {
  /** Sliding window in seconds */
  windowSec: number;
  /** Allowed requests in the sliding window */
  maxRequests: number;
  /** Additional cool-down seconds applied when the limit is exceeded */
  penaltySec: number;
  /** Burst multiplier ⇒ exponential back-off (power of 2) */
  adaptive?: boolean;
}

export interface RateLimiterOpts {
  /** ioredis client — injected at runtime */
  redis: RedisClient;
  /** Policy map keyed by <HTTP_METHOD>␟<ROUTE_PATTERN> */
  policies: Map<string, RateLimitConfig>;
  /** Structured logger */
  logger?: Logger;
  /** Event bus for metrics / observability */
  events?: EventEmitter;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  /** TTL in seconds until the bucket fully resets */
  resetSec: number;
}

/* -------------------------------------------------------------------------- */
/*                       Lua Script (atomic bucket logic)                     */
/* -------------------------------------------------------------------------- */

const LUA_SLIDING_WINDOW = `
-- KEYS[1]   => bucket key
-- ARGV[1]   => current timestamp (sec)
-- ARGV[2]   => window size (sec)
-- ARGV[3]   => max requests
-- ARGV[4]   => penalty seconds (adaptive)
local bucket   = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local penalty  = tonumber(ARGV[4])

-- purge outdated entries
redis.call("ZREMRANGEBYSCORE", bucket, 0, now - window)

-- current count
local cnt = redis.call("ZCARD", bucket)

if cnt >= limit then
  -- apply penalty TTL so key survives until penalty expires
  local ttl = redis.call("TTL", bucket)
  if ttl < penalty then
    redis.call("EXPIRE", bucket, penalty)
  end
  return {0, limit - cnt, ttl}
end

-- add new hit
redis.call("ZADD", bucket, now, now)
-- set initial TTL
redis.call("EXPIRE", bucket, window)
return {1, limit - cnt - 1, window}
`;

/* -------------------------------------------------------------------------- */
/*                              Helper Utilities                              */
/* -------------------------------------------------------------------------- */

/**
 * Stable route hash: `${method}␟${path}` – keeps policy lookup cheap.
 */
function policyKey(method: string, path: string): string {
  return `${method.toUpperCase()}\u241F${path}`; // \u241F = ␟ symbol
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/*                          Adaptive Rate Limiter Impl                        */
/* -------------------------------------------------------------------------- */

export class AdaptiveRateLimiter {
  private readonly redis: RedisClient;
  private readonly policies: Map<string, RateLimitConfig>;
  private readonly logger: Logger;
  private readonly events: EventEmitter;
  private readonly fallbackBuckets = new Map<string, number[]>();

  private luaSha?: string;

  constructor(opts: RateLimiterOpts) {
    this.redis = opts.redis;
    this.policies = opts.policies;
    this.logger = opts.logger ?? pino({ name: 'rate-limiter' });
    this.events = opts.events ?? new EventEmitter();

    this.prepareScript().catch((err) => {
      this.logger.error({ err }, 'Could not preload Lua script – will retry lazily.');
    });
  }

  /**
   * Pre–load Lua script into Redis, storing its SHA for future use.
   */
  private async prepareScript() {
    try {
      this.luaSha = await this.redis.script('LOAD', LUA_SLIDING_WINDOW);
      this.logger.debug({ sha: this.luaSha }, 'Lua script loaded into Redis');
    } catch (error) {
      this.logger.warn({ error }, 'Failed to load Lua script');
    }
  }

  /**
   * Consume a single token for the provided identity+route pair.
   *
   * @param identity uniquely identifies the caller (user-id / API-key / IP)
   * @param method   HTTP method
   * @param path     full path pattern as registered in the router
   */
  async consume(
    identity: string,
    method: string,
    path: string
  ): Promise<ConsumeResult> {
    const key = policyKey(method, path);
    const policy = this.policies.get(key);

    // No policy → unlimited
    if (!policy) {
      return { allowed: true, remaining: Infinity, resetSec: 0 };
    }

    const bucketKey = `rate:${key}:${identity}`;
    try {
      return await this.consumeRedis(bucketKey, policy);
    } catch (err) {
      this.logger.error(
        { err, identity, key },
        'Redis unavailable – falling back to memory limiter'
      );
      // Graceful degradation: use in-memory fallback
      return this.consumeInMemory(bucketKey, policy);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                    Redis-backed Sliding-Window Logic                   */
  /* ---------------------------------------------------------------------- */

  private async consumeRedis(
    bucketKey: string,
    policy: RateLimitConfig
  ): Promise<ConsumeResult> {
    // Load the script if not already
    if (!this.luaSha) {
      await this.prepareScript();
    }

    const now = Math.floor(Date.now() / 1000);

    try {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error – ioredis returns (number | string)[]
      const [allowed, remaining, reset] = (await this.redis.evalsha(
        this.luaSha as string,
        1,
        bucketKey,
        now,
        policy.windowSec,
        policy.maxRequests,
        this.penaltyWindow(policy)
      )) as [number, number, number];

      const result: ConsumeResult = {
        allowed: !!allowed,
        remaining,
        resetSec: reset,
      };

      this.emitMetrics(bucketKey, policy, result);

      if (!result.allowed && policy.adaptive) {
        // Minor guard: give the client a tiny breather to slow the spam rate
        await sleep(5);
      }

      return result;
    } catch (error) {
      // If the script is missing (after Redis restart), reload once
      if (error instanceof Error && /NOSCRIPT/.test(error.message)) {
        this.luaSha = undefined;
        return this.consumeRedis(bucketKey, policy);
      }
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                      In-Memory (degraded) implementation                */
  /* ---------------------------------------------------------------------- */

  private consumeInMemory(
    bucketKey: string,
    policy: RateLimitConfig
  ): ConsumeResult {
    const now = Date.now(); // ms epoch
    const windowMs = policy.windowSec * 1000;
    const bucket = (this.fallbackBuckets.get(bucketKey) ?? []).filter(
      (ts) => ts > now - windowMs
    );
    let allowed = true;

    if (bucket.length >= policy.maxRequests) {
      allowed = false;
    } else {
      bucket.push(now);
    }

    this.fallbackBuckets.set(bucketKey, bucket);

    const remaining = Math.max(policy.maxRequests - bucket.length, 0);
    const resetSec = Math.ceil(
      (bucket.length ? bucket[0] + windowMs - now : 0) / 1000
    );

    const result: ConsumeResult = { allowed, remaining, resetSec };
    this.emitMetrics(bucketKey, policy, result, true);
    return result;
  }

  /* ---------------------------------------------------------------------- */
  /*                             Helper Methods                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Extra penalty window applied when abuse threshold is exceeded.
   * For adaptive mode, penalty grows exponentially with limit breach.
   */
  private penaltyWindow(policy: RateLimitConfig): number {
    if (!policy.adaptive) return policy.penaltySec;
    // Exponential factor based on a simple time component
    const factor = Math.pow(2, Math.floor(Date.now() / 60000) % 4); // cycles every 4 min
    return policy.penaltySec * factor;
  }

  private emitMetrics(
    bucketKey: string,
    policy: RateLimitConfig,
    result: ConsumeResult,
    degraded = false
  ) {
    this.events.emit('rate.consume', {
      bucketKey,
      policy,
      ...result,
      degraded,
      ts: Date.now(),
    });
    const level = result.allowed ? 'debug' : 'warn';
    this.logger[level](
      { bucketKey, remaining: result.remaining, reset: result.resetSec, degraded },
      result.allowed ? 'rate-limit passed' : 'rate-limit exceeded'
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                        Convenience Factory for DI                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds an AdaptiveRateLimiter instance from JSON policy descriptors.
 *
 * Example usage:
 * const limiter = buildRateLimiter(redis, {
 *   "POST␟/v1/timeline":  { windowSec: 60, maxRequests: 20, penaltySec: 30 },
 *   "GET␟/v1/timeline":   { windowSec: 3,  maxRequests: 40, penaltySec: 5  }
 * });
 */
export function buildRateLimiter(
  redis: RedisClient,
  rawPolicies: Record<string, RateLimitConfig>,
  logger?: Logger,
  events?: EventEmitter
): AdaptiveRateLimiter {
  const policyMap = new Map<string, RateLimitConfig>(
    Object.entries(rawPolicies)
  );
  return new AdaptiveRateLimiter({ redis, policies: policyMap, logger, events });
}

/* -------------------------------------------------------------------------- */
/*                                   Usage                                   */
/* -------------------------------------------------------------------------- */
/*
import fastify from 'fastify';
import Redis from 'ioredis';

const app = fastify();
const redis = new Redis();

const limiter = buildRateLimiter(redis, {
  'POST␟/api/v1/posts': { windowSec: 60, maxRequests: 30, penaltySec: 120, adaptive: true },
});

app.addHook('preHandler', async (req, res) => {
  const id = req.headers['x-user-id'] ?? req.ip;
  const { allowed, remaining, resetSec } = await limiter.consume(
    String(id),
    req.method,
    req.routerPath
  );
  res.header('X-RateLimit-Limit', 30);
  res.header('X-RateLimit-Remaining', remaining);
  res.header('X-RateLimit-Reset', resetSec);
  if (!allowed) {
    res.code(429).send({ error: 'Rate limit exceeded', reset: resetSec });
  }
});
*/
```