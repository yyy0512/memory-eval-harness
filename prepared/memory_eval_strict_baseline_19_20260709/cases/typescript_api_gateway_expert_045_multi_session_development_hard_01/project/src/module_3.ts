```typescript
/**
 * module_3.ts
 * SocialPulse Gateway – Adaptive, Redis-backed rate-limiting infrastructure.
 *
 * This module provides a production-grade, token-bucket rate-limiter that can be
 * mounted both on REST (Express) and GraphQL (Apollo) entry points.  It supports:
 *  • Per-route, per-API-key, or per-user scoping
 *  • Sliding-window token bucket implemented in Redis (cluster-safe)
 *  • Dynamic “version” channels (v1, v2 …) so each public API version can have
 *    independent quotas
 *  • Observability hooks (pino logger + Prometheus counter)
 *  • First-class TypeScript types & clean-architecture independence
 *
 * The code purposefully relies *only* on generic abstractions; no imports point
 * back into concrete controllers/resolvers so the module can live in the
 * “infrastructure” layer.
 */

import { Request, Response, NextFunction } from 'express';
import { Logger } from 'pino';
import Redis, { RedisOptions } from 'ioredis';
import httpStatus from 'http-status';
import { Counter, register as promRegister } from 'prom-client';
import ms from 'ms';

/* -------------------------------------------------------------------------- */
/*                            Shared / Domain Types                           */
/* -------------------------------------------------------------------------- */

/** Shape of the error payload returned when a consumer hits the quota limit */
export interface RateLimitErrorBody {
  statusCode: number;
  error: string;
  message: string;
  resetAt: number;
}

/** Public options for bootstrapping the rate limiter */
export interface RateLimiterOptions {
  /**
   * Max number of requests allowed in the given window (token bucket capacity)
   */
  limit: number;
  /**
   * Sliding window size in milliseconds. Default: 1 minute.
   */
  windowMs?: number;
  /**
   * If a route supports versioning (`v1`, `v2`, …) this value will be appended
   * to the Redis key, effectively isolating quotas across versions.
   */
  apiVersion?: string;
  /**
   * Extracts a unique identifier for the *consumer*:
   *   • API Key from headers (recommended)
   *   • Authenticated user ID
   *   • IP address (fallback)
   */
  keyGenerator?: (req: Request) => string;
  /**
   * Optionally skip rate-limiting logic (e.g., internal health checks)
   */
  skip?: (req: Request) => boolean;
  /**
   * Hook called when the request is rejected. Useful to plug analytics.
   */
  onLimitReached?: (req: Request, res: Response) => void | Promise<void>;
  /**
   * Provide a custom Redis instance in high-availability setups
   */
  redis?: Redis;
  /**
   * Custom pino logger (defaults to noop console)
   */
  logger?: Logger;
  /**
   * Optional: change the namespace/prefix for Redis keys
   */
  redisKeyPrefix?: string;
}

/* -------------------------------------------------------------------------- */
/*                         Internal / implementation details                  */
/* -------------------------------------------------------------------------- */

interface BucketState {
  remaining: number;
  resetAt: number;
}

/**
 * Default implementations follow the gateway conventions
 * (API key via `x-api-key`, pino logger with child bindings, etc.)
 */
const DEFAULT_KEY_GENERATOR = (req: Request): string =>
  req.header('x-api-key') ||
  (req as any).user?.id || // GraphQL JWT decorated on req.user
  req.ip;

const DEFAULT_SKIP = (req: Request): boolean =>
  req.path.startsWith('/health') || req.method === 'OPTIONS';

const DEFAULT_LOGGER: Logger = {
  /* eslint-disable @typescript-eslint/no-empty-function */
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => DEFAULT_LOGGER,
  /* eslint-enable @typescript-eslint/no-empty-function */
} as unknown as Logger;

/* -------------------------------------------------------------------------- */
/*                              Prometheus metric                             */
/* -------------------------------------------------------------------------- */

const rateLimitCounter = new Counter({
  name: 'socialpulse_rate_limiter_rejections_total',
  help: 'Total number of requests rejected by the API rate limiter',
  labelNames: ['route', 'version'],
});

/* -------------------------------------------------------------------------- */
/*                            Redis Script (Lua SHA)                          */
/* -------------------------------------------------------------------------- */

/**
 * Atomic token bucket operations happen directly inside Redis through an
 * embedded Lua script.  The script:
 *  1. Creates the key with remaining=limit if it doesn’t exist (SETNX + EXPIRE)
 *  2. Decrements the bucket (DECR)
 *  3. Returns [remaining, ttl] so the caller can craft response headers
 *
 * Because Lua scripts run atomically in Redis, we avoid race conditions when
 * hundreds of concurrent requests hit the same key.
 *
 * NOTE: The script is intentionally inlined for readability.
 */
const tokenBucketLuaScript = `
  local key       = KEYS[1]
  local capacity  = tonumber(ARGV[1])
  local window    = tonumber(ARGV[2])

  local current   = redis.call("INCR", key)

  if current == 1 then
    redis.call("PEXPIRE", key, window)
  end

  local remaining = capacity - current
  local ttl       = redis.call("PTTL", key)

  return { remaining, ttl }
