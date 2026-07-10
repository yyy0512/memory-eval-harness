```typescript
/**
 * SocialPulse Gateway – Response Cache Module
 * -------------------------------------------
 * Provides unified response-caching utilities usable from both
 * Express REST controllers and Apollo-Server GraphQL resolvers.
 *
 * - Layer-aware (presentation only)
 * - Version-aware (x-api-version)
 * - Redis first, with in-process LRU fallback
 * - Pluggable invalidation patterns
 */

import { Request, Response, NextFunction } from 'express';
import Redis, { RedisOptions } from 'ioredis';
import { createHash } from 'crypto';
import LRUCache from 'lru-cache';
import winston, { Logger } from 'winston';
import {
  ApolloServerPlugin,
  GraphQLRequestContextWillSendResponse,
} from 'apollo-server-plugin-base';

////////////////////////////////////////////////////////////////////////////////
// Types & Interfaces
////////////////////////////////////////////////////////////////////////////////

export interface CacheOptions {
  /**
   * Time-to-live in seconds. Default: 60
   */
  ttl?: number;

  /**
   * If true, cache key will include the authenticated user-id (per-user cache).
   */
  private?: boolean;

  /**
   * Allows callers to opt-out of cache for the current request.
   */
  enabled?: boolean;
}

export interface ResponseCacheConfig {
  /**
   * Prefix added to every cache key to avoid collisions with other modules.
   */
  prefix?: string;

  /**
   * Maximum number of items kept in local (LRU) fallback cache.
   */
  localMaxEntries?: number;

  /**
   * Winston logger; if not provided, a default console transport is used.
   */
  logger?: Logger;

  /**
   * ioredis options. If omitted, a local LRU-only cache is used.
   */
  redis?: RedisOptions & { enabled?: boolean };
}

////////////////////////////////////////////////////////////////////////////////
// ResponseCacheService
////////////////////////////////////////////////////////////////////////////////

export class ResponseCacheService {
  readonly logger: Logger;

  private readonly prefix: string;
  private readonly local: LRUCache<string, string>;
  private readonly redis?: Redis;

  constructor(cfg: ResponseCacheConfig = {}) {
    this.prefix = cfg.prefix ?? 'sp-cache';
    this.logger =
      cfg.logger ??
      winston.createLogger({
        level: 'info',
        transports: [new winston.transports.Console()],
      });

    this.local = new LRUCache<string, string>({
      max: cfg.localMaxEntries ?? 10_000,
    });

    if (cfg.redis?.enabled !== false) {
      this.redis = new Redis({
        lazyConnect: true,
        ...(cfg.redis ?? {}),
      });

      // Report redis connection issues but keep gateway running
      this.redis.on('error', (err) =>
        this.logger.warn(`Redis connection error: ${err.message}`),
      );
    }
  }

  /**
   * Compose a namespaced key.
   */
  private key(key: string): string {
    return `${this.prefix}:${key}`;
  }

  /**
   * Resolve a value from Redis or local LRU.
   */
  public async get(key: string): Promise<string | undefined> {
    const k = this.key(key);

    // 1) Try Redis
    if (this.redis) {
      try {
        const value = await this.redis.get(k);
        if (value !== null) return value;
      } catch (err) {
        this.logger.error(`Redis#get failed for key=${k} – ${err}`);
      }
    }

    // 2) Fall back to local LRU
    return this.local.get(k);
  }

  /**
   * Store a value in Redis (if available) and local LRU.
   */
  public async set(key: string, value: string, ttl: number): Promise<void> {
    const k = this.key(key);

    // Local cache first for consistency if redis fails
    this.local.set(k, value, { ttl: ttl * 1000 /* ms */ });

    if (this.redis) {
      try {
        await this.redis.set(k, value, 'EX', ttl);
      } catch (err) {
        this.logger.error(`Redis#set failed for key=${k} – ${err}`);
      }
    }
  }

  /**
   * Invalidate any keys that match the given glob-style pattern.
   * E.g. invalidate('feed:user:123*')
   */
  public async invalidate(pattern: string): Promise<void> {
    const prefix = this.key(''); // includes trailing colon
    const redis = this.redis;

    // Best effort: Invalidate local immediately
    this.local.forEach((_, k) => {
      if (k.startsWith(`${prefix}${pattern}`)) this.local.delete(k);
    });

    if (!redis) return;

    const scanAsync = async (cursor = '0') => {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', this.key(pattern), 'COUNT', '100');
      if (keys.length) await redis.del(...keys);
      if (nextCursor !== '0') await scanAsync(nextCursor);
    };

    try {
      await scanAsync('0');
    } catch (err) {
      this.logger.error(`Redis#invalidate pattern=${pattern} failed – ${err}`);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////
// Express Middleware
////////////////////////////////////////////////////////////////////////////////

/**
 * Generates a deterministic cache-key for an HTTP request.
 */
function computeHttpKey(req: Request, opts: CacheOptions): string {
  const url = req.originalUrl.split('?')[0]; // ignore query-string for GET later
  const query =
    req.method.toUpperCase() === 'GET'
      ? JSON.stringify(req.query || {})
      : ''; // for GET we may want query string
  const body =
    req.method.toUpperCase() !== 'GET'
      ? JSON.stringify(req.body || {})
      : '';

  const authPart = opts.private ? `user:${req.user?.id ?? 'anon'}` : 'public';
  const version = (req.headers['x-api-version'] as string) ?? 'v1';

  // createHash ensures we do not exceed Redis key limits
  const digest = createHash('sha1')
    .update(`${url}|${query}|${body}`)
    .digest('hex');

  return `http:${version}:${authPart}:${digest}`;
}

/**
 * Express middleware that serves/updates the response cache.
 */
export function cacheMiddleware(
  svc: ResponseCacheService,
  opts: CacheOptions = { ttl: 60, enabled: true },
) {
  const effectiveOpts: Required<CacheOptions> = {
    ttl: opts.ttl ?? 60,
    private: opts.private ?? false,
    enabled: opts.enabled ?? true,
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!effectiveOpts.enabled || req.method.toUpperCase() !== 'GET') {
      return next();
    }

    const key = computeHttpKey(req, effectiveOpts);

    try {
      const cached = await svc.get(key);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.type('application/json').send(cached);
      }
    } catch (err) {
      svc.logger.error(`Cache lookup failed for key=${key} – ${err}`);
    }

    // Intercept res.send to capture the payload
    const originalSend = res.send.bind(res);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res.send = (body: any): Response => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload =
          typeof body === 'string' ? body : JSON.stringify(body);

        svc
          .set(key, payload, effectiveOpts.ttl)
          .catch((err) =>
            svc.logger.error(`Cache#set failed for key=${key} – ${err}`),
          );
      }

      res.setHeader('X-Cache', 'MISS');
      return originalSend(body);
    };

    next();
  };
}

