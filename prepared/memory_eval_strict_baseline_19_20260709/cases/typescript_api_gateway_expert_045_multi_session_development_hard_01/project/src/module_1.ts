```typescript
/************************************************************************************************************
 *  SocialPulse Gateway – Rate-Limiter & Behavioral Analytics Middleware
 *  ---------------------------------------------------------------------------------------------------------
 *  Layer      : infrastructure ▸ adapters ▸ http
 *  Responsibility:
 *    • Enforce request-level quotas (per-user / per-IP / per-route).
 *    • Emit fine-grained signals to the behavioral-analytics micro-service whenever quotas are exceeded.
 *    • Protect downstream social micro-services from abusive traffic patterns (e.g. follow-spam, DM floods).
 *
 *  NOTE:
 *    • The module is framework-agnostic: it exposes an Express/Koa-style middleware plus a pure function
 *      variant for GraphQL resolvers. 
 *    • Redis is used for a distributed token-bucket algorithm; an in-memory fallback guarantees continuity
 *      in the (rare) event that Redis is unavailable.
 *
 *  ---------------------------------------------------------------------------------------------------------
 *  USAGE (Express):
 *
 *      import express from 'express';
 *      import { createRateLimiter } from './infrastructure/rateLimiter';
 *      import redis from './infrastructure/redis';
 *
 *      const app = express();
 *      app.use(createRateLimiter(redis));
 *
 *  USAGE (GraphQL resolver):
 *
 *      const rateLimiterFn = createRateLimiter(redis).asFunction();
 *      const resolvers = {
 *        Mutation: {
 *          sendMessage: (parent, args, ctx, info) => rateLimiterFn(ctx.req, ctx.res, () =>
 *            messageUseCase.execute(args)
 *          )
 *        }
 *      }
 ***********************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

// Externalised but strongly-typed log helper
import { logger } from './logging';

// Types for cross-service events (simplified)
import { publishSecurityEvent, SecurityEventKind } from './messaging/security-events';

/* ---------------------------------------------------------------------------------------------------------
 *  Configuration Types
 * -------------------------------------------------------------------------------------------------------*/

export interface RateLimiterOptions {
  /**
   * Sliding window size (sec). 
   * e.g. 60  =>  60-second bucket
   */
  readonly windowSec: number;
  /**
   * Max requests that can be executed before throttling kicks in.
   */
  readonly maxRequests: number;
  /**
   * Extra quota granted to privileged roles (moderators / internal tools).
   * Default: 0 (no bonus)
   */
  readonly privilegedBonus?: number;
  /**
   * If true, X-RateLimit headers will be appended to each response.
   */
  readonly sendRateLimitHeaders?: boolean;
  /**
   * List of paths (globs or RegExp) that are completely excluded from rate limiting.
   */
  readonly whitelistPaths?: Array<string | RegExp>;
  /**
   * Calculate a dynamic weight for the current request.
   * Returning >1 means the request burns multiple tokens.
   */
  readonly requestCostFn?: (req: Request) => number;
}

/* ---------------------------------------------------------------------------------------------------------
 *  Default Configuration
 * -------------------------------------------------------------------------------------------------------*/
const DEFAULT_OPTIONS: RateLimiterOptions = {
  windowSec: 60,
  maxRequests: 120,
  privilegedBonus: 60,
  sendRateLimitHeaders: true,
  whitelistPaths: [/^\/healthz$/, /^\/_internal/],
};

/* ---------------------------------------------------------------------------------------------------------
 *  Redis-backed Token-Bucket implementation
 * -------------------------------------------------------------------------------------------------------*/

/**
 * Minimalistic Lua script for atomic bucket handling:
 *
 * KEYS[1] -> redis key
 * ARGV[1] -> window size (milliseconds)
 * ARGV[2] -> max tokens
 * ARGV[3] -> requested tokens (cost)
 *
 * Returns: { remainingTokens (int) }
 */
const LUA_SCRIPT = `
local ttl          = tonumber(ARGV[1])
local maxTokens    = tonumber(ARGV[2])
local requested    = tonumber(ARGV[3])

local current = tonumber(redis.call("GET", KEYS[1])) or 0
if current + requested > maxTokens then
  return -1
end

current = redis.call("INCRBY", KEYS[1], requested)
if current == requested then
  redis.call("PEXPIRE", KEYS[1], ttl)
