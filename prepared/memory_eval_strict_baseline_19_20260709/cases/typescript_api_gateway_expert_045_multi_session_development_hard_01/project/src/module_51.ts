```typescript
/****************************************************************************************
 * File:        src/module_51.ts
 * Project:     SocialPulse Gateway (api_gateway)
 * Description: Production-grade response-caching subsystem (Redis-backed) that can be
 *              reused by both REST controllers and GraphQL resolvers.  The module
 *              exposes:
 *                • A generic CacheProvider interface
 *                • A concrete RedisCacheProvider implementation
 *                • A high-level ResponseCacheService abstraction
 *                • An idiomatic @Cacheable decorator for CQ RS/Resolver methods
 *                • Minimal, framework-agnostic HTTP middleware factory
 *
 *              Caching is orthogonal to the business logic and respects clean
 *              architecture boundaries by living in the infrastructure layer while
 *              remaining environment-agnostic (Express, Fastify, Apollo, etc.).
 *
 * Author:      SocialPulse Core Team
 ****************************************************************************************/

import crypto from 'crypto';
import { Redis, RedisOptions } from 'ioredis';

/**
 * --------
 * Type-level contracts
 * --------
 */

/**
 * An opaque cache key string.  Although concrete implementations use Redis,
 * callers should not rely on implementation details (e.g. prefixing strategy).
 */
export type CacheKey = string;

/**
 * Context information for building deterministic cache keys.
 * Add fields as needed (e.g. `device`, `locale`, `authScope`, …).
 */
export interface CacheKeyContext {
  /**
   * Logical route identifier (`timeline#getPublicFeed`, `graphql#Query.trending`, …)
   */
  readonly namespace: string;
  /**
   * User for whom the resource is being fetched (nullable for public endpoints)
   */
  readonly userId?: string;
  /**
   * Arbitrary serialisable parameters (query params, GraphQL args, etc.)
   */
  readonly params: unknown;
  /**
   * Version of the algorithm / resource we are serving.
   * Allows blue-green deploys, A/B experiments, etc.
   */
  readonly version?: string | number;
}

/**
 * Contract that every concrete caching backend must fulfil.
 * Methods mirror a subset of Redis semantics but do not leak any Redis-specific
 * types (e.g. Buffers, `null` vs `undefined`, etc.).
 */
export interface CacheProvider {
  /**
   * Retrieve a value from cache.
   */
  get<T = unknown>(key: CacheKey): Promise<T | undefined>;

  /**
   * Persist a value under a given key for `ttlSeconds`.
   */
  set<T = unknown>(key: CacheKey, value: T, ttlSeconds: number): Promise<void>;

  /**
   * Remove an entry from cache—useful when invalidating by key.
   */
  del(key: CacheKey): Promise<void>;

  /**
   * Best-effort flush of *all* cache keys which belong to a namespace.
   * (Implementation may prefix keys with namespace internally.)
   */
  flushNamespace?(namespace: string): Promise<void>;
}

/**
 * --------
 * Redis-backed implementation
 * --------
 */

export interface RedisCacheProviderOptions {
  redisOptions: RedisOptions;
  /**
   * When set, all keys are automatically prefixed.  In multi-tenant deployments,
   * each environment (staging/prod) or microservice can be siloed.
   */
  globalPrefix?: string;
  /**
   * Namespaces get hashed by default to avoid long keys; set to `false`
   * if you prefer plain-text namespaces for easier debugging.
   */
  hashNamespace?: boolean;
}

export class RedisCacheProvider implements CacheProvider {
  private readonly client: Redis;
  private readonly globalPrefix: string;
  private readonly hashNamespace: boolean;

  public constructor(options: RedisCacheProviderOptions) {
    this.client = new Redis(options.redisOptions);
    this.globalPrefix = options.globalPrefix ?? 'spg'; // SocialPulse Gateway
    this.hashNamespace = options.hashNamespace ?? true;

    // Bind error listeners so that connection hiccups are not silently swallowed.
    this.client.on('error', (err) =>
      // eslint-disable-next-line no-console
      console.error('[RedisCacheProvider] connection error:', err),
    );
  }

