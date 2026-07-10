```typescript
/**
 * SocialPulse Gateway – ResponseCacheManager
 * ------------------------------------------
 * A production-grade, tag-aware response cache with
 * built-in stampede protection, invalidation, metrics
 * and tracing hooks.
 *
 * This module is intentionally framework-agnostic and can be
 * consumed by both REST controllers and GraphQL resolvers.
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import IORedis, { Redis } from 'ioredis';
import pino from 'pino';
import { Counter, Histogram, register } from 'prom-client';
import { v4 as uuid } from 'uuid';

/* -------------------------------------------------------------------------- */
/*                                    Types                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cache metadata that is stored alongside the actual payload.
 */
interface CacheEnvelope<T> {
  /** Serialized payload */
  data: T;
  /** Absolute unix time (seconds) when entry becomes stale */
  expiresAt?: number;
  /** User-defined cache tags */
  tags?: string[];
}

/**
 * Options controlling cache insertion & retrieval.
 */
export interface CacheOptions {
  /** TTL in seconds; default resolved from configuration */
  ttlSeconds?: number;
  /** Optional user-defined tags (e.g., 'public:timeline', 'user:123') */
  tags?: string[];
  /**
   * If provided, stale value can still be served for this duration
   * while a background re-validation is executed.
   */
  staleWhileRevalidateSeconds?: number;
}

/**
 * Stampede protection configuration.
 */
interface LockOptions {
  /** How long the lock lives in Redis (ms) */
  ttlMs: number;
  /** Max time a waiter is willing to wait for the lock (ms) */
  maxWaitMs: number;
  /** How often a waiter polls for cache value (ms) */
  pollIntervalMs: number;
}

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_LOCK_OPTIONS: LockOptions = {
  ttlMs: 5_000,
  maxWaitMs: 10_000,
  pollIntervalMs: 200,
};

const REDIS_KEY_PREFIX = 'spg:cache:';
const TAG_INDEX_PREFIX = 'spg:cache-tags:';

const log = pino({
  name: 'ResponseCacheManager',
  level: process.env.LOG_LEVEL || 'info',
});

/* -------------------------------------------------------------------------- */
/*                                   Metrics                                  */
/* -------------------------------------------------------------------------- */

const cacheHitCounter = new Counter({
  name: 'spg_cache_hits_total',
  help: 'Total number of cache hits',
});

const cacheMissCounter = new Counter({
  name: 'spg_cache_misses_total',
  help: 'Total number of cache misses',
});

const cacheSetHistogram = new Histogram({
  name: 'spg_cache_set_duration_seconds',
  help: 'Duration of cache set operations',
  buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

/* -------------------------------------------------------------------------- */
/*                               Helper Functions                             */
/* -------------------------------------------------------------------------- */

function hashKey(key: string): string {
  // Large keys are hashed to avoid exceeding Redis key size limits.
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return `${REDIS_KEY_PREFIX}${digest}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/* -------------------------------------------------------------------------- */
/*                          ResponseCacheManager Class                        */
/* -------------------------------------------------------------------------- */

export class ResponseCacheManager extends EventEmitter {
  private readonly redis: Redis;
  private readonly lockOpts: LockOptions;

  constructor(
    redisInstance?: Redis,
    lockOptions: Partial<LockOptions> = {},
  ) {
    super();

    this.redis =
      redisInstance ||
      new IORedis({
        // Inherit connection dsn from env or fallback.
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT) || 6379,
        enableAutoPipelining: true,
      });

    this.lockOpts = { ...DEFAULT_LOCK_OPTIONS, ...lockOptions };