`;

/* -------------------------------------------------------------------------- */
/*                               Main middleware                              */
/* -------------------------------------------------------------------------- */

/**
 * Builds an Express middleware that enforces token-bucket rate limiting.
 * Entirely functional / stateless; safe to instantiate multiple times.
 */
export function rateLimiter(options: RateLimiterOptions) {
  const {
    limit,
    windowMs = ms('1m'),
    apiVersion = 'v1',
    keyGenerator = DEFAULT_KEY_GENERATOR,
    skip = DEFAULT_SKIP,
    onLimitReached,
    redis = new Redis(process.env.REDIS_URL as string, {
      enableOfflineQueue: false,
    } as RedisOptions),
    logger = DEFAULT_LOGGER,
    redisKeyPrefix = 'sp:ratelimit',
  } = options;

  // Pre-load the Lua script in Redis & cache its SHA for evalsha
  let scriptSha: string | undefined;

  (async () => {
    try {
      scriptSha = await redis.script('load', tokenBucketLuaScript);
      logger.info(
        { module: 'rateLimiter', scriptSha },
        'Rate-limiter Lua script pre-loaded in Redis',
      );
    } catch (err) {
      logger.error(
        { err },
        'Failed to pre-load rate limiter script. Falling back to EVAL',
      );
    }
  })();

  /**
   * Execute the Lua script and transform the result into a BucketState.
   */
  async function hitBucket(key: string): Promise<BucketState> {
    const evalArgs: (string | number)[] = [
      scriptSha ?? tokenBucketLuaScript, // Use SHA if loaded or raw script
      scriptSha ? 1 : 0, // numKeys for EVALSHA but 0 for EVAL (will be added)
      key,
      limit,
      windowMs,
    ];

    let result: [number, number];

    try {
      if (scriptSha) {
        // EVALSHA sha1 1 key arg1 arg2 …
        result = (await redis.evalsha(
          evalArgs[0] as string,
          1,
          key,
          limit,
          windowMs,
        )) as [number, number];
      } else {
        // EVAL script 1 key arg1 arg2 …
        result = (await redis.eval(
          evalArgs[0] as string,
          1,
          key,
          limit,
          windowMs,
        )) as [number, number];
      }
      const [remaining, ttl] = result;
      return { remaining, resetAt: Date.now() + ttl };
    } catch (err: any) {
      // Redis down? Graceful degradation – allow traffic and log as ERROR.
      logger.error(
        { err, key },
        'Redis error while executing rate-limit check – _failing open_',
      );
      return {
        remaining: Number.MAX_SAFE_INTEGER,
        resetAt: Date.now() + windowMs,
      };
    }
  }

  /* ----------------------------- Actual handler --------------------------- */
  return async function rateLimitingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    try {
      if (skip(req)) {
        return next();
      }

      const consumerKey = keyGenerator(req);

      if (!consumerKey) {
        // Protect the system – deny anonymous requests with 400
        return res.status(httpStatus.BAD_REQUEST).json({
          statusCode: httpStatus.BAD_REQUEST,
          error: 'Bad Request',
          message: 'Missing API key or identifier for rate limiting',
        } as RateLimitErrorBody);
      }

      // Example final key:  sp:ratelimit:v1:GET:/timeline:user-apiKey
      const redisKey =
        `${redisKeyPrefix}:${apiVersion}:${req.method}:${req.baseUrl || req.path}` +
        `:${consumerKey}`;

      const { remaining, resetAt } = await hitBucket(redisKey);

      // Expose rate-limit metadata via RFC-compliant headers
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

      if (remaining < 0) {
        rateLimitCounter.inc({ route: req.path, version: apiVersion });
        onLimitReached && (await onLimitReached(req, res));

        const body: RateLimitErrorBody = {
          statusCode: httpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again in ${Math.ceil(
            (resetAt - Date.now()) / 1000,
          )} seconds`,
          resetAt,
        };

        logger.warn(
          {
            module: 'rateLimiter',
            consumerKey,
            path: req.path,
            remaining,
            resetAt,
          },
          'Quota exceeded – request rejected',
        );

        return res.status(httpStatus.TOO_MANY_REQUESTS).json(body);
      }

      next();
    } catch (err) {
      logger.error({ err }, 'Unexpected error in rate limiting middleware');
      next(err);
    }
  };
}

