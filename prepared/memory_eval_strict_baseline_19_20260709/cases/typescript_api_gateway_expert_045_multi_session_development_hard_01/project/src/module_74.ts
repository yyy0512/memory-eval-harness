```typescript
/* eslint-disable @typescript-eslint/ban-types */

/**
 * SocialPulse Gateway
 * Module: ResponseCacheService
 *
 * Purpose:
 *   A high-level Redis-backed response-caching facility specialised for
 *   fan-out heavy social endpoints (public timelines, trending hashtags, …).
 *
 * Highlights:
 *   • Version-aware composite cache keys
 *   • Per-user / per-scope isolation
 *   • Automatic TTL with jitter to mitigate stampedes
 *   • Tag-based invalidation for selective cache busting
 *   • Graceful degradation (logs + fall-through on Redis failures)
 *
 * NOTE:
 *   This file is intentionally self-contained (no project-relative imports) so
 *   that it can be dropped into the gateway without touching the rest of the
 *   dependency graph.  Replace placeholder imports with your concrete
 *   implementations as needed.
 */

import Redis, { Redis as RedisClient } from 'ioredis';
import { Counter, Histogram, Registry } from 'prom-client';
import { v4 as uuidv4 } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                               Type Definitions                             */
/* -------------------------------------------------------------------------- */

/**
 * CacheScope enumerates the supported isolation levels for cache entries.
 *   GLOBAL   – visible to every caller              (e.g., /hashtags/trending)
 *   USER     – isolated by authenticated userId     (e.g., /users/:id/feed)
 *   SESSION  – isolated by auth session / device id (e.g., /notifications)
 */
export type CacheScope = 'GLOBAL' | 'USER' | 'SESSION';

/**
 * Options accepted by ResponseCacheService
 */
export interface CacheOptions {
  /** Cache isolation level (default: GLOBAL) */
  scope?: CacheScope;
  /** Absolute TTL in seconds (default: 60) */
  ttlSeconds?: number;
  /** Version number for algorithm migrations, rolling deploys, … (default: 1) */
  version?: number;
  /** Caller-supplied tags used for group invalidation */
  tags?: string[];
  /** Arbitrary metadata persisted alongside payload (debugging / auditing) */
  meta?: Record<string, unknown>;
}

/**
 * Internal wrapper for stored cache entries.
 */
interface CachePayload<T> {
  v: number;                 // version
  s: CacheScope;             // scope
  p: T;                      // payload
  m?: Record<string, unknown>; // metadata
}

/* -------------------------------------------------------------------------- */
/*                                  Service                                   */
/* -------------------------------------------------------------------------- */

export class ResponseCacheService {
  /** Jitter in seconds (± this value). Prevents thundering-herd stampedes. */
  private static readonly TTL_JITTER_RANGE = 10;

  /** Prefix for redis keys to avoid collisions with other modules */
  private static readonly KEY_PREFIX = 'sp:response_cache';

  /** Redis client instance */
  private readonly redis: RedisClient;

  /** Prometheus metrics */
  private readonly hitCounter: Counter;
  private readonly missCounter: Counter;
  private readonly latencyHistogram: Histogram;

  /**
   * Creates a new ResponseCacheService
   * @param redis existing ioredis client. If omitted, a new connection is made.
   * @param register Prometheus registry. If omitted, a new registry is created.
   */
  constructor(redis?: RedisClient, register: Registry = new Registry()) {
    this.redis =
      redis ||
      new Redis({
        enableAutoPipelining: true,
        maxRetriesPerRequest: 2,
        lazyConnect: false,
      });

    /* ----------------------------- Metrics ------------------------------ */
    const LABELS = ['scope'] as const;

    this.hitCounter = new Counter({
      name: 'sp_cache_hits_total',
      help: 'Total number of cache hits',
      labelNames: LABELS,
      registers: [register],
    });

    this.missCounter = new Counter({
      name: 'sp_cache_misses_total',
      help: 'Total number of cache misses',
      labelNames: LABELS,
      registers: [register],
    });

    this.latencyHistogram = new Histogram({
      name: 'sp_cache_latency_seconds',
      help: 'Latency for getOrSet handler',
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
      labelNames: LABELS,
      registers: [register],
    });
  }

  /* ---------------------------------------------------------------------- */
  /*                              Public API                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Returns the cached value if present. Otherwise resolves it via the
   * provided fetcher, stores the value, and returns it.
   *
   * Typical usage pattern in a controller:
   *   const data = await cache.getOrSet(
   *     `user:${userId}:feed`,
   *     () => feedUseCase.execute({ userId }),
   *     { scope: 'USER', tags: [`user:${userId}`], ttlSeconds: 30 }
   *   );
   */
  public async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const ctxScope = options.scope ?? 'GLOBAL';
    const cacheKey = this.buildCacheKey(key, ctxScope);
    const timer = this.latencyHistogram.startTimer({ scope: ctxScope });

    try {
      const cached = await this.get<T>(cacheKey);
      if (cached !== null) {
        this.hitCounter.inc({ scope: ctxScope });
        return cached;
      }
      this.missCounter.inc({ scope: ctxScope });

      const fresh = await fetcher();
      await this.set(cacheKey, fresh, options);
      return fresh;
    } finally {
      timer();
    }
  }

  /**
   * Explicit get (does not record MISS/HIT metrics – use getOrSet instead).
   */
  public async get<T>(
    rawKey: string,
  ): Promise<T | null> {
    try {
      const data = await this.redis.get(rawKey);
      if (!data) {
        return null;
      }

      const parsed: CachePayload<T> = JSON.parse(data);
      return parsed.p;
    } catch (err) {
      // Fail-open. Log and ignore.
      console.error('[ResponseCacheService] Redis read failure:', err);
      return null;
    }
  }

  /**
   * Explicit set with options.
   */
  public async set<T>(
    rawKey: string,
    value: T,
    options: CacheOptions = {},
  ): Promise<void> {
    const payload: CachePayload<T> = {
      v: options.version ?? 1,
      s: options.scope ?? 'GLOBAL',
      p: value,
      m: options.meta,
    };

    const ttl = this.computeTtl(options.ttlSeconds);
    const tags = options.tags ?? [];

    const pipeline = this.redis.pipeline();

    pipeline.set(rawKey, JSON.stringify(payload), 'EX', ttl);

    // Maintain reverse-indices for tag-based invalidation.
    // For each tag we add the key to a tag-set. We also set identical TTL
    // on the tag-set to avoid infinite growth.
    if (tags.length > 0) {
      for (const tag of tags) {
        const tagKey = this.buildTagKey(tag);
        pipeline.sadd(tagKey, rawKey);
        pipeline.expire(tagKey, ttl);
      }
    }

    try {
      await pipeline.exec();
    } catch (err) {
      console.error('[ResponseCacheService] Redis write failure:', err);
      // Non-fatal by design.
    }
  }

  /**
   * Bulk invalidation by tag(s).
   * Examples:
   *   await cache.invalidateByTags(['user:1234', 'hashtag:music']);
   */
  public async invalidateByTags(tags: string[]): Promise<void> {
    if (!tags.length) return;

    try {
      const pipeline = this.redis.pipeline();

      // Gather all affected keys.
      const tagKeys = tags.map((t) => this.buildTagKey(t));
      const keySets = await this.redis.sunion(...tagKeys);

      if (keySets.length > 0) {
        pipeline.del(...keySets);
      }
      // Delete the tag sets themselves.
      pipeline.del(...tagKeys);

      await pipeline.exec();
    } catch (err) {
      console.error('[ResponseCacheService] Tag invalidation failed:', err);
    }
  }

  /**
   * Force-flush entire cache namespace.
   * Use sparingly – this can be extremely expensive in prod.
   */
  public async flushAll(): Promise<void> {
    try {
      const scanPrefix = `${ResponseCacheService.KEY_PREFIX}:*`;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          scanPrefix,
          'COUNT',
          1000,
        );
        cursor = nextCursor;
        if (keys.length) {
          await this.redis.del(...keys);
        }
      } while (cursor !== '0');
    } catch (err) {
      console.error('[ResponseCacheService] flushAll() failed:', err);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*                             Helper Methods                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Compose a deterministic cache key.
   * Structure: sp:response_cache:{scope}:{key}
   */
  private buildCacheKey(key: string, scope: CacheScope): string {
    return `${ResponseCacheService.KEY_PREFIX}:${scope}:${key}`;
  }

  /**
   * Compose tag set key.
   * Structure: sp:response_cache:tag:{tagName}
   */
  private buildTagKey(tag: string): string {
    return `${ResponseCacheService.KEY_PREFIX}:tag:${tag}`;
  }

  /**
   * Calculates TTL with ± jitter.
   */
  private computeTtl(baseTtl: number = 60): number {
    const jitter =
      Math.random() * ResponseCacheService.TTL_JITTER_RANGE * 2 -
      ResponseCacheService.TTL_JITTER_RANGE;
    return Math.max(1, Math.floor(baseTtl + jitter));
  }
}

/* -------------------------------------------------------------------------- */
/*                             Usage Example (dev)                            */
/* -------------------------------------------------------------------------- */

/**
 * The following demonstrates how one might wire the service into an
 * Express.js REST controller or a GraphQL resolver.  Remove or adapt
 * according to your actual application bootstrap.
 */
if (process.env.NODE_ENV === 'development') {
  (async () => {
    const cache = new ResponseCacheService();

    const key = 'hello-world';
    const payload = await cache.getOrSet(
      key,
      async () => {
        /* expensive computation: can be I/O, DDB call, … */
        return { msg: 'Hello World', id: uuidv4() };
      },
      {
        scope: 'GLOBAL',
        ttlSeconds: 20,
        tags: ['demo'],
        meta: { source: 'example-script' },
      },
    );

    console.log('[DEMO] Retrieved payload:', payload);

    // Invalidate:
    await cache.invalidateByTags(['demo']);
  })();
}
```