////////////////////////////////////////////////////////////////////////////////
// Apollo GraphQL Plugin
////////////////////////////////////////////////////////////////////////////////

interface GraphQLCacheOptions extends CacheOptions {
  /**
   * By default, the GraphQL operation name is included in the key.
   */
  includeOperationName?: boolean;
}

/**
 * Build a lightweight Apollo-Server plugin that provides identical semantics
 * to the Express `cacheMiddleware`.
 */
export function buildApolloResponseCachePlugin(
  svc: ResponseCacheService,
  opts: GraphQLCacheOptions = { enabled: true },
): ApolloServerPlugin {
  const effectiveOpts: Required<GraphQLCacheOptions> = {
    ttl: opts.ttl ?? 30,
    private: opts.private ?? false,
    enabled: opts.enabled ?? true,
    includeOperationName: opts.includeOperationName ?? true,
  };

  const computeKey = (
    ctx: GraphQLRequestContextWillSendResponse<unknown>,
  ): string => {
    const authPart = effectiveOpts.private
      ? `user:${(ctx.context as any)?.user?.id ?? 'anon'}`
      : 'public';
    const version = (ctx.request.http?.headers.get('x-api-version') as string) || 'v1';
    const opName = effectiveOpts.includeOperationName
      ? ctx.operation?.name?.value ?? 'anonymous'
      : '';

    const digest = createHash('sha1')
      .update(
        JSON.stringify({
          query: ctx.request.query,
          variables: ctx.request.variables,
        }),
      )
      .digest('hex');

    return `gql:${version}:${authPart}:${opName}:${digest}`;
  };

  return {
    async requestDidStart(): Promise<{
      willSendResponse: (
        ctx: GraphQLRequestContextWillSendResponse<unknown>,
      ) => Promise<void>;
    }> {
      return {
        async willSendResponse(
          ctx: GraphQLRequestContextWillSendResponse<unknown>,
        ) {
          if (!effectiveOpts.enabled) return;

          const key = computeKey(ctx);

          // Retrieve cache before resolver pipeline begins
          if (!ctx.response.data && effectiveOpts.enabled) {
            const cached = await svc.get(key);
            if (cached) {
              ctx.response.http?.headers.set('X-Cache', 'HIT');
              ctx.response.data = JSON.parse(cached);
              return;
            }
          }

          // After resolvers executed -> cache it
          if (
            ctx.response.data &&
            !ctx.response.errors &&
            ctx.response.http?.status === 200
          ) {
            const payload = JSON.stringify(ctx.response.data);
            await svc
              .set(key, payload, effectiveOpts.ttl)
              .catch((err) =>
                svc.logger.error(`GQL cache#set failed key=${key} – ${err}`),
              );
            ctx.response.http?.headers.set('X-Cache', 'MISS');
          }
        },
      };
    },
  };
}

////////////////////////////////////////////////////////////////////////////////
// Helper Decorator (class-method level caching)
////////////////////////////////////////////////////////////////////////////////

/**
 * Method decorator that transparently caches method return values.
 *
 * Example:
 *   class TrendsService {
 *     @Cacheable({ ttl: 120 })
 *     async getTrendingTags() { ... }
 *   }
 */
export function Cacheable(opts: CacheOptions = {}) {
  const effectiveOpts: Required<CacheOptions> = {
    ttl: opts.ttl ?? 60,
    private: opts.private ?? false,
    enabled: opts.enabled ?? true,
  };

  const svcSingleton = new ResponseCacheService(); // fallback standalone instance

  // eslint-disable-next-line @typescript-eslint/ban-types
  return (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const original = descriptor.value;
    if (typeof original !== 'function') throw new Error('@Cacheable target must be a function');

    // eslint-disable-next-line func-names
    descriptor.value = async function (...args: unknown[]) {
      if (!effectiveOpts.enabled) return original.apply(this, args);

      const ctxUser = (this as any)?.user?.id ?? 'anon';
      const digest = createHash('sha1')
        .update(JSON.stringify(args))
        .digest('hex');
      const key = `method:${_propertyKey}:${effectiveOpts.private ? ctxUser : 'public'}:${digest}`;

      const cached = await svcSingleton.get(key);
      if (cached) return JSON.parse(cached);

      const result = await original.apply(this, args);

      await svcSingleton
        .set(key, JSON.stringify(result), effectiveOpts.ttl)
        .catch((err) => svcSingleton.logger.warn(`@Cacheable#set failed – ${err}`));

      return result;
    };

    return descriptor;
  };
}
```
