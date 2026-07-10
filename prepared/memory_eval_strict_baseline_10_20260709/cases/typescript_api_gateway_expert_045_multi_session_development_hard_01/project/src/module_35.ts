```typescript
/***************************************************************************************************
 * File:        src/module_35.ts
 * Project:     SocialPulse Gateway (api_gateway)
 * Description: High-level, production-grade response-caching utilities that sit in the
 *              infrastructure layer.  The module exposes:
 *                  1. ResponseCache  – singleton, low-level cache facade backed by Redis.
 *                  2. @Cached()      – ergonomic method decorator for use in controllers/
 *                                      resolvers/service-layer functions.
 *
 *              Design goals:
 *                  • Simple, framework-agnostic API (works with Express, Apollo, Nest, Fastify …)
 *                  • Version-aware cache keys (enables side-by-side rollout of algorithm changes)
 *                  • Solid error-handling — cache failures never break the request flow
 *                  • Structured logging compatible with the gateway’s observability pipeline
 *
 *              NOTE: This file intentionally avoids any concrete framework imports to keep the
 *              surface generic; adapt the `Logger` import to match your logging solution.
 ***************************************************************************************************/

import Redis, { Redis as RedisClient } from 'ioredis';
import crypto from 'crypto';
import ms from 'ms';

// -----------------------------------------------------------------------------
// Environment helpers (replace with your own configuration management solution)
// -----------------------------------------------------------------------------
/** Centralised environment contract used by infra-level utilities */
interface EnvContract {
  REDIS_URI: string;                 // e.g. redis://user:pass@redis:6379/0
  REDIS_NAMESPACE?: string;          // default: socialpulse:gw:cache
  NODE_ENV?: 'development' | 'test' | 'staging' | 'production';
}

const Environment: EnvContract = {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ...process.env as unknown as EnvContract,
};

// -----------------------------------------------------------------------------
// Logger shim (swap for Pino / Winston / Bunyan / etc.)
// -----------------------------------------------------------------------------
/**
 * Very small subset of a structured logger interface.
 * Replace this shim with the actual gateway-wide logger implementation
 * (e.g. import { logger as Logger } from '@socialpulse/logging';)
 */
class Logger {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static child(_ctx: Record<string, any>) {
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static info(msg: string, ctx?: any) {
    // eslint-disable-next-line no-console
    console.info(msg, ctx ?? '');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static warn(msg: string, ctx?: any) {
    // eslint-disable-next-line no-console
    console.warn(msg, ctx ?? '');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static error(msg: string, ctx?: any) {
    // eslint-disable-next-line no-console
    console.error(msg, ctx ?? '');
  }
}

// -----------------------------------------------------------------------------
// Cache interfaces & types
// -----------------------------------------------------------------------------
/** Meta-data describing a stored cache entry */
export interface CacheEntryMeta {
  /** UNIX timestamp (ms) when entry was created */
  createdAt: number;
  /** Time-to-live (s) */
  ttl: number;
  /** API version the entry belongs to, e.g. v1, v2, 2023-05-preview */
  version: string;
}

/** Shape of the serialized object that lands in Redis */
export interface CachedValue<T = unknown> {
  meta: CacheEntryMeta;
  payload: T;
}

/** Options for the `@Cached()` decorator */
export interface CacheOptions {
  /**
   * TTL expressed either in seconds or in human-readable time format
   * accepted by `ms` (e.g. "10m", "24h"). Defaults to 5 minutes.
   */
  ttl?: number | string;
  /**
   * Either a constant string or a function generating a key from runtime args.
   * If omitted, the decorator falls back to a SHA-256 hash of the JSONified args.
   */
  key?: string | ((...fnArgs: unknown[]) => string);
  /**
   * API version – automatically picked from request headers when using a typical
   * Express/Apollo context (`req.headers['x-api-version']`).  Override if you
   * need something special.
   */
  version?: string;
}

// -----------------------------------------------------------------------------
// ResponseCache singleton — low-level Redis facade
// -----------------------------------------------------------------------------
export class ResponseCache {
  private static INSTANCE: ResponseCache;
  private redis!: RedisClient;
  private readonly logger = Logger.child({ scope: 'ResponseCache' });
  private readonly namespace: string;

  private constructor() {
    this.namespace = Environment.REDIS_NAMESPACE ?? 'socialpulse:gw:cache';
    this.bootstrapRedis();
  }

  /* -------------------------------------------------------------------------
   * Public factory — ensures only one connection per process
   * ---------------------------------------------------------------------- */
  static getInstance(): ResponseCache {
    if (!this.INSTANCE) {
      this.INSTANCE = new ResponseCache();
    }
    return this.INSTANCE;
  }

  /* -------------------------------------------------------------------------
   * Core public API
   * ---------------------------------------------------------------------- */

  /**
   * Retrieve or (atomically) compute & store value under the supplied key.
   *
   * NB: On Redis failures, the method degrades gracefully — logs and returns
   *     the freshly computed value, ensuring gateway resilience.
   */
  async getOrSet<T>(
    rawKey: string,
    ttlSeconds: number,
    factory: () => Promise<T>,
    version = 'v1',
  ): Promise<T> {
    const key = this.buildKey(`${version}:${rawKey}`);

    try {
      const cached = await this.redis.get(key);
      if (cached) {
        const wrapper = JSON.parse(cached) as CachedValue<T>;
        return wrapper.payload;
      }
    } catch (err) {
      this.logger.warn('Redis read error, falling back to fresh computation', { err, key });
      // fall through to computation
    }

    // Either not present or failed to load — compute
    const payload = await factory();

    // Fire-and-forget write; we don’t block the request on Redis I/O
    this.persist<T>(key, payload, ttlSeconds, version).catch((err) => {
      this.logger.warn('Redis write error (non-blocking)', { err, key });
    });

    return payload;
  }

  /** Explicit cache-bust by raw key & API version */
  async invalidate(rawKey: string, version = 'v1'): Promise<void> {
    const key = this.buildKey(`${version}:${rawKey}`);
    try {
      await this.redis.del(key);
      this.logger.info('Cache invalidated', { key });
    } catch (err) {
      this.logger.warn('Failed to invalidate cache', { err, key });
    }
  }

  /* -------------------------------------------------------------------------
   * Internal helpers
   * ---------------------------------------------------------------------- */

  /** Crypto-grade hashing to avoid key length limits & ensure even distribution */
  private buildKey(raw: string): string {
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    return `${this.namespace}:${hash}`;
  }

  /** Serialize & persist value to Redis with TTL */
  private async persist<T>(
    key: string,
    payload: T,
    ttl: number,
    version: string,
  ): Promise<void> {
    const entry: CachedValue<T> = {
      meta: { createdAt: Date.now(), ttl, version },
      payload,
    };
    await this.redis.setex(key, ttl, JSON.stringify(entry));
  }

  /** Initialize Redis connection lazily & register connection diagnostics */
  private bootstrapRedis(): void {
    if (!Environment.REDIS_URI) {
      throw new Error('REDIS_URI must be provided in environment variables');
    }

    this.redis = new Redis(Environment.REDIS_URI, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      enableAutoPipelining: true,
      connectTimeout: 5_000,
    });

    // Initiate connection; keep async to avoid blocking startup
    this.redis.connect().catch((err) => {
      this.logger.error('Failed to establish initial Redis connection', { err });
    });

    this.redis.on('error', (err) => {
      this.logger.error('Redis client error', { err });
    });

    this.redis.on('reconnecting', () => {
      this.logger.warn('Redis reconnecting …');
    });

    this.redis.on('connect', () => {
      this.logger.info('Connected to Redis');
    });
  }
}

// -----------------------------------------------------------------------------
// @Cached() decorator — high-level “just sprinkle on method” sugar
// -----------------------------------------------------------------------------
/**
 * Transparently cache the result of an async method.
 *
 * Usage example (Express/Apollo context):
 *
 *   class TimelineController {
 *     // Cache user timeline for 30 seconds
 *     @Cached({ ttl: 30, key: (userId) => `timeline:${userId}` })
 *     async fetchTimeline(userId: string) {
 *       return this.timelineService.getTimeline(userId);
 *     }
 *   }
 */
export function Cached(options: CacheOptions = {}): MethodDecorator {
  const ttlDefaultSeconds = 300; // 5 minutes

  return (
    // eslint-disable-next-line @typescript-eslint/ban-types
    _target: Object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor | void => {
    const original = descriptor.value;

    if (typeof original !== 'function') {
      throw new TypeError('@Cached can only decorate asynchronous functions');
    }

    descriptor.value = async function (...args: unknown[]) {
      const cache = ResponseCache.getInstance();

      // Resolve TTL
      const ttl =
        typeof options.ttl === 'string'
          ? Math.max(Math.floor(ms(options.ttl) / 1_000), 1)
          : options.ttl ?? ttlDefaultSeconds;

      // Resolve API version (header takes precedence)
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore – the runtime might not have req (unit tests etc.)
      const versionHeader: string | undefined = this?.req?.headers?.['x-api-version'];
      const version = options.version ?? versionHeader ?? 'v1';

      // Resolve cache key
      const rawKey =
        typeof options.key === 'function'
          ? options.key(...args)
          : options.key ?? `${String(_propertyKey)}:${JSON.stringify(args)}`;

      // Delegate to the cache layer
      return await cache.getOrSet<TUnknown>(
        rawKey,
        ttl,
        () => original.apply(this, args),
        version,
      );
    };

    return descriptor;
  };
}

// Utility type — unwrap Promise return type for descriptor.value
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TUnknown = any;
```