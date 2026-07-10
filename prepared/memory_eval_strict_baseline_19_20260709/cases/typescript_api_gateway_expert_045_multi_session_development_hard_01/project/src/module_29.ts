```typescript
/**
 * SocialPulse Gateway – Response Cache Module
 *
 * This module centralises response-caching concerns for both REST and GraphQL
 * entry-points.  It provides:
 *
 *  • ResponseCacheService   – A small wrapper around ioredis that enforces sane
 *    defaults and structured keys.
 *  • restResponseCache       – An Express.js middleware that transparently
 *    caches JSON responses.
 *  • GraphQLCacheDirective   – A schema-level directive (`@cache`) that allows
 *    fine-grained control over resolver-level caching semantics.
 *
 *  • CacheScope enum         – Distinguishes between PUBLIC (same for everyone),
 *    AUTHENTICATED (varies by authenticated user) and PRIVATE (per-session)
 *    visibility.
 *
 * The cache key is composed from:
 *    <version> : <scope> : <resource-fingerprint>
 *
 * In production we back off to a sensible default TTL when the directive /
 * middleware is mis-configured to avoid accidental “infinite” caching.  All
 * operations are safe-guarded with timeouts & logging.
 *
 * The code below purposefully lives in a single file to keep module_29
 * self-contained, but in a real codebase you would split it into several files.
 */

import type { Request, Response, NextFunction } from 'express';
import { GraphQLFieldResolver, defaultFieldResolver, GraphQLSchema } from 'graphql';
import { SchemaDirectiveVisitor, makeExecutableSchema } from '@graphql-tools/schema';
import Redis, { Redis as RedisClient } from 'ioredis';
import crypto from 'crypto';
import ms from 'ms';
import pTimeout from 'p-timeout';
import { Logger } from './infrastructure/logger'; // <- project-local logger abstraction

/**************************************************************************************************
 * Configuration
 *************************************************************************************************/

export interface ResponseCacheConfig {
  /** fallback TTL when none is explicitly given (default: 60 seconds) */
  defaultTtl: number;
  /** hard upper bound for any TTL to avoid abuse (default: 1 hour) */
  maxTtl: number;
  /** redis key namespace */
  namespace: string;
  /** how long before giving up on redis (default: 200ms) */
  redisTimeout: number;
}

export enum CacheScope {
  PUBLIC = 'PUBLIC',               // Same for everyone (e.g. trending posts)
  AUTHENTICATED = 'AUTHENTICATED', // Varies by authenticated user id
  PRIVATE = 'PRIVATE',             // Per-session (e.g. draft stories)
}

/**************************************************************************************************
 * ResponseCacheService
 *************************************************************************************************/

export class ResponseCacheService {
  private readonly redis: RedisClient;
  private readonly cfg: ResponseCacheConfig;
  private readonly log: Logger;

  constructor(config: Partial<ResponseCacheConfig> = {}, logger = new Logger('ResponseCache')) {
    this.cfg = {
      defaultTtl: ms('60s') / 1000,
      maxTtl: ms('1h') / 1000,
      namespace: 'spg:cache',
      redisTimeout: ms('200ms'),
      ...config,
    };

    this.redis =
      'REDIS_URL' in process.env
        ? new Redis(process.env.REDIS_URL as string)
        : new Redis(); // fallback to localhost

    this.log = logger;

    this.redis.on('error', (err) => this.log.error('Redis error', err));
  }

  /**
   * Compose a stable cache key.
   * Example:   spg:cache/V1/PUBLIC/7cbb8cb0
   */
  buildKey(scope: CacheScope, fingerprint: string): string {
    return `${this.cfg.namespace}/V1/${scope}/${fingerprint}`;
  }

  /** Wrapper around redis.get with timeout protection */
  async get<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await pTimeout(this.redis.get(key), this.cfg.redisTimeout);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      this.log.warn('Cache read failed', { err, key });
      return null;
    }
  }

  /** Wrapper around redis.set with TTL & timeout protection */
  async set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const ttl = Math.min(Math.max(1, ttlSeconds), this.cfg.maxTtl);
    try {
      await pTimeout(this.redis.set(key, JSON.stringify(value), 'EX', ttl), this.cfg.redisTimeout);
    } catch (err) {
      this.log.warn('Cache write failed', { err, key });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await pTimeout(this.redis.del(key), this.cfg.redisTimeout);
    } catch (err) {
      this.log.warn('Cache delete failed', { err, key });
    }
  }

  /**
   * Executes the given fetcher and caches the result.  Subsequent calls will
   * hit redis until the TTL expires.
   */
  async withCache<T>(
    scope: CacheScope,
    fingerprint: string,
    ttl: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const cacheKey = this.buildKey(scope, fingerprint);
    const cached = await this.get<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    const fresh = await fetcher();
    await this.set(cacheKey, fresh, ttl);
    return fresh;
  }
}

/**************************************************************************************************
 * Express middleware for REST endpoints
 *************************************************************************************************/

export interface RestCacheOptions {
  /** TTL in seconds.  Specify `0` to bypass cache. */
  ttl?: number;
  scope?: CacheScope;
  /**
   * Optional method returning a custom fingerprint string for the request.
   * By default we hash  req.originalUrl + JSON.stringify(req.body)
   */
  fingerprint?(req: Request): string;
}

export const restResponseCache =
  (
    cache: ResponseCacheService,
    { ttl: ttlOverride, fingerprint: fpFn, scope = CacheScope.PUBLIC }: RestCacheOptions = {},
  ) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ttl = typeof ttlOverride === 'number' ? ttlOverride : cache['cfg'].defaultTtl;

    if (ttl <= 0 || req.method !== 'GET') {
      // Mutating or non-cacheable
      return next();
    }

    // Determine cache key
    const fp =
      fpFn?.(req) ??
      crypto
        .createHash('sha1')
        .update(req.originalUrl + JSON.stringify(req.query || {}) + (scope !== CacheScope.PUBLIC ? req.user?.id ?? '' : ''))
        .digest('hex');

    const key = cache.buildKey(scope, fp);

    try {
      const cachedPayload = await cache.get<string>(key);
      if (cachedPayload) {
        res.setHeader('X-SocialPulse-Cache', 'HIT');
        res.setHeader('Cache-Control', `public, max-age=${ttl}`);
        return res.json(JSON.parse(cachedPayload));
      }

      // Hijack res.json to intercept the payload
      const originalJson = res.json.bind(res);
      res.json = async (body: unknown) => {
        // We only cache successful (2xx) responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await cache.set(key, body, ttl);
        }
        res.setHeader('X-SocialPulse-Cache', 'MISS');
        res.setHeader('Cache-Control', `public, max-age=${ttl}`);
        return originalJson(body);
      };

      return next();
    } catch (err) {
      cache['log'].warn('REST cache middleware failed', { err });
      return next();
    }
  };

/**************************************************************************************************
 * GraphQL @cache directive
 *************************************************************************************************/

/**
 * Example usage in SDL:
 *
 *  type Query {
 *    latestPosts: [Post!]! @cache(ttl: 30, scope: PUBLIC)
 *  }
 */
interface CacheDirectiveArgs {
  ttl?: number;
  scope?: CacheScope;
}

export class GraphQLCacheDirective extends SchemaDirectiveVisitor {
  public visitFieldDefinition(field: any): void {
    this.wrapResolver(field);
  }

  private wrapResolver(field: any): void {
    const { resolve = defaultFieldResolver } = field;
    const { ttl = this.getCacheService().cfg.defaultTtl, scope = CacheScope.PUBLIC } =
      this.args as CacheDirectiveArgs;

    field.resolve = async (
      ...resolverArgs: Parameters<GraphQLFieldResolver<unknown, any>>
    ): Promise<unknown> => {
      const cache = this.getCacheService();
      const [, , ctx, info] = resolverArgs;

      const fingerprint = crypto
        .createHash('sha1')
        .update(info.fieldName + JSON.stringify(resolverArgs[1]) + JSON.stringify(ctx?.user?.id || ''))
        .digest('hex');

      return cache.withCache(scope as CacheScope, fingerprint, ttl, () =>
        Promise.resolve(resolve.apply(this, resolverArgs)),
      );
    };
  }

  private getCacheService(): ResponseCacheService {
    const { responseCache } = (this.schema as any)._cacheServiceRegistry ?? {};
    if (!responseCache) {
      throw new Error('ResponseCacheService not registered in GraphQL schema context');
    }
    return responseCache as ResponseCacheService;
  }
}

/**
 * Attaches the cache service to the schema for directive access and returns a
 * new executable schema.
 */
export function withCacheDirective(
  typeDefs: string | string[],
  resolvers: any,
  cache: ResponseCacheService,
): GraphQLSchema {
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
    schemaDirectives: {
      cache: GraphQLCacheDirective,
    },
  });

  // Hidden property to retrieve cache service in directive
  Object.defineProperty(schema, '_cacheServiceRegistry', {
    enumerable: false,
    configurable: false,
    value: { responseCache: cache },
  });

  return schema;
}

/**************************************************************************************************
 * Convenience bootstrap (used by module registry)
 *************************************************************************************************/

export function createResponseCacheService(logger?: Logger): ResponseCacheService {
  const cfg: Partial<ResponseCacheConfig> = {
    defaultTtl: process.env.RESPONSE_CACHE_DEFAULT_TTL
      ? Number(process.env.RESPONSE_CACHE_DEFAULT_TTL)
      : undefined,
    maxTtl: process.env.RESPONSE_CACHE_MAX_TTL ? Number(process.env.RESPONSE_CACHE_MAX_TTL) : undefined,
    namespace: process.env.RESPONSE_CACHE_NAMESPACE,
    redisTimeout: process.env.RESPONSE_CACHE_REDIS_TIMEOUT
      ? Number(process.env.RESPONSE_CACHE_REDIS_TIMEOUT)
      : undefined,
  };

  return new ResponseCacheService(cfg, logger);
}
```