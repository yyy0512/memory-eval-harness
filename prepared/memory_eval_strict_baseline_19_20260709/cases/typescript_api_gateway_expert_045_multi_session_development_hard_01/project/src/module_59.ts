```typescript
/**
 * SocialPulse Gateway
 * Module: Response Cache (Redis + Pub/Sub)
 *
 * This module offers a production-grade, distributed response-caching
 * capability that can be plugged into REST controllers, GraphQL resolvers,
 * or any arbitrary asynchronous function.  It supports:
 *
 *   • Automatic serialization / deserialization
 *   • Per-key or per-tag invalidation
 *   • Cross-instance synchronisation via Redis Pub/Sub
 *   • Pluggable TTL policies
 *   • Structured logging & graceful error handling
 *
 * The implementation purposefully stays infrastructure-agnostic: consumers
 * interact through the exported `responseCache` instance or helper utilities
 * such as `cacheRoute` and `CacheableQuery`.
 */

import { createHash } from 'crypto';
import EventEmitter from 'events';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import winston from 'winston';

// ---------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------

const CACHE_CHANNEL = 'sp-gateway:cache:invalidation';

type JsonPrimitive = string | number | boolean | null;
type Json =
  | JsonPrimitive
  | Json[]
  | { [key: string]: Json };

interface CacheEntry<T extends Json = Json> {
  /** JSON-serialisable payload. */
  data: T;
  /** ISO date string (RFC3339) indicating when the payload was cached. */
  cachedAt: string;
}

interface CacheOptions {
  /** TTL in seconds for this entry. */
  ttlSeconds?: number;
  /** Arbitrary tags to facilitate coarse-grained invalidation. */
  tags?: string[];
}

interface InvalidationMessage {
  /** Either a fully-qualified cache key or a tag identifier. */
  target: string;
  /** `key` | `tag` */
  mode: 'key' | 'tag';
  /** Originating instance ID for debouncing. */
  instanceId: string;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Creates a SHA-256 digest of the provided string. Suitable for generating
 * constant-length cache keys from high-entropy inputs (URLs, GraphQL queries).
 */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function isJson(value: unknown): value is Json {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = winston.child({ module: 'response-cache' });

// ---------------------------------------------------------------------------
// ResponseCache – core class
// ---------------------------------------------------------------------------

export class ResponseCache extends EventEmitter {
  private readonly redis: RedisClient;
  private readonly instanceId = `${process.pid}-${Math.random().toString(36).substring(2, 8)}`;

  constructor(redisUrl: string | RedisClient) {
    super();

    // Allow passing an existing client or redis URL.
    this.redis = typeof redisUrl === 'string' ? new Redis(redisUrl) : redisUrl;

    // Subscribe to invalidation broadcasts.
    const sub = this.redis.duplicate();
    sub.subscribe(CACHE_CHANNEL, (err) => {
      if (err) logger.error('Failed to subscribe to invalidation channel', { err });
    });
    sub.on('message', this.handleInvalidationMessage.bind(this));
  }

  /**
   * Attempt to read from cache; if unavailable, delegate to `loader` and write.
   * A promise is returned regardless of cache hit/miss.
   */
  async getOrSet<T extends Json>(
    key: string,
    loader: () => Promise<T>,
    { ttlSeconds = 30, tags = [] }: CacheOptions = {}
  ): Promise<CacheEntry<T>> {
    const hashedKey = sha256(key);
    try {
      // ---------- Cache Lookup ----------
      const raw = await this.redis.get(hashedKey);
      if (raw) {
        logger.debug('Cache hit', { key });
        return JSON.parse(raw) as CacheEntry<T>;
      }

      // ---------- Cache Miss – Load Data ----------
      logger.debug('Cache miss', { key });
      const data = await loader();

      if (!isJson(data)) {
        throw new Error('Non-serialisable data encountered in ResponseCache');
      }

      const entry: CacheEntry<T> = { data, cachedAt: new Date().toISOString() };
      const payload = JSON.stringify(entry);

      // ---------- Redis Write ----------
      const pipeline = this.redis.pipeline().set(hashedKey, payload, 'EX', ttlSeconds);

      // Store reverse tag lookups for group invalidation
      tags.forEach((tag) => {
        const tagSetKey = this.tagKey(tag);
        pipeline.sadd(tagSetKey, hashedKey);
        pipeline.expire(tagSetKey, ttlSeconds); // expire tag set alongside individual keys
      });

      await pipeline.exec();

      return entry;
    } catch (err) {
      // We never throw cache-specific errors to callers; only log privately.
      logger.error('Error inside ResponseCache.getOrSet', { err, key });
      // Fallback: attempt to return fresh data without touching cache
      const data = await loader();
      return { data, cachedAt: new Date().toISOString() };
    }
  }

  /**
   * Invalidate a single cache entry.
   */
  async invalidateKey(key: string): Promise<void> {
    const hashedKey = sha256(key);
    await this.redis.del(hashedKey);
    await this.broadcastInvalidation({ mode: 'key', target: hashedKey });
    logger.info('Cache invalidated (key)', { key });
  }

  /**
   * Invalidate every cache key associated with the provided tag.
   */
  async invalidateTag(tag: string): Promise<void> {
    const tagSetKey = this.tagKey(tag);
    const members = await this.redis.smembers(tagSetKey);
    if (members.length) {
      const pipeline = this.redis.pipeline();
      members.forEach((m) => pipeline.del(m));
      pipeline.del(tagSetKey);
      await pipeline.exec();
      logger.info('Cache invalidated (tag)', { tag, affected: members.length });
      await this.broadcastInvalidation({ mode: 'tag', target: tag });
    }
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private tagKey(tag: string) {
    return `sp:cache:tag:${tag}`;
  }

  private async broadcastInvalidation(msg: Omit<InvalidationMessage, 'instanceId'>) {
    const full: InvalidationMessage = { ...msg, instanceId: this.instanceId };
    await this.redis.publish(CACHE_CHANNEL, JSON.stringify(full));
  }

  private async handleInvalidationMessage(_channel: string, raw: string) {
    try {
      const msg: InvalidationMessage = JSON.parse(raw);
      if (msg.instanceId === this.instanceId) return; // Ignore echoes

      if (msg.mode === 'key') {
        await this.redis.del(msg.target);
        logger.debug('Remote key invalidation processed', { key: msg.target });
      } else {
        // Tag invalidation
        await this.invalidateTag(msg.target);
        logger.debug('Remote tag invalidation processed', { tag: msg.target });
      }
    } catch (err) {
      logger.warn('Failed to process invalidation message', { err, raw });
    }
  }
}

// ---------------------------------------------------------------------------
// Public, pre-configured singleton (can be exchanged in tests)
// ---------------------------------------------------------------------------

export const responseCache = new ResponseCache(process.env.REDIS_URL ?? 'redis://localhost:6379');

// ---------------------------------------------------------------------------
// Express Helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an Express route handler with caching semantics.
 *
 * @example
 *  router.get(
 *    '/trending',
 *    cacheRoute({ ttlSeconds: 60 }),
 *    async (_req, res) => {
 *      const data = await trendingService.fetch();
 *      res.json(data);
 *    }
 *  );
 */
export function cacheRoute(
  opts: CacheOptions & {
    /**
     * Generates a unique string from the inbound HTTP request to be used as
     * the cache key. Defaults to `req.originalUrl`.
     */
    keyGenerator?: (req: Request) => string;
  }
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only GET + HEAD requests are considered cache-friendly.
    if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) {
      return next();
    }

    const keyGen = opts.keyGenerator ?? ((r: Request) => r.originalUrl);
    const cacheKey = keyGen(req);

    try {
      const entry = await responseCache.getOrSet(
        cacheKey,
        // Loader: we delegate to downstream handlers & capture body
        async () =>
          new Promise<Json>((resolve, reject) => {
            // Monkey-patch res.json to intercept the payload
            const originalJson = res.json.bind(res);
            res.json = (body: unknown) => {
              if (!isJson(body)) {
                reject(new Error('Non-serialisable body in cacheRoute loader'));
                return originalJson(body); // still send
              }
              resolve(body as Json);
              return originalJson(body);
            };
            next(); // Continue to actual route handler
          }),
        opts
      );

      // If loader was not executed (cache hit) we must manually send the data.
      // For HEAD requests we only send status/headers.
      if (res.headersSent) return; // Loader handled the response
      if (req.method.toUpperCase() === 'HEAD') {
        res.status(200).end();
      } else {
        res.json(entry.data);
      }
    } catch (err) {
      logger.error('cacheRoute encountered an error', { err });
      next(); // proceed without caching
    }
  };
}

// ---------------------------------------------------------------------------
// GraphQL Helpers
// ---------------------------------------------------------------------------

/**
 * Simple decorator for GraphQL resolvers (class or method level).
 *
 * Usage (with type-graphql or similar):
 *
 *   @CacheableQuery({ ttlSeconds: 10, tags: ['timeline'] })
 *   @Query(() => [Post])
 *   async publicTimeline(@Arg('limit') limit: number) {
 *       return this.timelineService.fetch(limit);
 *   }
 *
 * The decorator overrides the original resolver method, adding caching logic.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export function CacheableQuery(opts: CacheOptions) {
  // eslint-disable-next-line @typescript-eslint/ban-types
  return (target: Object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const original = descriptor.value;
    if (typeof original !== 'function') {
      throw new TypeError('@CacheableQuery can only be applied to methods');
    }

    descriptor.value = async function (...args: unknown[]) {
      const keyInput = JSON.stringify({ propertyKey, args });
      const key = `${target.constructor.name}:${propertyKey.toString()}:${sha256(keyInput)}`;
      const entry = await responseCache.getOrSet(key, () => original.apply(this, args), opts);
      return entry.data;
    };
  };
}
```