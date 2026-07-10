```typescript
/***************************************************************************************************
 * File:        src/module_64.ts
 * Project:     SocialPulse Gateway (api_gateway)
 * Description: Centralised response-caching facility with Redis-first, in-memory fallback strategy.
 *              Exposes:
 *               – ResponseCacheService  : Programmatic API for low-level cache operations
 *               – withResponseCache()   : Declarative Express/GraphQL resolver decorator
 *
 * Rationale:
 *   Hot, high-fan-out endpoints (public timeline, trending hashtags, …) must remain <100 ms P95.
 *   To achieve this, the gateway relies on Redis for distributed caching. When Redis is down
 *   (network partition, maintenance), we transparently fall back to an in-memory LRU cache so that
 *   end-users still enjoy acceptable latencies albeit with reduced consistency guarantees.
 *
 *   The module embraces clean-architecture boundaries:
 *     – Domain-agnostic – only deals with caching concerns (infrastructure in hexagonal terms).
 *     – No direct coupling to controllers/resolvers; instead exposes a thin decorator so that
 *       presentation layer can opt-in without sacrificing tests or maintainability.
 ***************************************************************************************************/

import type { RedisClientType } from 'redis';
import { createClient } from 'redis';
import LRUCache from 'lru-cache';
import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import winston from 'winston';
import crypto from 'crypto';

/* -----------------------------------------------------------------------------------------------
 * Config
 * ---------------------------------------------------------------------------------------------*/

/**
 * Shape of cache-relevant environment variables. Extracted once at boot time.
 */
const cacheEnv = {
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  CACHE_DEFAULT_TTL_SEC: parseInt(process.env.CACHE_DEFAULT_TTL_SEC ?? '60', 10),
  CACHE_MAX_MEMORY_ITEMS: parseInt(process.env.CACHE_MAX_MEMORY_ITEMS ?? '10_000', 10),
  CACHE_NAMESPACE: process.env.CACHE_NAMESPACE ?? 'socialpulse:cache',
} as const;

/* -----------------------------------------------------------------------------------------------
 * Logger
 * ---------------------------------------------------------------------------------------------*/

const logger = winston.child({ module: 'response_cache' });

/* -----------------------------------------------------------------------------------------------
 * Utility functions
 * ---------------------------------------------------------------------------------------------*/

/**
 * Given request data, construct a stable, namespaced cache key.
 * We purposely:
 *  – Canonicalise query params (alphabetical order)
 *  – Include HTTP method to avoid GET/POST collisions
 *  – Allow custom “salt” for GraphQL op-name, algorithm version, …
 */
export interface CacheKeyInput {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  salt?: string;
}

export const buildCacheKey = (input: CacheKeyInput): string => {
  const sortedQuery = input.query
    ? Object.entries(input.query)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('&')
    : '';

  const raw = `${input.method.toUpperCase()}|${input.path}|${sortedQuery}|${input.salt ?? ''}`;

  // SHA-1 collision probability for single gateway is negligible (< 2⁻¹⁶⁰)
  const digest = crypto.createHash('sha1').update(raw).digest('hex');

  return `${cacheEnv.CACHE_NAMESPACE}:${digest}`;
};

/* -----------------------------------------------------------------------------------------------
 * ResponseCacheService
 * ---------------------------------------------------------------------------------------------*/

/**
 * Public interface: provides a façade over Redis/in-memory caching with
 * hierarchical-namespace eviction and typed helpers.
 */
export class ResponseCacheService {
  private readonly redis: RedisClientType | null;
  private readonly memory: LRUCache<string, unknown>;
  private readonly defaultTtlSec: number;

  constructor(redisClient?: RedisClientType, defaultTtlSec = cacheEnv.CACHE_DEFAULT_TTL_SEC) {
    this.redis = redisClient ?? null;
    this.defaultTtlSec = defaultTtlSec;

    this.memory = new LRUCache({
      max: cacheEnv.CACHE_MAX_MEMORY_ITEMS,
      ttl: defaultTtlSec * 1_000, // ms
    });
  }

  /* ------------------------------------------------------------------------- */
  /* Generic helpers                                                           */
  /* ------------------------------------------------------------------------- */

  public async get<T>(key: string): Promise<T | null> {
    // 1. Redis first
    if (this.redis) {
      try {
        const payload = await this.redis.get(key);
        if (payload !== null) {
          logger.debug(`Redis HIT   → ${key}`);
          return JSON.parse(payload) as T;
        }
        logger.debug(`Redis MISS  → ${key}`);
      } catch (err) {
        logger.error(`Redis get failed → ${String(err)}`);
        // Proceed to in-memory fallback
      }
    }

    // 2. In-memory fallback
    if (this.memory.has(key)) {
      logger.debug(`Memory HIT  → ${key}`);
      return this.memory.get(key) as T;
    }

    return null;
  }

  public async set<T>(
    key: string,
    value: T,
    ttlSec: number = this.defaultTtlSec,
  ): Promise<void> {
    // Serialize once, reuse for Redis + backup
    const payload = JSON.stringify(value);

    // 1. Redis
    if (this.redis) {
      try {
        await this.redis.set(key, payload, { EX: ttlSec });
        logger.debug(`Redis SET   → ${key} (${ttlSec}s)`);
      } catch (err) {
        logger.error(`Redis set failed → ${String(err)}`);
      }
    }

    // 2. In-memory backup
    this.memory.set(key, value, { ttl: ttlSec * 1_000 });
    logger.debug(`Memory SET  → ${key} (${ttlSec}s)`);
  }

  public async invalidate(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key);
      } catch (err) {
        logger.error(`Redis del failed → ${String(err)}`);
      }
    }
    this.memory.delete(key);
    logger.info(`Cache invalidated → ${key}`);
  }

  /* ------------------------------------------------------------------------- */
  /* Helper for hierarchical namespace eviction                                */
  /* ------------------------------------------------------------------------- */

  /**
   * Bulk invalidate entries with prefix (namespace).
   * WARNING: O(N) scan in Redis – do not abuse on hot path!
   */
  public async invalidateNamespace(prefix: string): Promise<void> {
    const redisPrefix = `${cacheEnv.CACHE_NAMESPACE}:${prefix}`;
    const pattern = `${redisPrefix}*`;

    if (this.redis) {
      try {
        const stream = this.redis.scanStream({ match: pattern });
        for await (const keys of stream) {
          if (Array.isArray(keys) && keys.length) {
            await this.redis!.del(keys);
            logger.info(`Bulk invalidated ${keys.length} keys (Redis) for ${prefix}`);
          }
        }
      } catch (err) {
        logger.error(`Namespace invalidation failed → ${String(err)}`);
      }
    }

    // In-memory eviction
    this.memory.forEach((_, k) => {
      if (k.startsWith(redisPrefix)) {
        this.memory.delete(k);
      }
    });
  }
}

/* -----------------------------------------------------------------------------------------------
 * Factory – singleton pattern to share connection across modules
 * ---------------------------------------------------------------------------------------------*/

let sharedService: ResponseCacheService | null = null;

export const getResponseCacheService = (): ResponseCacheService => {
  if (sharedService) return sharedService;

  let redisClient: RedisClientType | undefined;

  try {
    redisClient = createClient({ url: cacheEnv.REDIS_URL });
    redisClient.on('error', (err) => logger.error(`Redis error: ${String(err)}`));
    redisClient.connect().catch((err) => {
      logger.error(`Redis connection failed → fallback to memory only. Error: ${String(err)}`);
    });
  } catch (err) {
    logger.error(`Failed to bootstrap Redis client → ${String(err)}`);
    redisClient = undefined;
  }

  sharedService = new ResponseCacheService(redisClient);
  return sharedService;
};

/* -----------------------------------------------------------------------------------------------
 * Express/GraphQL decorator
 * ---------------------------------------------------------------------------------------------*/

export interface CacheDecoratorOptions {
  /**
   * TTL in seconds (overrides DEFAULT_TTL for this route/resolver).
   *   • 0  – bypass cache entirely
   *   • <0 – non-expiring (not recommended)
   */
  ttlSec?: number;

  /**
   * Add additional hash salt depending on dynamic factors such as:
   *   – Feature flag version
   *   – A/B test bucket
   */
  saltProvider?: (req: Request) => string | undefined;
}

/**
 * Declarative wrapper that transparently adds response-caching to an async route handler.
 *
 * Usage (REST):
 *     router.get(
 *       '/v1/public_timeline',
 *       withResponseCache({ ttlSec: 30 })(async (req, res) => {
 *         const data = await timelineService.fetchPublicTimeline();
 *         res.json(data);
 *       }),
 *     );
 *
 * Usage (GraphQL resolver):
 *     const timelineResolver = async (_parent, args, ctx) => { … };
 *     export default withResponseCache({ ttlSec: 30 })(timelineResolver);
 */
export const withResponseCache =
  (options: CacheDecoratorOptions = {}) =>
  <
    // Generic signature: Preserve original handler types (req,res,next) or (parent,args,ctx,info)
    T extends (...args: any[]) => Promise<any>
  >(
    handler: T,
  ): T =>
    (async function wrapper(this: unknown, ...args: Parameters<T>): Promise<ReturnType<T>> {
      const cache = getResponseCacheService();

      // Detect shape (Express vs GraphQL)
      const isRest = args[0] && typeof args[0] === 'object' && 'method' in args[0];
      if (!isRest) {
        // GraphQL – bypass entirely for now (different context building)
        return handler.apply(this, args);
      }

      const req = args[0] as Request;
      const res = args[1] as Response;
      const next = args[2] as NextFunction | undefined;

      // Bypass on explicit `Cache-Control: no-cache`
      if (req.headers['cache-control']?.includes('no-cache') || options.ttlSec === 0) {
        return executeAndSend();
      }

      const key = buildCacheKey({
        method: req.method,
        path: req.path,
        query: req.query,
        salt: options.saltProvider?.(req),
      });

      try {
        const cached = await cache.get<ReturnType<T>>(key);
        if (cached !== null) {
          res.setHeader('X-Cache', 'HIT');
          return res.status(StatusCodes.OK).json(cached);
        }
      } catch (err) {
        logger.error(`Cache read failure – falling through → ${String(err)}`);
      }

      return executeAndSend();

      async function executeAndSend(): Promise<ReturnType<T>> {
        const payload = (await handler.apply(undefined, args)) as unknown as ReturnType<T>;

        // Express: handler may already have sent response
        if (res.headersSent) {
          return payload;
        }

        // Cache only successful, deterministic responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache
            .set(key, payload, options.ttlSec)
            .catch((err) => logger.error(`Failed to store cache → ${String(err)}`));
          res.setHeader('X-Cache', 'MISS');
        }

        return res.status(res.statusCode || StatusCodes.OK).json(payload);
      }
    } as unknown as T);

/* -----------------------------------------------------------------------------------------------
 * Health-check helper
 * ---------------------------------------------------------------------------------------------*/

/**
 * Simple readiness probe indicating whether Redis is reachable.
 * Exposed through `/internal/cache_health` route.
 */
export const cacheHealthCheck = async (): Promise<{
  redis: 'ready' | 'down';
  memoryItems: number;
}> => {
  const service = getResponseCacheService();
  const redisStatus =
    service['redis'] && service['redis'].isOpen && !service['redis'].isClosed
      ? 'ready'
      : 'down';

  return {
    redis: redisStatus,
    memoryItems: service['memory'].size,
  };
};
```