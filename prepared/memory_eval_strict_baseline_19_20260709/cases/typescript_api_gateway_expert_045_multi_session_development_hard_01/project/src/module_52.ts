```typescript
/* ===========================================================================
 * SocialPulse Gateway – ResponseCacheService
 *
 * A production-grade, Redis-backed response-caching utility that can be used
 * from either REST controllers (Express) or GraphQL resolvers. The service
 * supports:
 *  • Automatic key-generation that is API-version aware
 *  • Tag-based cache-invalidation (e.g. “timeline:42”, “hashtag:#golang”)
 *  • Fine-grained TTL configuration per entry
 *  • Request-scoped instrumentation hooks for structured logging / metrics
 *  • Graceful-degradation when Redis becomes unavailable
 * ---------------------------------------------------------------------------
 * File:          src/module_52.ts
 * Project:       SocialPulse Gateway (api_gateway)
 * Language:      TypeScript
 * Dependencies:  ioredis, express, uuid, pino
 * --------------------------------------------------------------------------*/

import { Request, Response, NextFunction } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import { v4 as uuid } from 'uuid';
import EventEmitter from 'events';
import pino from 'pino';

/* ---------------------------------------------------------------------------
 * Types & Interfaces
 * --------------------------------------------------------------------------*/

/**
 * Cache TTL in seconds ─ use `Infinity` for non-expiring entries.
 */
export type Seconds = number;

/**
 * Configuration options supplied at service-initialization time.
 */
export interface ResponseCacheConfig {
  /**
   * Prefix applied to every cache key. Use gateway identifier in multi-tenant
   * deployments.
   */
  globalPrefix?: string;

  /**
   * Default TTL applied when no per-call value is provided.
   */
  defaultTtl?: Seconds;

  /**
   * Redis connection URL – falls back to REDIS_URL env variable.
   */
  redisUrl?: string;
}

/**
 * Options for a single cache interaction.
 */
export interface CacheableOptions {
  /**
   * Cache Time-To-Live. Overrides the defaultTtl supplied at bootstrap.
   */
  ttl?: Seconds;

  /**
   * Tags attached to this cache item. Enable group invalidation.
   */
  tags?: string[];

  /**
   * Custom key; useful when caching non-request driven data.
   * If omitted, a deterministic key is generated from the request.
   */
  key?: string;
}

/* ---------------------------------------------------------------------------
 * Internal utility types
 * --------------------------------------------------------------------------*/

/** Shape stored in Redis. */
interface CachedEntry<T> {
  ts: number;        // epoch millis – when was this cached?
  ttl: Seconds;      // cache lifetime
  tags: string[];    // tags for group invalidation
  payload: T;        // actual data
}

/* ---------------------------------------------------------------------------
 * ResponseCacheService
 * --------------------------------------------------------------------------*/

/**
 * Production-grade response-caching service.
 */
export class ResponseCacheService extends EventEmitter {
  private readonly redis: RedisClient;
  private readonly logger = pino({ name: 'ResponseCacheService' });
  private readonly globalPrefix: string;
  private readonly defaultTtl: Seconds;

  constructor(config: ResponseCacheConfig = {}) {
    super();
    const redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.redis = new Redis(redisUrl);
    this.globalPrefix = config.globalPrefix ?? 'socialpulse';
    this.defaultTtl = config.defaultTtl ?? 60; // 1 minute default
    this.wireEvents();
  }

  /* -------------------------------------------------------------------------
   * Public API
   * ----------------------------------------------------------------------*/

  /**
   * Express middleware – transparently serves cached responses when available,
   * otherwise lets the request proceed and automatically caches the response.
   *
   * Usage:
   *    app.get('/public/timeline', cache.middleware({ ttl: 30 }), timelineCtrl)
   */
  middleware = (opts: CacheableOptions = {}) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (req.method !== 'GET') {
        // Only idempotent GET requests are cached.
        return next();
      }

      const key = opts.key ?? this.generateRequestKey(req);

      try {
        const cached = await this.getFromCache<unknown>(key);
        if (cached !== null) {
          this.logger.debug({ key }, 'Cache hit');
          res.set('X-Cache', 'HIT');
          return res.json(cached);
        }

        res.set('X-Cache', 'MISS');
        // Monkey-patch res.json to intercept the payload
        const originalJson = res.json.bind(res);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.json = async (body: any): Promise<Response> => {
          originalJson(body);

          // Fire-and-forget cache save – do not block response.
          /* c8 ignore next 4 */
          void this.saveToCache(key, body, opts).catch((err: unknown) =>
            this.logger.warn({ err, key }, 'Failed to save cache entry'),
          );
          return res;
        };
      } catch (err) {
        // On error, gracefully degrade – just log and proceed.
        this.logger.warn({ err }, 'Cache middleware encountered an error');
      }

      return next();
    };

  /**
   * Generic helper method for GraphQL resolvers or service-layer calls.
   *
   * Example:
   *    const userFeed = await cache.getOrSet<UserPost[]>(
   *       `feed:${userId}`, () => aggregator.fetchUserFeed(userId), { ttl: 20 }
   *    );
   */
  async getOrSet<T>(
    key: string,
    producer: () => Promise<T>,
    opts: CacheableOptions = {},
  ): Promise<T> {
    const cached = await this.getFromCache<T>(key);

    if (cached !== null) {
      this.logger.debug({ key }, 'Cache hit');
      return cached;
    }

    const payload = await producer();
    await this.saveToCache<T>(key, payload, opts);

    return payload;
  }

  /**
   * Invalidate cached entries by tag(s).
   * This operation publishes an event so other gateway instances purge locally.
   */
  async invalidateByTag(...tags: string[]): Promise<void> {
    if (tags.length === 0) return;

    this.logger.info({ tags }, 'Invalidating cache by tag');
    const channel = this.getTagChannel();
    await this.redis.publish(channel, JSON.stringify({ tags }));
  }

  /* -------------------------------------------------------------------------
   * Private helpers
   * ----------------------------------------------------------------------*/

  private async getFromCache<T>(key: string): Promise<T | null> {
    try {
      const fullKey = this.buildKey(key);
      const raw = await this.redis.get(fullKey);

      if (!raw) return null;

      const entry: CachedEntry<T> = JSON.parse(raw);
      if (entry.ttl !== Infinity && Date.now() - entry.ts > entry.ttl * 1000) {
        // Entry expired. Remove asynchronously.
        /* c8 ignore next 3 */
        void this.redis.del(fullKey);
        return null;
      }

      return entry.payload;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to fetch from Redis');
      return null; // Degrade: treat as cache miss
    }
  }

  private async saveToCache<T>(
    key: string,
    payload: T,
    opts: CacheableOptions = {},
  ): Promise<void> {
    const fullKey = this.buildKey(key);
    const ttl = opts.ttl ?? this.defaultTtl;
    const tags = opts.tags ?? [];

    const entry: CachedEntry<T> = {
      ts: Date.now(),
      ttl,
      tags,
      payload,
    };

    const pipe = this.redis.pipeline().set(fullKey, JSON.stringify(entry));
    if (ttl !== Infinity) {
      pipe.expire(fullKey, ttl);
    }

    // If tags are provided, add key->tag sets for invalidation
    for (const tag of tags) {
      pipe.sadd(this.buildTagSetKey(tag), fullKey);
    }

    await pipe.exec();
  }

  private generateRequestKey(req: Request): string {
    const version =
      req.headers['accept-version'] ??
      req.query['version'] ??
      req.headers['x-api-version'] ??
      'v1';

    const userHash = req.headers['authorization'] ? uuid(req.headers['authorization']) : 'anon';

    const key = ['route', req.method, version, req.originalUrl, userHash]
      .filter(Boolean)
      .join(':');

    return key;
  }

  /**
   * Remove cache entries when eviction message is received.
   */
  private async onRemoteInvalidation(msg: string): Promise<void> {
    try {
      const { tags } = JSON.parse(msg) as { tags: string[] };
      const pipe = this.redis.pipeline();

      for (const tag of tags) {
        const tagSetKey = this.buildTagSetKey(tag);
        const keys = await this.redis.smembers(tagSetKey);

        if (keys.length > 0) {
          pipe.del(...keys);
        }
        pipe.del(tagSetKey);
      }

      await pipe.exec();
      this.logger.info({ tags }, 'Remote invalidation completed');
    } catch (err) {
      this.logger.error({ err }, 'Failed to perform remote invalidation');
    }
  }

  /* -------------------------------------------------------------------------
   * Key helpers
   * ----------------------------------------------------------------------*/

  private buildKey(key: string): string {
    return `${this.globalPrefix}:cache:${key}`;
  }

  private buildTagSetKey(tag: string): string {
    return `${this.globalPrefix}:tagset:${tag}`;
  }

  private getTagChannel(): string {
    return `${this.globalPrefix}:events:invalidate`;
  }

  /* -------------------------------------------------------------------------
   * Events & Cleanup
   * ----------------------------------------------------------------------*/

  /**
   * Subscribe to tag-invalidations so multiple gateway pods stay in sync.
   */
  private wireEvents(): void {
    const channel = this.getTagChannel();
    // Separate connection for subscriber
    const sub = new Redis(this.redis.options);

    sub.subscribe(channel).catch((err) =>
      this.logger.error({ err }, 'Failed to subscribe to invalidation channel'),
    );

    sub.on('message', (_ch, msg) => void this.onRemoteInvalidation(msg));

    // Graceful shutdown
    const cleanup = async (): Promise<void> => {
      try {
        await Promise.all([this.redis.quit(), sub.quit()]);
        this.logger.info('Redis connections closed');
      } catch (err) {
        /* c8 ignore next */ this.logger.warn({ err }, 'Error during Redis disconnect');
      }
    };

    process.once('SIGTERM', cleanup);
    process.once('SIGINT', cleanup);
  }
}

/* ---------------------------------------------------------------------------
 * Export a singleton instance (recommended for most use-cases)
 * --------------------------------------------------------------------------*/

export const responseCache = new ResponseCacheService({
  globalPrefix: 'spulse',
  defaultTtl: 60,
});
```