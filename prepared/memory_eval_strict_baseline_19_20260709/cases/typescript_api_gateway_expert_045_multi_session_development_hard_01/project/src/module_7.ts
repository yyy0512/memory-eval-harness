```typescript
/***************************************************************************************************
 *  SocialPulse Gateway — Response Cache Service
 *
 *  Layer     : Infrastructure (Shared)
 *  Purpose   : Centralised, version-aware response-caching with Redis primary-store and
 *              best-effort in-memory fallback (LRU). Supports both REST and GraphQL workloads,
 *              tagging-based invalidation, and automatic promisified hydration.
 *
 *  Author    : @socialpulse/infra-core
 *  License   : MIT
 ***************************************************************************************************/

import Redis, { Redis as RedisClient } from 'ioredis';
import LRUCache from 'lru-cache';
import crypto from 'crypto';

/* ---------------------------------------------------------------------------
 *  Internal ‑ Types
 * ------------------------------------------------------------------------ */

export interface ResponseCacheInitOptions {
  /**
   * A redis connection string: `redis[s]://[:password@]host[:port][/db-number]`
   */
  redisUrl: string;

  /**
   * Default Time-To-Live for cached entries, in seconds.
   */
  defaultTtlSeconds: number;

  /**
   * Maximum number of records to keep in the local fallback LRU cache.
   */
  maxInMemoryItems?: number;
}

export interface CacheKeyContext {
  /**
   * Public HTTP path (e.g., `/api/v2/timeline/feed`), or GraphQL `operationName`.
   */
  target: string;

  /**
   * HTTP method (`GET`, `POST`, …) or `GQL` for GraphQL.
   */
  verb: string;

  /**
   * Version string (e.g., `v1`, `2023-11-07`, `rank-algo-v2`).
   * Allows surfacing side-by-side versions without key collision.
   */
  version: string;

  /**
   * Authenticated user making the request. Optional because some endpoints
   * (e.g. public trending feed) are unauthenticated.
   */
  userId?: string;

  /**
   * Arbitrary request parameters that affect the response. Collected and
   * sorted deterministically in the key builder.
   */
  params?: Record<string, unknown>;
}

type WithTag<T> = T & { __tags__?: string[] };

interface InternalCacheRecord<T> {
  payload: T;
  tags: string[];
}

/* ---------------------------------------------------------------------------
 *  ResponseCacheService
 * ------------------------------------------------------------------------ */

/**
 * ResponseCacheService
 *
 * Usage:
 *   const cache = new ResponseCacheService({...});
 *   const data  = await cache.wrap({target: '/api/v2/timeline', ...ctx}, () => fetchFeed());
 */
export class ResponseCacheService {
  private readonly redis: RedisClient;
  private readonly lru: LRUCache<string, InternalCacheRecord<unknown>>;
  private readonly defaultTtl: number;

  constructor(opts: ResponseCacheInitOptions) {
    this.defaultTtl = opts.defaultTtlSeconds;
    this.redis = new Redis(opts.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 2_000,
    });

    this.lru = new LRUCache({
      max: opts.maxInMemoryItems ?? 1_000,
      ttl: this.defaultTtl * 1_000,
      allowStale: false,
    });

