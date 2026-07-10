```typescript
// File: src/module_31.ts
// Purpose: Centralised response–caching utilities (Redis-backed) for both REST
//          controllers (Express) and GraphQL resolvers (ApolloServer).
// -------------------------------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import RedisClient from 'ioredis';
import pino from 'pino';

import {
  ApolloServerPlugin,
  GraphQLRequestContextWillSendResponse,
} from '@apollo/server';

/**
 * Logical scope that determines cache–key composition and eviction semantics.
 * PUBLIC → response can be shared between users (e.g. trending posts),
 * USER   → response is specific to a particular user (e.g. home timeline).
 */
export enum CacheScope {
  PUBLIC = 'PUBLIC',
  USER = 'USER',
}

/**
 * Options used when creating a cache key or setting a cached value.
 */
export interface CacheOptions {
  /**
   * TTL in seconds. Defaults to `defaultTtlSeconds` configured on the
   * ResponseCache instance.
   */
  ttlSeconds?: number;

  /**
   * Scoping information influences both key generation *and* eviction patterns.
   */
  scope?: CacheScope;

  /**
   * Optional identifier for an API version or algorithm version (e.g. "v2").
   * Including the version avoids serving stale data across rollout boundaries.
   */
  version?: string;
}

/**
 * Composite information required to build a deterministic cache key.
 * `params` and `query` are stringified in a stable order.
 */
export interface RequestSnapshot {
  method: string;
  path: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  userId?: string; // only populated when scope === USER
  version: string;
}

/* -------------------------------------------------------------------------------------------------
 * ResponseCache Class
 * -------------------------------------------------------------------------------------------------*/

/**
 * Lightweight wrapper around Redis providing higher–level helper utilities that
 * are aware of the SocialPulse Gateway domain (user scoping, versioning, etc.).
 */
export class ResponseCache {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly defaultTtlSeconds: number;

  constructor(
    redis: Redis,
    logger: Logger = pino({ name: 'ResponseCache' }),
    defaultTtlSeconds = 60,
  ) {
    this.redis = redis;
    this.logger = logger;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  /**
   * Generate cache key from snapshot + options.
   */
  public generateKey(
    snap: RequestSnapshot,
    { scope = CacheScope.PUBLIC }: CacheOptions = {},
  ): string {
    const base = [
      'cache',
      scope.toLowerCase(),
      snap.version,
      snap.method,
      snap.path,
      stableStringify(snap.params),
      stableStringify(snap.query),
    ]
      .filter(Boolean)
      .join('|');

    return scope === CacheScope.USER && snap.userId
      ? `${base}|uid:${snap.userId}`
      : base;
  }

  /**
   * Retrieve JSON–serialised payload from Redis and parse it.
   */
  public async get<T>(key: string): Promise<T | undefined> {
    try {
      const hit = await this.redis.get(key);
      if (!hit) return undefined;
      this.logger.debug({ key }, 'cache hit');
      return JSON.parse(hit) as T;
    } catch (err) {
      this.logger.warn(
        { err, key },
        'Failed to fetch from cache (falling back to origin)',
      );
      return undefined;
    }
  }

  /**
   * Store value in Redis; value is *stringified* before insertion.
   */
  public async set<T>(
    key: string,
    value: T,
    { ttlSeconds = this.defaultTtlSeconds }: CacheOptions = {},
  ): Promise<void> {
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      this.logger.debug({ key, ttlSeconds }, 'cache set');
    } catch (err) {
      this.logger.error({ err, key }, 'Failed to set cache entry');
    }
  }

  /**
   * Higher–order utility to wrap expensive calls transparently.
   */
  public async getOrSet<T>(
    key: string,
    opts: CacheOptions,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const existing = await this.get<T>(key);
    if (existing !== undefined) return existing;

    const fresh = await fetcher();
    await this.set(key, fresh, opts);
    return fresh;
  }

  /**
   * Evict keys by prefix (use with caution). Returns number of keys deleted.
   */
  public async invalidateByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        '1000',
      );
      cursor = nextCursor;
      if (keys.length) {
        deleted += await this.redis.del(...keys);
      }
    } while (cursor !== '0');

    this.logger.info({ prefix, deleted }, 'cache invalidation complete');
    return deleted;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Express Middleware
 * -------------------------------------------------------------------------------------------------*/

/**
 * Factory that produces Express middleware for GET endpoints.
 * Non‐idempotent methods (POST, PUT, DELETE, …) are passed through untouched.
 */
export function createCacheMiddleware(
  cache: ResponseCache,
  options: CacheOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  return async function cacheMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (req.method !== 'GET') return next();

    const snapshot: RequestSnapshot = {
      method: req.method,
      path: req.path,
      params: req.params,
      query: req.query as Record<string, unknown>,
      userId: options.scope === CacheScope.USER ? req.user?.id : undefined,
      version: options.version ?? 'v1',
    };

    const key = cache.generateKey(snapshot, options);
    const cached = await cache.get<unknown>(key);
    if (cached !== undefined) {
      // Serve the cached payload immediately
      return res.json(cached);
    }

    // Monkey–patch `res.json` in order to capture the outbound payload
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      cache
        .set(key, body, options)
        .catch((err) =>
          cache['logger'].error(
            { err, key },
            'Failed to write response to cache',
          ),
        );
      return originalJson(body);
    };

    return next();
  };
}

/* -------------------------------------------------------------------------------------------------
 * Apollo Server Plugin (GraphQL)
 * -------------------------------------------------------------------------------------------------*/

/**
 * Opportunistic response caching for root–level GraphQL operations
 * (queries only—mutations are skipped).
 */
export function createApolloResponseCachePlugin(
  cache: ResponseCache,
  { ttlSeconds = 30, scope = CacheScope.PUBLIC } = {},
): ApolloServerPlugin {
  return {
    async requestWillSendResponse(
      ctx: GraphQLRequestContextWillSendResponse<Record<string, unknown>>,
    ) {
      const isQueryOperation =
        ctx.operation?.operation === 'query' && !ctx.errors?.length;
      if (!isQueryOperation) return;

      const snapshot: RequestSnapshot = {
        method: 'GRAPHQL',
        path: ctx.request.operationName ?? 'anonymous',
        params: undefined,
        query: ctx.request.variables ?? {},
        userId: scope === CacheScope.USER ? ctx.contextValue?.user?.id : undefined,
        version: ctx.request.http?.headers.get('x-api-version') ?? 'v1',
      };

      const key = cache.generateKey(snapshot, { scope });

      // GraphQL plugin lifecycle means we can't intercept *before* resolver run,
      // therefore we do only 'set' here—reads should be implemented via
      // `documentStore` or `automatic persisted queries`, but this keeps
      // example concise.
      await cache.set(key, ctx.response?.body, { ttlSeconds, scope });
    },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Helper Utilities
 * -------------------------------------------------------------------------------------------------*/

/**
 * Stable stringify that sorts object keys to guarantee deterministic output.
 * Borrowed from JSON.stringify spec with stable ordering.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value);

  return JSON.stringify(sortObject(value as Record<string, unknown>));
}

function sortObject<T extends Record<string, unknown>>(unordered: T): T {
  return Object.keys(unordered)
    .sort()
    .reduce((obj, key) => {
      const val = unordered[key];
      obj[key] =
        val && typeof val === 'object' && !Array.isArray(val)
          ? sortObject(val as Record<string, unknown>)
          : val;
      return obj;
    }, {} as T);
}

/* -------------------------------------------------------------------------------------------------
 * Convenience Bootstrap (optional)
 * -------------------------------------------------------------------------------------------------*/

let _singletonCache: ResponseCache | undefined;

/**
 * Eager bootstrap for processes that prefer a shared cache instance.
 * This helper is *optional*; DI frameworks (Inversify, NestJS, etc.) might
 * replace it with their own provider mechanism.
 */
export function getResponseCacheSingleton(): ResponseCache {
  if (_singletonCache) return _singletonCache;

  const redisUrl =
    process.env.REDIS_URL ??
    'redis://localhost:6379/0'; /* fallback for local dev */

  const redis = new RedisClient(redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    lazyConnect: true,
  });

  const logger = pino({ name: 'ResponseCache' }).child({ redisUrl });
  redis.on('error', (err) => logger.error({ err }, 'Redis error'));

  _singletonCache = new ResponseCache(redis, logger, 60);
  return _singletonCache;
}
```