  /** @inheritDoc */
  public async get<T = unknown>(key: CacheKey): Promise<T | undefined> {
    const redisKey = this.toRedisKey(key);
    try {
      const raw = await this.client.get(redisKey);
      if (raw == null) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      // Fail fast but do not crash the whole process
      // eslint-disable-next-line no-console
      console.error(`[RedisCacheProvider] GET failed for key ${redisKey}`, err);
      return undefined;
    }
  }

  /** @inheritDoc */
  public async set<T = unknown>(
    key: CacheKey,
    value: T,
    ttlSeconds: number,
  ): Promise<void> {
    const redisKey = this.toRedisKey(key);
    try {
      await this.client.set(redisKey, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[RedisCacheProvider] SET failed for key ${redisKey}`, err);
    }
  }

  /** @inheritDoc */
  public async del(key: CacheKey): Promise<void> {
    const redisKey = this.toRedisKey(key);
    try {
      await this.client.del(redisKey);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[RedisCacheProvider] DEL failed for key ${redisKey}`, err);
    }
  }

  /** @inheritDoc */
  public async flushNamespace(namespace: string): Promise<void> {
    // Use SCAN to avoid blocking Redis in production.
    const prefix = `${this.globalPrefix}:${this.maybeHash(namespace)}:*`;
    const stream = this.client.scanStream({ match: prefix });
    const pipeline = this.client.pipeline();
    stream.on('data', (keys: string[]) => {
      for (const key of keys) pipeline.del(key);
    });
    await new Promise((res, rej) => {
      stream.on('end', res);
      stream.on('error', rej);
    });
    await pipeline.exec();
  }

  /**
   * Expose raw Redis client for advanced usage (e.g. metrics).
   * Keep it read-only to discourage coupling to Redis features at call-site.
   */
  public get redis(): Readonly<Redis> {
    return this.client;
  }

  /**
   * Build deterministic Redis keys while avoiding length limits (512 MB total
   * but only 1 GB per string).  For API keys we typically stay way below that.
   */
  private toRedisKey(fullKey: CacheKey): string {
    // Already prefixed?  Fine—do not double-prefix.
    if (fullKey.startsWith(`${this.globalPrefix}:`)) return fullKey;
    return `${this.globalPrefix}:${fullKey}`;
  }

  private maybeHash(input: string): string {
    return this.hashNamespace ? sha1(input) : input;
  }
}

/**
 * --------
 * ResponseCacheService – facade to be consumed by application layer
 * --------
 */

export interface ResponseCacheServiceOptions {
  /**
   * Default TTL (in seconds) for endpoints that do not specify one.
   * Hot feeds can be as low as 15–30 s, immutable resources (e.g. user avatars)
   * can be 1h+.  Keep defaults conservative.
   */
  defaultTtlSeconds?: number;
  /**
   * Exempt selected namespaces from caching altogether.
   * A namespace could be a RestController or GraphQL type.
   */
  denylistNamespaces?: ReadonlySet<string>;
}

export class ResponseCacheService {
  private readonly provider: CacheProvider;
  private readonly defaultTtl: number;
  private readonly denylistNamespaces: Set<string>;

  public constructor(
    provider: CacheProvider,
    options: ResponseCacheServiceOptions = {},
  ) {
    this.provider = provider;
    this.defaultTtl = options.defaultTtlSeconds ?? 30;
    this.denylistNamespaces = new Set(options.denylistNamespaces ?? []);
  }

  /**
   * High-level convenience method: given a context and an async callback,
   * return the cached value or compute + store it on a cache miss.
   */
  public async getOrSet<T>(
    ctx: CacheKeyContext,
    fetcher: () => Promise<T>,
    ttlOverrideSeconds?: number,
  ): Promise<T> {
    if (this.isCacheBypassed(ctx)) {
      return fetcher();
    }

    const key = buildCacheKey(ctx);
    const cached = await this.provider.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }

    const fresh = await fetcher();
    const ttl = ttlOverrideSeconds ?? this.defaultTtl;
    // Do not cache undefined/null results to avoid confusing the caller
    if (fresh !== undefined && fresh !== null) {
      await this.provider.set(key, fresh, ttl);
    }
    return fresh;
  }

  public async invalidate(ctx: CacheKeyContext): Promise<void> {
    const key = buildCacheKey(ctx);
    await this.provider.del(key);
  }

  /**
   * Namespaces can opt-out from caching completely.
   */
  private isCacheBypassed(ctx: CacheKeyContext): boolean {
    return this.denylistNamespaces.has(ctx.namespace);
  }
}

