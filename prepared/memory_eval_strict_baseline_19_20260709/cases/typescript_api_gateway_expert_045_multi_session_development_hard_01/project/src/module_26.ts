```typescript
/**
 * SocialPulse Gateway – Response Caching Module
 * ---------------------------------------------
 * Provides a production-grade caching mechanism for REST & GraphQL responses.
 * Features:
 *  • Version-aware cache keys.
 *  • Tag-based invalidation (e.g. timeline:123, user:42).
 *  • Stale-while-revalidate support.
 *  • Centralized and typed public API.
 *
 * This file intentionally lives at the “infrastructure” boundary, but exposes
 * only domain-agnostic abstractions that upper layers (application/controller)
 * can depend on.
 */

import { createClient, RedisClientType } from 'redis';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

export enum CacheScope {
  PUBLIC = 'PUBLIC',    // Same response for everyone (e.g., trending posts).
  USER   = 'USER',      // Varies per authenticated user (e.g., home timeline).
  CUSTOM = 'CUSTOM',    // Caller provides an arbitrary discriminant.
}

export interface CacheKeyParts {
  resource: string;          // Domain concept: "timeline", "post", "user"
  scope   : CacheScope;
  // Version identifier to guarantee backward compatibility between releases.
  apiVersion: string;        // e.g. "v1", "2023-09-05"
  // Optional per-user or per-custom discriminant.
  discriminator?: string;
}

export interface CacheOptions {
  /**
   * Maximum number of seconds the entry should stay in cache.
   * 0 disables storage (useful for force-refresh).
   */
  ttl: number;
  /**
   * Additional tags to ease bulk invalidation.
   * e.g. ["user:42", "timeline:home"]
   */
  tags?: string[];
  /**
   * When true, stale data may be served while revalidating in background.
   */
  allowStale?: boolean;
}

/**
 * Result wrapper returned from getOrSet() to help callers decide whether to
 * attach caching headers, etc.
 */
export interface CacheResult<T> {
  hit   : boolean;
  stale : boolean;
  value : T;
}

// Redis sets that track which keys belong to a tag.
const TAG_SET_PREFIX = 'spg:cache:tags'; // SocialPulse Gateway

// Performance: avoid magic numbers in code.
const ONE_SECOND_MS = 1_000;

// ---------------------------------------------------------------------------
// Validation Schemas
// ---------------------------------------------------------------------------

const cacheKeyPartsSchema = z.object({
  resource      : z.string().min(1),
  scope         : z.nativeEnum(CacheScope),
  apiVersion    : z.string().min(1),
  discriminator : z.string().optional(),
});

const cacheOptionsSchema = z.object({
  ttl        : z.number().int().nonnegative(),
  tags       : z.array(z.string()).optional(),
  allowStale : z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Cache Manager (Singleton)
// ---------------------------------------------------------------------------

export class ResponseCacheManager extends EventEmitter {
  private static _instance: ResponseCacheManager | null = null;

  public static get instance(): ResponseCacheManager {
    if (!ResponseCacheManager._instance) {
      ResponseCacheManager._instance = new ResponseCacheManager();
    }
    return ResponseCacheManager._instance;
  }

  private readonly log = pino({ name: 'ResponseCacheManager' });
  private readonly redis: RedisClientType;

  private constructor() {
    super();
    // Establish Redis connection.
    this.redis = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    });

    this.redis.on('error', (err) =>
      this.log.error({ err }, 'Redis client error'),
    );

    // Connect in background; await readiness only when first operation occurs.
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.redis.connect();
  }

  /**
   * Generates a canonical cache key.
   * Format: spg:cache:{resource}:{scope}:{apiVersion}:{discriminator?}
   */
  public generateKey(parts: CacheKeyParts): string {
    cacheKeyPartsSchema.parse(parts);

    const path = [
      'spg',
      'cache',
      parts.resource,
      parts.scope,
      parts.apiVersion,
    ];

    if (parts.discriminator) path.push(parts.discriminator);

    return path.join(':');
  }

  /**
   * Reads from cache or computes/stores the value if not present.
   *
   * @param keyParts  – Structured cache key description.
   * @param options   – Storage/invalidations options.
   * @param producer  – Callback that resolves to the value when miss occurs.
   */
  public async getOrSet<T>(
    keyParts: CacheKeyParts,
    options: CacheOptions,
    producer: () => Promise<T>,
  ): Promise<CacheResult<T>> {
    cacheOptionsSchema.parse(options);

    const key = this.generateKey(keyParts);
    const { ttl, tags = [], allowStale = true } = options;
    const start = Date.now();

    // Attempt read
    const raw = await this.redis.hGetAll(key);
    if (raw && raw.value) {
      const age = Date.now() - Number(raw.createdAtMs);
      const maxAge = ttl * ONE_SECOND_MS;

      // Accept fresh entry.
      if (age < maxAge) {
        this.log.debug({ key, hit: true }, 'Cache HIT');
        return { hit: true, stale: false, value: this.deserialize<T>(raw.value) };
      }

      // Stale; if allowed, serve while refreshing in background.
      if (allowStale) {
        this.log.debug({ key, hit: true }, 'Cache STALE, will revalidate');
        // Fire & forget revalidation.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.revalidate(key, keyParts, options, producer);
        return { hit: true, stale: true, value: this.deserialize<T>(raw.value) };
      }
    }

    // MISS
    this.log.debug({ key, hit: false }, 'Cache MISS');
    const freshValue = await producer();
    await this.store(key, freshValue, { ttl, tags });
    this.emit('miss', { key, durationMs: Date.now() - start });
    return { hit: false, stale: false, value: freshValue };
  }

  /**
   * Invalidates all cache entries bound to any of the provided tags.
   * Returns number of keys deleted.
   */
  public async invalidateByTags(tags: string[]): Promise<number> {
    if (!tags.length) return 0;

    const pipeline = this.redis.multi();
    const keysToDelete: Set<string> = new Set();

    for (const tag of tags) {
      const setKey = `${TAG_SET_PREFIX}:${tag}`;
      // Fetch keys for this tag
      const memberKeys = await this.redis.sMembers(setKey);
      memberKeys.forEach((k) => keysToDelete.add(k));
      // Drop the tag set itself
      pipeline.del(setKey);
    }

    if (keysToDelete.size === 0) return 0;

    keysToDelete.forEach((k) => pipeline.del(k));
    const [, ...results] = await pipeline.exec();
    const deleted = results.flat().reduce<number>((acc, res) => acc + Number(res), 0);

    this.log.info(
      { tags, deleted },
      'Cache invalidation executed',
    );

    return deleted;
  }

  /**
   * Flushes entire cache namespace. Use with extreme caution.
   */
  public async flushAll(): Promise<void> {
    const pattern = 'spg:cache:*';
    // SCAN + DEL pattern to avoid blocking Redis with KEYS
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop
      const [nextCursor, keys] = await this.redis.scan(cursor, {
        MATCH: pattern,
        COUNT: 100,
      });
      cursor = nextCursor;
      if (keys.length) {
        // eslint-disable-next-line no-await-in-loop
        await this.redis.del(keys);
      }
    } while (cursor !== '0');
    this.log.warn('Entire cache namespace flushed');
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private deserialize<T>(payload: string): T {
    return JSON.parse(payload) as T;
  }

  private serialize(payload: unknown): string {
    return JSON.stringify(payload);
  }

  /**
   * Stores value inside Redis and associates it with tags if provided.
   */
  private async store<T>(
    key: string,
    value: T,
    opts: Pick<CacheOptions, 'ttl' | 'tags'>,
  ): Promise<void> {
    const { ttl, tags = [] } = opts;

    const createdAtMs = Date.now().toString();
    const pipeline = this.redis.multi();

    pipeline.hSet(key, {
      value: this.serialize(value),
      createdAtMs,
    });

    if (ttl > 0) pipeline.expire(key, ttl);

    // Track key in tag sets for later invalidation
    for (const tag of tags) {
      const setKey = `${TAG_SET_PREFIX}:${tag}`;
      pipeline.sAdd(setKey, key);
      if (ttl > 0) pipeline.expire(setKey, ttl);
    }

    await pipeline.exec();
  }

  /**
   * Executes refresh in background for stale entries.
   */
  private async revalidate<T>(
    key: string,
    keyParts: CacheKeyParts,
    opts: CacheOptions,
    producer: () => Promise<T>,
  ): Promise<void> {
    try {
      const newValue = await producer();
      await this.store(key, newValue, opts);
      this.emit('revalidated', { key });
      this.log.debug({ key }, 'Cache revalidated');
    } catch (err) {
      this.log.error({ err, key }, 'Background revalidation failed');
      // Keep stale value; error swallowed intentionally.
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience Functional Wrapper
// ---------------------------------------------------------------------------

/**
 * Syntactic sugar to cache a function execution result based on descriptive
 * parameters. Example:
 *
 * const { value } = await withCache(
 *   { resource: 'timeline', scope: CacheScope.USER, apiVersion: 'v2', discriminator: userId },
 *   { ttl: 30, tags: [`user:${userId}`] },
 *   () => timelineService.fetchHomeTimeline(userId)
 * );
 */
export async function withCache<T>(
  keyParts: CacheKeyParts,
  options: CacheOptions,
  producer: () => Promise<T>,
): Promise<CacheResult<T>> {
  return ResponseCacheManager.instance.getOrSet(keyParts, options, producer);
}

// ---------------------------------------------------------------------------
// Graceful Shutdown Hook
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  // Stand-alone manual test via ts-node src/module_26.ts
  // eslint-disable-next-line no-console
  console.log('Running self-diagnostic…');

  (async () => {
    const cache = ResponseCacheManager.instance;
    const keyParts: CacheKeyParts = {
      resource: 'diagnostic',
      scope: CacheScope.PUBLIC,
      apiVersion: 'v0',
    };

    const { value, hit } = await cache.getOrSet(
      keyParts,
      { ttl: 5 },
      async () => {
        await new Promise((res) => setTimeout(res, 100));
        return { now: new Date().toISOString() };
      },
    );

    // eslint-disable-next-line no-console
    console.log({ first: { value, hit } });

    await cache.redis.disconnect();
    process.exit(0);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
```