/* -------------------------------------------------------------------------- */
/*                       GraphQL (Apollo) integration helper                  */
/* -------------------------------------------------------------------------- */

import {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from 'apollo-server-plugin-base';

interface GraphQLRateLimiterPluginOptions
  extends Omit<RateLimiterOptions, 'skip'> {}

/**
 * Drop-in plugin for Apollo Server 3/4 that executes the same rate-limiting
 * logic but at the GraphQL operation level instead of HTTP request level.
 *
 * Usage:
 *   const apollo = new ApolloServer({
 *     schema,
 *     plugins: [graphqlRateLimiter({ limit: 200, windowMs: ms('15m') })]
 *   });
 */
export function graphqlRateLimiter(
  opts: GraphQLRateLimiterPluginOptions,
): ApolloServerPlugin {
  const httpMiddleware = rateLimiter({
    ...opts,
    // Skip because we handle inside GraphQL plugin
    skip: () => false,
  });

  return {
    async requestDidStart(): Promise<GraphQLRequestListener> {
      return {
        async didResolveOperation(ctx) {
          const { request, response } = ctx as any;
          // NOTE: `httpMiddleware` expects Express req/res objects.  Apollo
          // exposes them under .request.http & .response.http
          return new Promise<void>((resolve, reject) => {
            httpMiddleware(
              request?.http,
              response?.http,
              (err?: any) => (err ? reject(err) : resolve()),
            );
          });
        },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                         DTO for OpenAPI documentation                      */
/* -------------------------------------------------------------------------- */

/**
 * The following JSDoc tags are leveraged by tooling such as `tsoa` or
 * `nestjs/swagger` to automatically add the 429 error response to every route
 * that consumes this middleware.  Keeping the definition co-located prevents
 * drift between doc and runtime behavior.
 */

/**
 * @openapi
 * components:
 *   responses:
 *     TooManyRequests:
 *       description: Rate limit exceeded
 *       headers:
 *         X-RateLimit-Limit:
 *           description: The request quota for the given window
 *           schema:
 *             type: string
 *         X-RateLimit-Remaining:
 *           description: The number of requests left in the current window
 *           schema:
 *             type: string
 *         X-RateLimit-Reset:
 *           description: Unix timestamp at which the current window resets
 *           schema:
 *             type: string
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               statusCode:
 *                 type: integer
 *                 example: 429
 *               error:
 *                 type: string
 *                 example: Too Many Requests
 *               message:
 *                 type: string
 *               resetAt:
 *                 type: integer
 */
```