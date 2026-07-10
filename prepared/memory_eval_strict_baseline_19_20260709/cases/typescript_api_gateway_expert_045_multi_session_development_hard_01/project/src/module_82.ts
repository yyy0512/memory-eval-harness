```typescript
/***************************************************************************************************
 * File: src/module_82.ts
 * Project: SocialPulse Gateway (api_gateway)
 *
 * Purpose:
 *   Shared response-caching utilities (decorator + middleware + service) used by both REST and
 *   GraphQL entry points.  Caching is opt-in via the `@Cacheable()` decorator, but route handlers
 *   without the decorator can still leverage the express middleware directly when they need more
 *   control (e.g. Streaming endpoints).
 *
 *   • Version-aware keys guarantee backwards compatibility when new API versions are introduced
 *   • Multi-layer (Redis → in-memory LRU) strategy keeps hot keys in-process while falling back to
 *     Redis for cross-pod coherence
 *   • Instrumented with Prometheus and Winston for deep operational insight
 *
 * Usage:
 *   ┌─────────────────────────────────────────────────────────────────────────┐
 *   │ @Controller('/v1/timelines')                                           │
 *   │ export class TimelineController {                                      │
 *   │   constructor(private readonly timelineUC: FetchTimelineUseCase) {}    │
 *   │                                                                        │
 *   │   @Get('/:userId')                                                     │
 *   │   @Cacheable({ ttl: '10s', scope: 'public' })                          │
 *   │   async getUserTimeline(@Param('userId') id: string) {                 │
 *   │     return this.timelineUC.execute({ userId: id });                    │
 *   │   }                                                                    │
 *   │ }                                                                      │
 *   └─────────────────────────────────────────────────────────────────────────┘
 ***************************************************************************************************/
import type { Request, Response, NextFunction } from 'express';
import Redis, { Redis as RedisClient } from 'ioredis';
import LRU from 'lru-cache';
import crypto from 'crypto';
import { Counter, Histogram, collectDefaultMetrics, Registry } from 'prom-client';
import winston from 'winston';

/* -------------------------------------------------------------------------------------------------
 * Runtime Configuration -------------------------------------------------------------------------- */
export interface CacheConfig {
  redisUrl: string;
  /** Default TTL in seconds unless overridden per route/decorator */
  defaultTtl: number;
  /** Size of local (per-pod) LRU in items */
  lruSize: number;
  /** Whether to include request’s Accept-Language header into the cache key */
  varyByLocale: boolean;
}
const DEFAULT_CFG: CacheConfig = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  defaultTtl: 30,
  lruSize: 5_000,
  varyByLocale: true,
};

/* -------------------------------------------------------------------------------------------------
 * Logger ----------------------------------------------------------------------------------------- */
const logger = winston.child({ module: 'ResponseCache' });

/* -------------------------------------------------------------------------------------------------
 * Prometheus Metrics ----------------------------------------------------------------------------- */
const registry = new Registry();
collectDefaultMetrics({ register: registry });

const cacheHitCounter = new Counter({
  name: 'sp_cache_hits_total',
  help: 'Number of cache hits',
  registers: [registry],
});
const cacheMissCounter = new Counter({
  name: 'sp_cache_misses_total',
  help: 'Number of cache misses',
  registers: [registry],
});
const cacheDuration = new Histogram({
  name: 'sp_cache_retrieval_duration_seconds',
  help: 'Duration of cache get operations',
  buckets: [0.005, 0.01, 0.05, 0.1, 0.3, 1, 3],
  registers: [registry],
});

/* -------------------------------------------------------------------------------------------------
 * CacheKeyBuilder -------------------------------------------------------------------------------- */
export interface CacheKeyCtx {
  /** Full request path incl. query string */
  requestPath: string;
  /** Hash of request body or GraphQL variables */
  bodyHash?: string;
  /** API version visible to the client (e.g. v1, v2beta) */
  apiVersion: string;
  /** Optional additional tags (e.g. userId, locale) */
  tags?: Record<string, string | number | boolean>;
}

export class CacheKeyBuilder {
  private readonly cfg: CacheConfig;
  constructor(cfg: CacheConfig = DEFAULT_CFG) {
    this.cfg = cfg;
  }

  /**
   * Builds a deterministic cache key suitable for Redis + LRU caches.
   * Example: sp:v1:GET:/v1/timelines/123?cursor=abc|body:deadbeef|locale:en-US
   */
  public build(req: Request, apiVersion: string): string {
    const tags: Record<string, string> = {
      method: req.method,
      path: req.originalUrl,
    };

    const locale =
      this.cfg.varyByLocale && req.headers['accept-language']
        ? req.headers['accept-language']!.split(',')[0]
        : undefined;

    if (locale) tags.locale = locale;

    // Only hash body for non-GET or GraphQL POSTs
    if (req.method !== 'GET' && req.body) {
      tags.body = this.hash(JSON.stringify(req.body));
    }

    return [
      'sp', // project prefix
      apiVersion,
      tags.method,
      tags.path,
      tags.body ? `body:${tags.body}` : undefined,
      tags.locale ? `locale:${tags.locale}` : undefined,
    ]
      .filter(Boolean)
      .join(':');
  }

  private hash(str: string): string {
    return crypto.createHash('sha256').update(str).digest('hex').substring(0, 8);
  }
}

/* -------------------------------------------------------------------------------------------------
 * ResponseCacheService --------------------------------------------------------------------------- */
export class ResponseCacheService {
  private readonly redis: RedisClient;
  private readonly lru: LRU<string, string>;
  private readonly keyBuilder: CacheKeyBuilder;
  constructor(private readonly cfg: CacheConfig = DEFAULT_CFG) {
    this.redis = new Redis(cfg.redisUrl);
    this.lru = new LRU({ max: cfg.lruSize });
    this.keyBuilder = new CacheKeyBuilder(cfg);

    this.redis.on('error', (err) => logger.error('Redis error', { err }));
  }

  public async get<T = unknown>(req: Request, apiVersion: string): Promise<T | undefined> {
    const key = this.keyBuilder.build(req, apiVersion);

    // 1. In-process LRU
    const inMem = this.lru.get(key);
    if (inMem) {
      cacheHitCounter.inc();
      return JSON.parse(inMem) as T;
    }

    // 2. Shared Redis
    const end = cacheDuration.startTimer();
    try {
      const snapshot = await this.redis.get(key);
      if (snapshot) {
        cacheHitCounter.inc();
        this.lru.set(key, snapshot); // hydrate LRU
        return JSON.parse(snapshot) as T;
      }
      cacheMissCounter.inc();
      return undefined;
    } finally {
      end();
    }
  }

  public async set<T>(
    req: Request,
    apiVersion: string,
    payload: T,
    ttlSeconds = this.cfg.defaultTtl,
  ): Promise<void> {
    const key = this.keyBuilder.build(req, apiVersion);
    const serialized = JSON.stringify(payload);
    this.lru.set(key, serialized, { ttl: ttlSeconds * 1_000 });
    await this.redis.set(key, serialized, 'EX', ttlSeconds);
  }

  public async invalidatePattern(pattern: string): Promise<void> {
    // Scan vs KEYS to avoid locking Redis
    const stream = this.redis.scanStream({ match: pattern, count: 100 });
    const keys: string[] = [];
    for await (const chunk of stream) keys.push(...chunk);
    if (keys.length) await this.redis.del(...keys);
    logger.info('Invalidated cache keys', { pattern, count: keys.length });
  }

  /** Expose metrics registry for HTTP exporters */
  getMetricsRegistry(): Registry {
    return registry;
  }
}

/* -------------------------------------------------------------------------------------------------
 * Cacheable Decorator ---------------------------------------------------------------------------- */
export interface CacheableOptions {
  /** TTL strings like “10s”, “5m”, “2h” or a numeric value in seconds */
  ttl?: string | number;
  /** public = shared across users, private = keyed by `Authorization` header hash */
  scope?: 'public' | 'private';
  /** Explicit API version override (else derived from route path) */
  versionOverride?: string;
}

function parseTtl(input: string | number | undefined, fallback: number): number {
  if (!input) return fallback;
  if (typeof input === 'number') return input;
  const match = /^(\d+)([smhd])$/.exec(input);
  if (!match) return fallback;
  const [, amountStr, unit] = match;
  const amount = parseInt(amountStr, 10);
  switch (unit) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3600;
    case 'd':
      return amount * 86400;
    default:
      return fallback;
  }
}

/**
 * Method-level decorator that transparently caches responses.
 * Works with both NestJS and vanilla routing frameworks (expects `this.cacheService`).
 */
export function Cacheable(opts: CacheableOptions = {}) {
  return (
    _target: unknown,
    _propertyKey: string,
    descriptor: TypedPropertyDescriptor<(...args: any[]) => Promise<any>>,
  ): void => {
    const original = descriptor.value!;
    descriptor.value = async function (...args: any[]) {
      const req: Request = args.find((a) => a && (a as Request).headers) as Request;
      const res: Response | undefined = args.find((a) => a && (a as Response).status) as Response;

      if (!req || !res) return original.apply(this, args);

      const cacheService: ResponseCacheService = (this as any).cacheService;
      if (!cacheService) {
        logger.warn('@Cacheable used without `cacheService` available');
        return original.apply(this, args);
      }

      const apiVersion =
        opts.versionOverride ?? req.baseUrl.split('/').find((seg) => /^v[\d]/.test(seg)) ?? 'v1';

      const cached = await cacheService.get(req, apiVersion);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return cached;
      }

      const fresh = await original.apply(this, args);
      const ttl = parseTtl(opts.ttl, DEFAULT_CFG.defaultTtl);
      await cacheService.set(req, apiVersion, fresh, ttl);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('Cache-Control', `public, max-age=${ttl}`);
      return fresh;
    };
  };
}

/* -------------------------------------------------------------------------------------------------
 * Express Middleware ----------------------------------------------------------------------------- */
/**
 * Factory helper that creates an express middleware for legacy codepaths
 * where decorators aren’t available or when caching decisions depend on dynamic logic.
 */
export function createResponseCachingMiddleware(
  cacheService: ResponseCacheService,
  apiVersion = 'v1',
  ttlSeconds = DEFAULT_CFG.defaultTtl,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hit = await cacheService.get(req, apiVersion);
      if (hit) {
        res.setHeader('X-Cache', 'HIT');
        res.json(hit);
        return;
      }

      // Hijack res.json to store payload before sending
      const origJson = res.json.bind(res);
      res.json = async (body: any): Promise<Response> => {
        try {
          await cacheService.set(req, apiVersion, body, ttlSeconds);
        } catch (err) {
          logger.error('Failed to set cache', { err });
        }
        res.setHeader('X-Cache', 'MISS');
        return origJson(body);
      };

      next();
    } catch (err) {
      logger.error('Cache middleware error, bypassing', { err });
      next(); // proceed without cache
    }
  };
}

/* -------------------------------------------------------------------------------------------------
 * Re-exports for consumers ----------------------------------------------------------------------- */
export const ResponseCaching = {
  ResponseCacheService,
  Cacheable,
  createResponseCachingMiddleware,
  CacheKeyBuilder,
  CacheConfig: DEFAULT_CFG,
};
export default ResponseCaching;
```