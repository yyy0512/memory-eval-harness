```typescript
/**************************************************************************************************
 * SocialPulse Gateway – Response Caching Module
 * --------------------------------------------------------------
 * File:        src/module_49.ts
 * Description: Production-ready response–caching abstraction built for high-fan-out, read-heavy
 *              endpoints such as public timelines and trending hashtags. The module exposes:
 *
 *               • CacheProvider          – Pluggable low-level cache contract
 *               • RedisCacheProvider     – I/O-optimized Redis implementation (using ioredis)
 *               • ResponseCacheService   – Domain-oriented façade consumed by controllers/resolvers
 *               • cacheable()            – Method decorator for seamless Nest-like usage
 *
 *              All code follows strict clean-architecture boundaries: business logic stays
 *              framework-agnostic while adapters (Redis) live in the infrastructure layer.
 **************************************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */

import Redis, { RedisOptions } from 'ioredis';
import crypto from 'node:crypto';
import type { Logger } from 'pino';
import { z } from 'zod';

/**
 * ---------------------------------------------------------------------------
 * CacheProvider (Port)
 * ---------------------------------------------------------------------------
 * Minimal contract shielding the app from concrete key/value stores.
 */
export interface CacheProvider {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  flush(pattern?: string): Promise<void>;
}

/**
 * ---------------------------------------------------------------------------
 * RedisCacheProvider (Adapter)
 * ---------------------------------------------------------------------------
 */
export class RedisCacheProvider implements CacheProvider {
  private readonly client: Redis;

  constructor(redisUrl: string, options: RedisOptions = {}) {
    this.client = new Redis(redisUrl, {
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      ...options,
    });

    this.client.on('error', (err) => {
      /* eslint-disable-next-line no-console */
      console.error('[RedisCacheProvider] connection error:', err);
    });
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(key);
    if (raw === null) return undefined;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // Corrupted entry; make sure to remove it to avoid poisoning future reads.
      await this.del(key);
      return undefined;
    }
  }

  async set<T = unknown>(key: string, value: T, ttlSeconds = 60): Promise<void> {
    const payload = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await this.client.set(key, payload, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, payload);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Flush keys matching a pattern (e.g., app:timeline:*). Uses SCAN to avoid
   * blocking Redis. Will silently ignore any errors.
   */
  async flush(pattern = '*'): Promise<void> {
    let cursor = '0';
    const pipeline = this.client.pipeline();

    do {
      /* eslint-disable-next-line no-await-in-loop */
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      keys.forEach((k) => pipeline.del(k));
    } while (cursor !== '0');

    await pipeline.exec();
  }
}

/**
 * ---------------------------------------------------------------------------
 * ResponseCacheService (Use-case)
 * ---------------------------------------------------------------------------
 */
export interface ResponseCacheConfig {
  namespace: string;
  defaultTtlSeconds?: number;
  logger?: Logger;
  provider: CacheProvider;
}

export class ResponseCacheService {
  private readonly ns: string;
  private readonly provider: CacheProvider;
  private readonly defaultTtl: number;
  private readonly logger?: Logger;

  constructor(cfg: ResponseCacheConfig) {
    this.ns = cfg.namespace.replace(/:+$/, ''); // strip trailing colon(s)
    this.provider = cfg.provider;
    this.defaultTtl = Math.max(1, cfg.defaultTtlSeconds ?? 60);
    this.logger = cfg.logger;
  }

  /**
   * Build a deterministic cache key inside the configured namespace.
   */
  buildKey(seed: unknown): string {
    if (typeof seed === 'string') return `${this.ns}:${seed}`;

    // Stable serialization for objects/arrays
    const hash = crypto.createHash('sha1').update(JSON.stringify(seed)).digest('hex');
    return `${this.ns}:${hash}`;
  }

  /**
   * Ensure we either fetch a cached value or compute & persist it atomically.
   */
  async getOrSet<T>(
    keySeed: unknown,
    producer: () => Promise<T>,
    ttlSeconds = this.defaultTtl,
  ): Promise<T> {
    const key = this.buildKey(keySeed);

    // 1. Fast path – cache hit
    const cached = await this.provider.get<T>(key);
    if (cached !== undefined) {
      this.logger?.debug({ key }, 'cache hit');
      return cached;
    }

    // 2. Miss – generate new value
    const fresh = await producer();

    // 3. Resilience: only cache serializable responses < 512kB
    try {
      const serialized = JSON.stringify(fresh);
      if (Buffer.byteLength(serialized, 'utf8') < 512 * 1024) {
        await this.provider.set(key, fresh, ttlSeconds);
        this.logger?.debug({ key }, 'cache set');
      } else {
        this.logger?.warn({ key }, 'response too large to cache');
      }
    } catch (err) {
      this.logger?.error({ err, key }, 'failed to cache response');
    }

    return fresh;
  }

  async invalidate(keySeed: unknown): Promise<void> {
    const key = this.buildKey(keySeed);
    await this.provider.del(key);
    this.logger?.info({ key }, 'cache invalidated');
  }

  /**
   * Functional helper: wraps an async fn returning a response and transparently
   * adds caching using its argument(s) as the cache key seed.
   */
  wrap<
    Args extends any[],
    Result,
  >(producer: (...args: Args) => Promise<Result>, ttlSeconds?: number) {
    return async (...args: Args): Promise<Result> =>
      this.getOrSet(args, () => producer(...args), ttlSeconds);
  }
}

/**
 * ---------------------------------------------------------------------------
 * cacheable() decorator
 * ---------------------------------------------------------------------------
 * Nest-compatible method decorator to be applied on controller/resolver methods:
 *
 *   @cacheable(cacheService, { ttlSeconds: 30 })
 *   async getTrending(@Query('tag') tag: string) { ... }
 */
export interface CacheableOptions {
  ttlSeconds?: number;
  keySchema?: z.ZodSchema; // optional runtime validation of key seed
}

export function cacheable(
  service: ResponseCacheService,
  opts: CacheableOptions = {},
): MethodDecorator {
  const ttl = opts.ttlSeconds ?? service['defaultTtl']; // eslint-disable-line dot-notation
  const schema = opts.keySchema;

  return (
    _target: unknown,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): void => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    if (typeof original !== 'function')
      throw new TypeError('cacheable decorator can only be applied to functions');

    descriptor.value = async function (...args: unknown[]) {
      // Optional argument validation to keep cache keys deterministic
      if (schema) {
        try {
          schema.parse(args);
        } catch (err) {
          // Do NOT cache if validation fails; just call through
          return original.apply(this, args);
        }
      }

      return service.getOrSet(args, () => original.apply(this, args), ttl);
    };
  };
}

/**
 * ---------------------------------------------------------------------------
 * Factory helper – wire everything together using environment vars
 * ---------------------------------------------------------------------------
 */
export function makeDefaultCacheService(logger?: Logger): ResponseCacheService {
  const {
    REDIS_URL = 'redis://127.0.0.1:6379/0',
    CACHE_NAMESPACE = 'spg',
    CACHE_DEFAULT_TTL_SEC = '60',
  } = process.env;

  const provider = new RedisCacheProvider(REDIS_URL);
  return new ResponseCacheService({
    namespace: CACHE_NAMESPACE,
    defaultTtlSeconds: Number(CACHE_DEFAULT_TTL_SEC),
    provider,
    logger,
  });
}
```