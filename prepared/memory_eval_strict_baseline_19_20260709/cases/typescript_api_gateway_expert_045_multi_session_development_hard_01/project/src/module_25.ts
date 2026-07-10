```typescript
/**
 * src/module_25.ts
 *
 * Centralised, production-grade response caching module for SocialPulse Gateway.
 *
 * Responsibilities:
 *  • Creates a resilient façade on top of Redis to cache HTTP / GraphQL responses.
 *  • Falls back to an in-memory LRU cache when Redis is unavailable.
 *  • Provides tag-based invalidation so that domain events (e.g., new post) can
 *    bust cache entries tied to affected aggregations (e.g., public timeline).
 *  • Automatically builds stable cache keys based on a request signature
 *    (method, path, query, body hash, and API version).
 *  • Emits lifecycle events for observability (hit, miss, set, invalidate).
 *
 * NOTE:
 *  This module intentionally avoids any framework-specific code (Express,
 *  Apollo, NestJS, etc.) to maintain Clean Architecture boundaries. Adapters
 *  living inside presentation / infrastructure layers can import this module
 *  to plug caching into controllers and resolvers.
 */

import Redis, { RedisOptions } from 'ioredis';
import crypto from 'crypto';
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';
import pino from 'pino';

const logger = pino({ name: 'ResponseCacheManager' });

/**
 * Contract describing the operations a cache manager must expose.
 */
export interface IResponseCacheManager {
  /**
   * Fetches a cached value or resolves it using the given fetcher callback.
   */
  getOrSet<T>(
    reqSignature: RequestSignature,
    ttlSeconds: number,
    tags: string[],
    fetcher: () => Promise<T>
  ): Promise<T>;

  /**
   * Invalidates cached responses whose tag set intersects any of the tags
   * provided (OR semantics).
   */
  invalidateByTags(tags: string[]): Promise<void>;

  /**
   * Manually evicts a single cache key.
   */
  delete(reqSignature: RequestSignature): Promise<void>;

  /**
   * Observable event emitter.
   */
  readonly events: EventEmitter;
}

/**
 * Shape of data used to build a stable cache key.
 */
export interface RequestSignature {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * For GraphQL, this should be the operationName + variables.
   * For REST, this can be the request body (stringified).
   */
  body?: unknown;
  /**
   * Version of the API route / GraphQL schema.
   * This keeps different versions from colliding.
   */
  version: string;
}

/**
 * Redis key parts separator (must not appear in path).
 */
const KEY_SEPARATOR = '::';

/**
 * Internal envelope to store response + metadata.
 */
interface CacheEnvelope<T = unknown> {
  payload: T;
  tags: string[];
}

/**
 * Run-time configuration for the manager.
 */
export interface ResponseCacheConfig {
  redis?: RedisOptions & { isEnabled: boolean };
  /**
   * Number of items to keep in the in-memory fallback cache.
   */
  memoryFallbackCapacity?: number;
  /**
   * Prefix added to all Redis keys to avoid collisions with other modules.
   */
  keyPrefix?: string;
}

const DEFAULT_CONFIG: Required<Omit<ResponseCacheConfig, 'redis'>> = {
  memoryFallbackCapacity: 5_000,
  keyPrefix: 'spg:cache',
};

/**
 * Production-grade implementation of IResponseCacheManager.
 *
 * • Attempts Redis first; on failure, uses an in-memory LRU cache so
 *   application throughput is not compromised during outages.
 * • Tag invalidation is only guaranteed within Redis. In-memory tags are best-effort.
 */
export class ResponseCacheManager implements IResponseCacheManager {
  private readonly redis?: Redis;
  private readonly memoryCache: LRUCache<string, CacheEnvelope>;
  readonly events = new EventEmitter();
  private readonly prefix: string;

  constructor(private readonly config: ResponseCacheConfig = {}) {
    const resolvedCfg = { ...DEFAULT_CONFIG, ...config };
    this.prefix = resolvedCfg.keyPrefix;
    this.memoryCache = new LRUCache({
      max: resolvedCfg.memoryFallbackCapacity,
    });

    if (config.redis?.isEnabled) {
      this.redis = new Redis({
        keyPrefix: resolvedCfg.keyPrefix + KEY_SEPARATOR,
        ...config.redis,
      });

      this.redis.on('error', (err) => {
        logger.error({ err }, 'Redis connection error — will use memory cache fallback');
      });
    }
  }

  /**
   * Public API: get cached response or compute and cache it atomically.
   */
  async getOrSet<T>(
    reqSignature: RequestSignature,
    ttlSeconds: number,
    tags: string[],
    fetcher: () => Promise<T>
  ): Promise<T> {
    const cacheKey = this.buildCacheKey(reqSignature);

    // 1. Check Redis (clustered, multi-instance, should be primary).
    if (this.redis) {
      try {
        const redisData = await this.redis.get(cacheKey);
        if (redisData) {
          this.events.emit('hit', { driver: 'redis', key: cacheKey });
          return JSON.parse(redisData) as T;
        }
      } catch (err) {
        logger.error({ err }, 'Redis get operation failed');
      }
    }

    // 2. Check in-memory fallback.
    const memoryData = this.memoryCache.get(cacheKey);
    if (memoryData) {
      this.events.emit('hit', { driver: 'memory', key: cacheKey });
      return memoryData.payload as T;
    }

    // 3. Cache miss — compute result.
    this.events.emit('miss', { key: cacheKey });
    const payload = await fetcher();

    const envelope: CacheEnvelope = { payload, tags };
    const encoded = JSON.stringify(envelope);

    // 3.a Store in Redis (best effort).
    if (this.redis) {
      try {
        await this.redis.set(cacheKey, encoded, 'EX', ttlSeconds);
        this.events.emit('set', { driver: 'redis', key: cacheKey, ttlSeconds });
      } catch (err) {
        logger.error({ err }, 'Redis set operation failed');
      }
    }

    // 3.b Store in memory (absolute TTL is approximated using maxAge).
    this.memoryCache.set(cacheKey, envelope, { ttl: ttlSeconds * 1_000 });
    this.events.emit('set', { driver: 'memory', key: cacheKey, ttlSeconds });

    return payload;
  }

  /**
   * Deletes a specific cache entry.
   */
  async delete(reqSignature: RequestSignature): Promise<void> {
    const cacheKey = this.buildCacheKey(reqSignature);

    // Redis
    if (this.redis) {
      try {
        await this.redis.del(cacheKey);
      } catch (err) {
        logger.error({ err }, 'Redis del operation failed');
      }
    }

    // Memory
    this.memoryCache.delete(cacheKey);
    this.events.emit('invalidate', { key: cacheKey });
  }

  /**
   * Tag-based invalidation.
   */
  async invalidateByTags(tags: string[]): Promise<void> {
    if (!tags.length) return;

    const redisAvailable = Boolean(this.redis);
    const tagSet = new Set(tags);

    // 1. Redis — use Lua script for atomic set scan + delete.
    if (redisAvailable) {
      await this.invalidateRedisByTags(tags).catch((err) =>
        logger.error({ err }, 'Redis tag invalidation failed')
      );
    }

    // 2. In-memory cache — iterate synchronously.
    for (const [key, envelope] of this.memoryCache.entries()) {
      if (envelope.tags.some((t) => tagSet.has(t))) {
        this.memoryCache.delete(key);
        this.events.emit('invalidate', { key });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  private buildCacheKey(sig: RequestSignature): string {
    const queryPart = sig.query ? JSON.stringify(sig.query) : '';
    const bodyPart =
      sig.body && Object.keys(sig.body as object).length
        ? crypto.createHash('sha1').update(JSON.stringify(sig.body)).digest('hex')
        : '';
    return (
      this.prefix +
      KEY_SEPARATOR +
      [sig.version, sig.method, sig.path, queryPart, bodyPart]
        .filter(Boolean)
        .join(KEY_SEPARATOR)
    );
  }

  /**
   * Uses a Lua script to iterate over keys and delete those whose JSON payload
   * contains at least one of the provided tags. This is O(n) but executed
   * server-side, avoiding round-trips.
   */
  private async invalidateRedisByTags(tags: string[]): Promise<void> {
    if (!this.redis) return;

    const lua = `
      local cursor = "0"
      repeat
        local result = redis.call("SCAN", cursor, "MATCH", KEYS[1], "COUNT", 1000)
        cursor = result[1]
        local keys = result[2]
        for i, k in ipairs(keys) do
          local data = redis.call("GET", k)
          if data then
            local decoded = cjson.decode(data)
            if decoded["tags"] then
              for _, t in ipairs(decoded["tags"]) do
                for _, match in ipairs(ARGV) do
                  if t == match then
                    redis.call("DEL", k)
                  end
                end
              end
            end
          end
        end
      until cursor == "0"
      return 1
    `;

    const matchPattern = `${this.prefix}${KEY_SEPARATOR}*`;
    await this.redis.eval(lua, 1, matchPattern, ...tags);
    this.events.emit('invalidate', { tags });
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

// Configuration could be sourced from environment variables or config service.
const globalCacheManager = new ResponseCacheManager({
  redis: {
    isEnabled: process.env.CACHE_REDIS_ENABLED === 'true',
    host: process.env.CACHE_REDIS_HOST,
    port: Number(process.env.CACHE_REDIS_PORT ?? 6379),
    password: process.env.CACHE_REDIS_PASSWORD,
    db: Number(process.env.CACHE_REDIS_DB ?? 0),
  },
});

export default globalCacheManager;
```