    this.redis.on('error', (err) => {
      /* eslint-disable no-console */
      console.error('[ResponseCacheService] Redis error:', err);
      /* eslint-enable  no-console */
    });
  }

  /* -----------------------------------------------------------------------
   *  Public API
   * -------------------------------------------------------------------- */

  /**
   * Fetch a cached record or compute & hydrate it.
   *
   * @param ctx     Key context used for deterministic cache-key generation
   * @param loader  Lazy asynchronous producer (executed on cache-miss)
   * @param ttl     Optional custom TTL
   * @param tags    Optional list of tags used for later batch invalidation
   */
  async wrap<T>(
    ctx: CacheKeyContext,
    loader: () => Promise<T>,
    ttl: number = this.defaultTtl,
    tags: string[] = [],
  ): Promise<T> {
    const key = this.buildKey(ctx);

    // 1. Attempt Redis (authoritative) ⤵︎
    try {
      await this.ensureConnected();
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached) as T;
      }
    } catch (redisErr) {
      /* Silent ‑ fall through to in-memory */
      this.debug(`Redis unavailable: ${String(redisErr)}`);
    }

    // 2. Attempt local LRU (best-effort) ⤵︎
    const local = this.lru.get(key);
    if (local) {
      return local.payload as T;
    }

    // 3. Cache-miss ⇒ compute & hydrate both tiers
    const result = await loader();

    await this.set(key, result as WithTag<T>, ttl, tags);

    return result;
  }

  /**
   * Explicitly invalidate cache keys by tag.
   * Complexity is O(n) on the keyspace size; do NOT overuse.
   */
  async invalidateByTag(tag: string): Promise<void> {
    // 1. In-memory purge
    this.lru.forEach((value, key) => {
      if (value.tags.includes(tag)) {
        this.lru.delete(key);
      }
    });

    // 2. Redis purge (pattern scan)
    try {
      await this.ensureConnected();

      const stream = this.redis.scanStream({
        match: `*|*|*|*|*|tags:${tag}`, // tags appended at key end
        count: 100,
      });

      const keysToDelete: string[] = [];

      stream.on('data', (keys: string[]) => {
        keysToDelete.push(...keys);
      });

      await new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      if (keysToDelete.length) {
        await this.redis.unlink(...keysToDelete);
      }
    } catch (err) {
      this.debug(`invalidateByTag failed: ${String(err)}`);
    }
  }

  /**
   * Force-delete a specific record from both stores.
   */
  async delete(ctx: CacheKeyContext): Promise<void> {
    const key = this.buildKey(ctx);
    this.lru.delete(key);

    try {
      await this.ensureConnected();
      await this.redis.unlink(key);
    } catch (err) {
      this.debug(`Redis delete failed: ${String(err)}`);
    }
  }

  /**
   * Introspect a cache entry's remaining TTL. Returns `null` when not found.
   */
  async ttl(ctx: CacheKeyContext): Promise<number | null> {
    const key = this.buildKey(ctx);
    try {
      await this.ensureConnected();
      const ttl = await this.redis.ttl(key);
      return ttl >= 0 ? ttl : null;
    } catch {
      return null;
    }
  }

  /* -----------------------------------------------------------------------
   *  Helpers
   * -------------------------------------------------------------------- */

  /**
   * Persist payload into both Redis (authoritative) and local LRU.
   */
  private async set<T>(
    key: string,
    payload: WithTag<T>,
    ttl: number,
    tags: string[],
  ): Promise<void> {
    const record: InternalCacheRecord<T> = {
      payload,
      tags,
    };

    // 1. Redis (fire-and-forget)
    try {
      await this.ensureConnected();
      await this.redis.set(key, JSON.stringify(payload), 'EX', ttl);
    } catch (err) {
      this.debug(`Redis set failed: ${String(err)}`);
    }

    // 2. Local LRU (no TTL granularity smaller than 1 ms)
    this.lru.set(key, record, { ttl: ttl * 1_000 });
  }

  /**
   * Compose a deterministic cache key.
   *
   * Format:
   *   <verb>|<target>|<version>|<uid>|<sha256(params)>|tags:<t1>,<t2>
   */
  private buildKey(ctx: CacheKeyContext): string {
    const { verb, target, version, userId = 'anon', params = {} } = ctx;

    const serializedParams = JSON.stringify(this.sortObjectKeys(params));
    const paramsHash = crypto
      .createHash('sha256')
      .update(serializedParams)
      .digest('hex')
      .slice(0, 16); // 64-bits worth for brevity

    return `${verb.toUpperCase()}|${target}|${version}|${userId}|${paramsHash}`;
  }

  /**
   * Ensure Redis client is connected before issuing commands.
   */
  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'ready') {
      return;
    }
    if (this.redis.status === 'connecting') {
      // concurrently connecting; wait until ready or timeout
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Redis connect timeout')), 2_000);
        this.redis.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
        this.redis.once('error', reject);
      });
    } else {
      await this.redis.connect();
    }
  }

  /**
   * Consistent debug logger (noop in production, can be overridden).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private debug(...args: any[]): void {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.debug('[ResponseCacheService]', ...args);
    }
  }

  /**
   * Deterministically sort object keys. Handles nested objects & arrays.
   */
  private sortObjectKeys<T extends Record<string, unknown>>(obj: T): T {
    if (Array.isArray(obj)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return obj.map((item) => this.sortObjectKeys(item as any)) as any;
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .reduce((acc: any, key) => {
          acc[key] = this.sortObjectKeys(obj[key] as any);
          return acc;
        }, {});
    }
    return obj;
  }
}

/* ---------------------------------------------------------------------------
 *  Re-exports (Facade)
 * ------------------------------------------------------------------------ */

export default ResponseCacheService;
```