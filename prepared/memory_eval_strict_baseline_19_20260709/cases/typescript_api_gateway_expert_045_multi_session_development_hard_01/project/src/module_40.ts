```typescript
/**
 * SocialPulse Gateway
 * src/module_40.ts
 *
 * Production-grade response caching utility that can be consumed by both
 * REST middleware (Express) and GraphQL resolvers.  Uses Redis for the
 * distributed cache layer and gracefully falls back to an in-process LRU
 * cache when Redis is unavailable in order to keep the gateway responsive.
 *
 * The cache key is derived from the HTTP method + pathname + sorted
 * query/body + authenticated user id (if any) to guarantee idempotency
 * while still ensuring per-user isolation on protected resources.
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import LRUCache from 'lru-cache';
import { Redis } from 'ioredis';
import ms from 'ms';
import { Logger } from './infrastructure/logger'; //   <-- project-local typed logger
import { InternalError } from './domain/errors/InternalError'; // <-- project-local error

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL = ms('2 minutes'); // fallback ttl when none is provided

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cacheable value wrapper.
 */
interface CacheRecord<T = unknown> {
  value: T;
  /**
   * ISO string; used when instructing downstream clients via `Cache-Control`.
   */
  expiresAt: string;
}

/**
 * Options accepted by ResponseCacheService
 */
interface ResponseCacheServiceOptions {
  /**
   * Overrides global TTL (in milliseconds) when `ttl` is omitted by callers.
   * Defaults to 2 minutes.
   */
  defaultTtl?: number;
  /**
   * In-process fallback cache size (entry count).  Set to 0 to disable LRU
   * fallback completely.
   */
  inMemoryEntries?: number;
  /**
   * Surfaces debug-level traces using the gateway’s structured logger.
   */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

export class ResponseCacheService {
  private readonly redis: Redis;
  private readonly defaultTtl: number;
  private readonly lru?: LRUCache<string, CacheRecord>;
  private readonly log: Logger;

  constructor(redis: Redis, opts: ResponseCacheServiceOptions = {}) {
    this.redis = redis;
    this.defaultTtl = opts.defaultTtl ?? DEFAULT_TTL;
    this.log = opts.logger ?? console;
    if ((opts.inMemoryEntries ?? 1000) > 0) {
      this.lru = new LRUCache<string, CacheRecord>({
        max: opts.inMemoryEntries ?? 1000,
      });
    }
  }

  // -----------------------------------------------------------------------
  // Generic helpers
  // -----------------------------------------------------------------------

  /**
   * Fetches the cached value if present or resolves `fallback()` and stores
   * the result for future callers.
   *
   * @param key Cache key
   * @param ttl Time-to-live in milliseconds
   * @param fallback Value factory when cache-miss occurs
   */
  async getOrSet<T>(
    key: string,
    ttl = this.defaultTtl,
    fallback: () => Promise<T>,
  ): Promise<T> {
    // Try Redis first (hot path).
    try {
      const redisHit = await this.redis.get(key);
      if (redisHit) {
        this.trace(`redis-hit`, key);
        return JSON.parse(redisHit) as T;
      }
    } catch (err) {
      this.log.error(err, 'Redis failure, falling back to LRU cache');
    }

    // Try in-process LRU (if configured).
    if (this.lru) {
      const lruHit = this.lru.get(key);
      if (lruHit && Date.parse(lruHit.expiresAt) > Date.now()) {
        this.trace(`lru-hit`, key);
        return lruHit.value as T;
      }
    }

    // Cache-miss; execute user-provided factory.
    this.trace(`miss`, key);
    const value = await fallback();

    const record: CacheRecord = {
      value,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
    };
    const serialized = JSON.stringify(record);

    // Persist to Redis.
    try {
      await this.redis.set(key, serialized, 'PX', ttl);
    } catch (err) {
      this.log.error(err, 'Could not write to Redis');
    }

    // Persist to in-process LRU.
    if (this.lru) {
      this.lru.set(key, record, { ttl });
    }

    return value;
  }

  /**
   * Generates a safe cache key from an Express request.  Includes:
   *   method + path + sorted query + sorted body + userId?
   */
  buildHttpCacheKey(req: Request): string {
    const { method, path, query, body } = req;

    const queryPart = JSON.stringify(sortObjectKeys(query));
    const bodyPart =
      method === 'GET' || method === 'HEAD'
        ? ''
        : JSON.stringify(sortObjectKeys(body));
    const userPart = (req as any).auth?.userId ?? 'anon';

    const rawKey = `${method}|${path}|${queryPart}|${bodyPart}|u=${userPart}`;
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    return `http:${hash}`;
  }

  /**
   * Express middleware that returns cached responses for idempotent requests
   * and subsequently stores fresh responses.
   *
   * Usage:
   *   app.get('/public/timeline', cacheService.expressMiddleware(ms('10s')), controller);
   */
  expressMiddleware(ttl = this.defaultTtl) {
    return async (req: Request, res: Response, next: NextFunction) => {
      // Only cache safe methods (GET, HEAD).
      if (!['GET', 'HEAD'].includes(req.method)) {
        return next();
      }

      const key = this.buildHttpCacheKey(req);

      // Attempt to serve from cache.
      try {
        const cached = await this.getOrSet<CacheRecord | null>(
          key,
          ttl,
          async () => null, // Don’t execute fallback yet; we only want to get()
        );
        if (cached) {
          this.trace(`express-cache-hit`, key);
          setCacheHeaders(res, ttl, true);
          return res.json(cached);
        }
      } catch (err) {
        this.log.warn(err, 'Cache read failure, proceeding to next()');
      }

      // Hijack res.json to store the payload when controller completes.
      const originalJson = res.json.bind(res);
      res.json = async (payload: any) => {
        originalJson(payload);

        // Save asynchronously; client response is already on its way.
        this.getOrSet(key, ttl, async () => payload).catch((err) =>
          this.log.error(err, 'Failed to save HTTP response to cache'),
        );

        setCacheHeaders(res, ttl, false);
        return res;
      };

      next();
    };
  }

  // -----------------------------------------------------------------------
  // GraphQL utilities
  // -----------------------------------------------------------------------

  /**
   * Wraps a GraphQL field resolver to add response caching. Field-level TTL
   * is controlled by `ttl` argument.  Cache key is derived from:
   *   typename + field + args + authenticated user id
   *
   * @example
   *   const cachedResolver = cacheService.withGraphQLCache(resolveFn, ms('5s'));
   *   ...
   *   Post: {
   *     comments: cachedResolver
   *   }
   */
  withGraphQLCache<TArgs extends Record<string, any>, TResult>(
    resolver: (
      parent: unknown,
      args: TArgs,
      context: { user?: { id: string } },
      info: any,
    ) => Promise<TResult> | TResult,
    ttl = this.defaultTtl,
  ) {
    return async (
      parent: unknown,
      args: TArgs,
      context: { user?: { id: string } },
      info: any,
    ): Promise<TResult> => {
      const userId = context.user?.id ?? 'anon';
      const rawKey =
        info?.parentType?.name +
        ':' +
        info?.fieldName +
        ':' +
        crypto
          .createHash('sha256')
          .update(JSON.stringify(sortObjectKeys(args)))
          .digest('hex') +
        `:u=${userId}`;

      const key = `gql:${rawKey}`;

      return this.getOrSet(key, ttl, () => Promise.resolve(resolver(parent, args, context, info)));
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private trace(event: string, key: string) {
    if (process.env.NODE_ENV !== 'production') {
      this.log.debug({ event, key }, '[cache]');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively sorts object keys to guarantee stable JSON stringification.
 */
function sortObjectKeys<T extends Record<string, any>>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }

  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = sortObjectKeys(obj[k]);
      return acc;
    }, {} as any);
}

/**
 * Adds Cache-Control & Expires headers so downstream CDNs/browsers respect
 * the server-side cache policy.
 */
function setCacheHeaders(res: Response, ttl: number, fromCache: boolean) {
  const secs = Math.floor(ttl / 1000);
  res.setHeader('Cache-Control', `public, max-age=${secs}`);
  res.setHeader('Expires', new Date(Date.now() + ttl).toUTCString());
  if (fromCache) {
    res.setHeader('X-Cache', 'HIT');
  } else {
    res.setHeader('X-Cache', 'MISS');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired ResponseCacheService, making sure Redis connectivity
 * is verified at boot time.  Throws an InternalError when Redis is not
 * reachable to prevent the gateway from starting in a half-broken state.
 */
export async function createResponseCacheService(
  redis: Redis,
  opts: Omit<ResponseCacheServiceOptions, 'logger'> & { logger: Logger },
): Promise<ResponseCacheService> {
  try {
    await redis.ping();
  } catch (err) {
    opts.logger.fatal(err, 'Redis unavailable during boot; aborting');
    throw new InternalError('Redis is unavailable');
  }

  return new ResponseCacheService(redis, opts);
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export type { ResponseCacheServiceOptions as CacheOptions };
```