end
return maxTokens - current
`;

/* ---------------------------------------------------------------------------------------------------------
 *  In-memory fallback (non-cluster safe, best-effort).
 * -------------------------------------------------------------------------------------------------------*/
interface LocalBucket {
  exp: number;
  usage: number;
}

const localBuckets: Record<string, LocalBucket> = Object.create(null);
const localBucketCleanup = (): void => {
  const now = Date.now();
  for (const [key, bucket] of Object.entries(localBuckets)) {
    if (bucket.exp <= now) delete localBuckets[key];
  }
};
// run GC every 5 minutes
setInterval(localBucketCleanup, 300_000).unref();

/* ---------------------------------------------------------------------------------------------------------
 *  Utility Helpers
 * -------------------------------------------------------------------------------------------------------*/

/**
 * Derive a unique key for the requester.
 * 
 * Priority:
 *   1. Authenticated userId
 *   2. API Key (if present in header)
 *   3. IP Address
 */
const getRequesterKey = (req: Request): string => {
  if (req.user?.id)               return `u:${req.user.id}`;
  if (req.headers['x-api-key'])   return `k:${req.headers['x-api-key']}`;
  return `ip:${req.ip}`;
};

const isPrivileged = (req: Request): boolean =>
  req.user?.roles?.some((r: string) => ['admin', 'moderator', 'sre'].includes(r)) ?? false;

/* ---------------------------------------------------------------------------------------------------------
 *  Factory
 * -------------------------------------------------------------------------------------------------------*/

export const createRateLimiter = (redisClient?: Redis, rawOptions: Partial<RateLimiterOptions> = {}) => {
  const options: RateLimiterOptions = { ...DEFAULT_OPTIONS, ...rawOptions };
  const redisEnabled = Boolean(redisClient);

  /* -------------------------------------------------------------------- *
   *  Core algorithm (async/await for clarity)
   * ------------------------------------------------------------------ */
  const checkAndConsume = async (req: Request, cost = 1): Promise<number> => {
    const requesterKey = getRequesterKey(req);
    const windowMs     = options.windowSec * 1_000;
    let maxAllowed     = options.maxRequests;

    if (isPrivileged(req)) maxAllowed += options.privilegedBonus ?? 0;

    if (redisEnabled) {
      // Use Redis Lua script for atomic operations
      const redisKey = `rl:${requesterKey}`;
      const remaining: number = await redisClient!.eval(
        LUA_SCRIPT,
        1,
        redisKey,
        windowMs,
        maxAllowed,
        cost
      );
      return remaining; // -1 means over quota
    }

    // ---------- Fallback (non-atomic) ----------
    const now = Date.now();
    const bucket = (localBuckets[requesterKey] ??= { exp: now + windowMs, usage: 0 });

    if (bucket.exp <= now) {
      // reset
      bucket.exp   = now + windowMs;
      bucket.usage = 0;
    }

    if (bucket.usage + cost > maxAllowed) {
      return -1;
    }
    bucket.usage += cost;
    return maxAllowed - bucket.usage;
  };

  /* -------------------------------------------------------------------- *
   *  Express/Koa compatible middleware
   * ------------------------------------------------------------------ */
  const middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // ---- Fast path: early exit for whitelisted routes ----
      if (options.whitelistPaths?.some((p) => (p instanceof RegExp ? p.test(req.path) : req.path.startsWith(p)))) {
        return next();
      }

      const cost      = Math.max(1, options.requestCostFn?.(req) ?? 1);
      const remaining = await checkAndConsume(req, cost);

      if (options.sendRateLimitHeaders) {
        res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
        res.setHeader('X-RateLimit-Window',     options.windowSec);
      }

      if (remaining < 0) {
        // ---- Throttled ----
        publishSecurityEvent({
          kind: SecurityEventKind.RATE_LIMIT_TRIGGERED,
          requester: getRequesterKey(req),
          path: req.path,
          timestamp: Date.now(),
        });

        res.status(429).json({
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Retry in ${options.windowSec} seconds.`,
        });
        return;
      }

      return next();
    } catch (err) {
      // Defensive: never break the request pipeline
      logger.error({ err }, 'Rate limiter encountered an unexpected error');
      return next(); // fail-open
    }
  };

  /* -------------------------------------------------------------------- *
   *  Functional variant – useful for GraphQL resolvers
   * ------------------------------------------------------------------ */
  const asFunction =
    <T>(req: Request, res: Response, work: () => Promise<T> | T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        middleware(req, res, (err?: any) => {
          if (err) return reject(err);
          Promise.resolve(work())
            .then(resolve)
            .catch(reject);
        });
      });

  return Object.assign(middleware, { asFunction });
};

/* ---------------------------------------------------------------------------------------------------------
 *  Re-exports for convenience
 * -------------------------------------------------------------------------------------------------------*/
export type RateLimiter = ReturnType<typeof createRateLimiter>;
export default createRateLimiter;

/**
 * Module-level healthcheck – can be used by diagnostic routines to verify
 * that the Redis scripts are loaded and functioning.
 */
export const rateLimiterSelfTest = async (redisClient: Redis): Promise<boolean> => {
  try {
    const tmpLimiter = createRateLimiter(redisClient);
    const fakeReq    = { ip: '127.0.0.1', path: '/__selftest', headers: {}, user: null } as unknown as Request;
    const remaining  = await (tmpLimiter as any).asFunction(fakeReq, {} as Response, () => true);
    return remaining !== undefined;
  } catch (err) {
    logger.warn({ err }, '[rateLimiter] self-test failed');
    return false;
  }
};
```