/**
 * --------
 * Decorator – `@Cacheable`
 * --------
 */
/* eslint-disable @typescript-eslint/ban-types */
export interface CacheableOptions
  extends Omit<CacheKeyContext, 'params' | 'userId'> {
  /**
   * TTL override (in seconds).  When omitted, ResponseCacheService default wins.
   */
  ttlSeconds?: number;
}

export function Cacheable(options: CacheableOptions): MethodDecorator {
  return (target, propertyKey, descriptor: PropertyDescriptor): void => {
    const originalMethod = descriptor.value as Function;
    if (typeof originalMethod !== 'function') {
      throw new Error('@Cacheable can only decorate methods');
    }

    descriptor.value = async function (...args: unknown[]) {
      // The service is expected to be available as `this.cacheService`.
      const cacheService: ResponseCacheService = (
        this as unknown as { cacheService?: ResponseCacheService }
      ).cacheService;

      if (!cacheService) {
        throw new Error(
          `@Cacheable target ${String(
            propertyKey,
          )} is missing "cacheService" property`,
        );
      }

      const ctx: CacheKeyContext = {
        namespace: options.namespace,
        version: options.version,
        // naive assumption: first arg is "params" & `this` has `currentUserId`
        params: args[0],
        userId: (this as unknown as { currentUserId?: string }).currentUserId,
      };

      return cacheService.getOrSet(
        ctx,
        () => originalMethod.apply(this, args),
        options.ttlSeconds,
      );
    };
  };
}

/**
 * --------
 * Express/Fastify middleware – optional sugar
 * --------
 */

export interface CacheMiddlewareFactoryOptions {
  service: ResponseCacheService;
  /**
   * Only cache GET and HEAD by default, but allow configuration.
   */
  allowedMethods?: ReadonlySet<string>;
  /**
   * Read authentication state from request attribute
   * (helps include `userId` in the cache key).
   */
  userIdHeader?: string;
}

/**
 * Build a minimal middleware that short-circuits the request when a fresh cache
 * entry exists.  Uses `ResponseCacheService` under the hood, so flushes are
 * consistent across decorators, hooks, etc.
 */
export function createCacheMiddleware({
  service,
  allowedMethods = new Set(['GET', 'HEAD']),
  userIdHeader = 'x-user-id',
}: CacheMiddlewareFactoryOptions) {
  return async (req: any, res: any, next: any): Promise<void> => {
    try {
      if (!allowedMethods.has(req.method)) return next();

      const ctx: CacheKeyContext = {
        namespace: req.route?.path ?? req.originalUrl ?? 'unknown',
        userId: req.headers[userIdHeader],
        params: { query: req.query, path: req.params },
      };

      const cached = await service.getOrSet(ctx, async () => undefined);
      if (cached !== undefined) {
        res.setHeader('x-cache-hit', '1');
        return res.json(cached);
      }

      // Monkey-patch res.json to store the payload once ready.
      const originalJson = res.json.bind(res);
      res.json = (body: unknown): typeof res => {
        void service.getOrSet(
          ctx,
          async () => body,
          // honour per-route TTL, if defined via response header
          Number(res.getHeader('x-cache-ttl')) || undefined,
        );
        return originalJson(body);
      };

      return next();
    } catch (err) {
      // Never break the request pipeline because of a cache hiccup.
      // eslint-disable-next-line no-console
      console.error('[CacheMiddleware] error:', err);
      return next();
    }
  };
}

/**
 * --------
 * Helper utilities
 * --------
 */

/**
 * Build a unique key from context information.
 * Keep the algorithm in one place to ensure global consistency.
 */
export function buildCacheKey(ctx: CacheKeyContext): CacheKey {
  const parts = [
    sha1(ctx.namespace),
    ctx.userId ?? 'public',
    ctx.version ?? 'v1',
    sha1(JSON.stringify(ctx.params ?? {})),
  ];
  return parts.join(':');
}

/**
 * SHA-1 is good enough for cache keys (we are not using this for crypto).
 */
export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}
```