    // Expose metrics endpoint for scraping when in standalone mode.
    if (process.env.NODE_ENV !== 'production') {
      // Automatic metrics registration side-effect
      register.setDefaultLabels({ service: 'socialpulse-gateway' });
    }
  }

  /**
   * Low-level get without stampede protection.
   */
  private async _getEnvelope<T>(
    rawKey: string,
  ): Promise<CacheEnvelope<T> | null> {
    const redisKey = hashKey(rawKey);
    const raw = await this.redis.get(redisKey);
    if (!raw) return null;

    try {
      const envelope = JSON.parse(raw) as CacheEnvelope<T>;
      return envelope;
    } catch (err) {
      log.error({ err }, 'Failed to parse cache envelope, evicting');
      await this.redis.del(redisKey);
      return null;
    }
  }

  /**
   * Retrieves a cached value if present & fresh.
   *
   * Stale entries may still be returned depending on user preference.
   */
  public async get<T>(
    key: string,
    allowStale = false,
  ): Promise<T | null> {
    const envelope = await this._getEnvelope<T>(key);
    if (!envelope) {
      cacheMissCounter.inc();
      return null;
    }

    const expired =
      envelope.expiresAt !== undefined &&
      envelope.expiresAt < nowSeconds();

    if (expired && !allowStale) {
      cacheMissCounter.inc();
      return null;
    }

    cacheHitCounter.inc();
    return envelope.data;
  }

  /**
   * Stores a value in cache and associates it with optional tags.
   */
  public async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {},
  ): Promise<void> {
    const endTimer = cacheSetHistogram.startTimer();

    const ttlSec = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = nowSeconds() + ttlSec;
    const envelope: CacheEnvelope<T> = {
      data: value,
      expiresAt,
      tags: options.tags,
    };

    const redisKey = hashKey(key);
    const pipeline = this.redis.pipeline().set(
      redisKey,
      JSON.stringify(envelope),
      'EX',
      ttlSec +
        (options.staleWhileRevalidateSeconds ?? 0),
    );

    // Maintain reverse tag index:  tag => set(keys)
    if (options.tags && options.tags.length) {
      for (const tag of options.tags) {
        pipeline.sadd(`${TAG_INDEX_PREFIX}${tag}`, redisKey);
      }
    }

    await pipeline.exec();
    endTimer();
  }

  /**
   * getOrSet implements read-through cache semantics with:
   *  • Stampede protection (distributed lock)
   *  • Optional stale-while-revalidate
   */
  public async getOrSet<T>(
    key: string,
    computeFn: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    // Attempt fast path
    const existing = await this.get<T>(
      key,
      Boolean(options.staleWhileRevalidateSeconds),
    );
    if (existing !== null) {
      const envelope = await this._getEnvelope<T>(key);
      const isStale =
        envelope &&
        envelope.expiresAt !== undefined &&
        envelope.expiresAt < nowSeconds();

      // If staleWhileRevalidate requested, trigger background refresh.
      if (
        isStale &&
        options.staleWhileRevalidateSeconds &&
        options.staleWhileRevalidateSeconds > 0
      ) {
        this.revalidate(key, computeFn, options).catch((err) =>
          log.error({ err }, 'Background revalidation failed'),
        );
      }

      return existing;
    }

    // Slow path with stampede protection.
    const lockKey = `${hashKey(key)}:lock`;
    const lockToken = uuid();
    const lockAcquired = await this.redis.set(
      lockKey,
      lockToken,
      'PX',
      this.lockOpts.ttlMs,
      'NX',
    );

    if (lockAcquired) {
      // We are the lock owner -> compute & populate.
      try {
        const result = await computeFn();
        await this.set(key, result, options);
        // Broadcast revalidation success.
        this.emit('cache:set', { key });
        return result;
      } finally {
        // Release lock if still ours.
        const current = await this.redis.get(lockKey);
        if (current === lockToken) {
          await this.redis.del(lockKey);
        }
      }
    } else {
      // Not lock owner – wait for value to appear (or timeout).
      const started = Date.now();
      while (Date.now() - started < this.lockOpts.maxWaitMs) {
        // tslint:disable-next-line:no-await-in-loop
        await this.sleep(this.lockOpts.pollIntervalMs);
        // tslint:disable-next-line:no-await-in-loop
        const cached = await this.get<T>(key, true);
        if (cached !== null) return cached;
      }

      // Timed out – compute anyway (last resort).
      log.warn(
        { key },
        'Timed out waiting for lock holder, computing independently',
      );
      const result = await computeFn();
      // No set() here to avoid double-write thrash.
      return result;
    }
  }

  /**
   * Invalidates all cache entries associated with given tags.
   * Returns number of keys purged.
   */
  public async invalidateTags(...tags: string[]): Promise<number> {
    let totalDeleted = 0;
    for (const tag of tags) {
      const indexKey = `${TAG_INDEX_PREFIX}${tag}`;
      const keys = await this.redis.smembers(indexKey);

      if (keys.length) {
        const pipeline = this.redis.pipeline();
        pipeline.del(...keys); // Delete entries
        pipeline.del(indexKey); // Delete index set
        const [[, deleted]] = (await pipeline.exec()) as [
          [null | Error, number],
        ][];
        totalDeleted += deleted;
        log.debug({ tag, deleted }, 'Invalidated tag');
      }
    }
    return totalDeleted;
  }

  /**
   * Background revalidation helper – fire-and-forget.
   */
  private async revalidate<T>(
    key: string,
    computeFn: () => Promise<T>,
    options: CacheOptions,
  ): Promise<void> {
    try {
      const freshValue = await computeFn();
      await this.set(key, freshValue, options);
    } catch (err) {
      log.error({ err, key }, 'Failed to revalidate cache key');
      // Swallow to avoid surfacing OK-path errors.
    }
  }

  /* ------------------------------------------------------------------------ */
  /*                           Utility / housekeeping                         */
  /* ------------------------------------------------------------------------ */

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Gracefully closes the Redis connection – primarily for testing.
   */
  public async shutdown(): Promise<void> {
    await this.redis.quit();
  }
}

/* -------------------------------------------------------------------------- */
/*                             Default Export (DI)                            */
/* -------------------------------------------------------------------------- */

/**
 * In production the cache manager is typically instantiated once and shared
 * through dependency injection. We still expose a singleton for convenience.
 */
let _singleton: ResponseCacheManager | null = null;
export function getCacheManager(): ResponseCacheManager {
  if (!_singleton) {
    _singleton = new ResponseCacheManager();
  }
  return _singleton;
}
```
