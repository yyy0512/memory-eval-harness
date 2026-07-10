```typescript
/**
 * SocialPulse Gateway – Response Caching Layer
 * --------------------------------------------
 * This module provides decorator-based and middleware-based response
 * caching utilities backed by Redis.  It is designed to be consumed by
 * REST controllers as well as GraphQL resolvers while remaining agnostic
 * of the presentation technology.  OpenTelemetry tracing and pino
 * structured logging are used to produce rich observability data.
 *
 * Usage (REST):
 *   router.get(
 *     '/v1/public/timeline',
 *     cacheManager.httpCache({ ttlSeconds: 30 }),
 *     timelineController.publicTimeline,
 *   );
 *
 * Usage (GraphQL):
 *   class TimelineResolver {
 *     @Cacheable({ ttlSeconds: 30, scope: CacheScope.PUBLIC })
 *     async timeline(_, args, ctx) {
 *        return await ctx.useCases.getTimeline.execute(args, ctx);
 *     }
 *   }
 */

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import Redis, { RedisOptions } from 'ioredis';
import pino from 'pino';
import {
  SpanStatusCode,
  context,
  trace,
  Tracer,
  Span,
} from '@opentelemetry/api';

const logger = pino({ name: 'response-cache' });
const tracer: Tracer = trace.getTracer('socialpulse.cache');

/* ------------------------------------------------------------------ */
/* Configuration Types                                                */
/* ------------------------------------------------------------------ */

/**
 * Identifies whether a cache entry is user-specific or global.
 */
export enum CacheScope {
  PUBLIC = 'PUBLIC',
  USER = 'USER',
}

export interface ResponseCacheOptions {
  /**
   * Key prefix to allow multiple deployments/environments to coexist
   * within the same Redis cluster (e.g., "prod" vs "staging").
   * Defaults to "socialpulse".
   */
  namespace?: string;

  /**
   * Redis connection parameters.  Falls back to REDIS_URL or
   * localhost if omitted.
   */
  redis?: RedisOptions | string;
}

/**
 * Options passed to the decorator or middleware.
 */
export interface CacheConfig {
  /**
   * Seconds to keep item in cache.  Values <= 0 disable caching.
   */
  ttlSeconds: number;

  /**
   * Additional string to disambiguate keys of the same resource.
   * For example, algorithm version: "rank_v2".
   */
  variationKey?: string;

  /**
   * Whether the cache entry should be user-specific (scoped) or public.
   * When USER is selected, the active user identifier must be available
   * under `req.user.id` or `context.currentUser.id`.
   */
  scope?: CacheScope;
}

/* ------------------------------------------------------------------ */
/* Core Manager                                                       */
/* ------------------------------------------------------------------ */

export class ResponseCacheManager {
  private readonly redis: Redis;
  private readonly namespace: string;

  constructor(opts: ResponseCacheOptions = {}) {
    this.namespace = opts.namespace ?? 'socialpulse';
    this.redis =
      typeof opts.redis === 'string'
        ? new Redis(opts.redis)
        : new Redis(opts.redis);
    this.redis.on('error', (err) => {
      logger.error({ err }, 'Redis connection error in ResponseCacheManager');
    });
  }

  /* -------------------------------------------------------------- */
  /* Express Middleware Factory                                     */
  /* -------------------------------------------------------------- */

  /**
   * Returns an Express middleware that transparently caches HTTP responses.
   * The middleware short-circuits the request lifecycle when a fresh cache
   * entry is found.  Otherwise it captures the response body when the
   * controller finishes and stores it with the desired TTL.
   */
  public httpCache(config: CacheConfig) {
    return async (
      req: Request,
      res: Response,
      next: NextFunction,
    ): Promise<void> => {
      if (config.ttlSeconds <= 0) {
        return next();
      }

      const span = this.startSpan('httpCache', {
        path: req.path,
        method: req.method,
      });

      try {
        const cacheKey = this.buildCacheKey({
          base: req.path,
          variationKey: config.variationKey,
          scope: config.scope ?? CacheScope.PUBLIC,
          userId: this.extractUserId(req),
          extra: req.query,
        });

        // ------------------ Fast-path: return cached value ----------
        const cached = await this.safeRedisGet(cacheKey);
        if (cached) {
          span.setAttribute('cache.hit', true);
          span.end();
          res.setHeader('X-Cache', 'HIT');
          res.type('application/json').send(cached);
          return;
        }

        // ------------------ Slow-path: execute controller ----------
        span.setAttribute('cache.hit', false);
        const originalJson = res.json.bind(res);
        const chunks: unknown[] = [];

        // Monkey-patch res.json to intercept outgoing payload
        res.json = (body: unknown): Response => {
          chunks.push(body);
          return originalJson(body);
        };

        // Continue to controller
        res.once('finish', async () => {
          if (res.statusCode === 200 && chunks.length) {
            await this.safeRedisSet(
              cacheKey,
              JSON.stringify(chunks[0]),
              config.ttlSeconds,
            );
          }
        });

        next();
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.error({ err }, 'httpCache middleware failed');
        next(); // fall through on error
      } finally {
        span.end();
      }
    };
  }

  /* -------------------------------------------------------------- */
  /* Decorator for GraphQL / Service Methods                        */
  /* -------------------------------------------------------------- */

  /**
   * Method decorator that wraps an async function and caches its result.
   */
  public Cacheable(config: CacheConfig) {
    const self = this;

    return function (
      _target: unknown,
      _propertyKey: string,
      descriptor: PropertyDescriptor,
    ): void {
      const original = descriptor.value;

      if (typeof original !== 'function') {
        throw new Error('@Cacheable can only decorate methods');
      }

      descriptor.value = async function (...args: any[]) {
        if (config.ttlSeconds <= 0) {
          return original.apply(this, args);
        }

        const span = self.startSpan('methodCache');

        try {
          const cacheKey = self.buildCacheKey({
            base: original.name,
            variationKey: config.variationKey,
            scope: config.scope ?? CacheScope.PUBLIC,
            userId: self.extractUserIdFromArgs(args),
            extra: args,
          });

          const cached = await self.safeRedisGet(cacheKey);
          if (cached) {
            span.setAttribute('cache.hit', true);
            return JSON.parse(cached);
          }

          span.setAttribute('cache.hit', false);
          const result = await original.apply(this, args);
          await self.safeRedisSet(
            cacheKey,
            JSON.stringify(result),
            config.ttlSeconds,
          );
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          logger.error(
            { err, method: original.name },
            '@Cacheable execution failed',
          );
          return original.apply(this, args); // fallback
        } finally {
          span.end();
        }
      };
    };
  }

  /* -------------------------------------------------------------- */
  /* Public Invalidation Helpers                                    */
  /* -------------------------------------------------------------- */

  /**
   * Delete all keys that match a given pattern within the namespace.
   * WARNING: uses the KEYS command; keep patterns narrow to avoid
   * performance degradation in large keyspaces.
   */
  public async invalidate(pattern: string): Promise<number> {
    const namespacedPattern = `${this.namespace}:${pattern}`;
    const keys = await this.redis.keys(namespacedPattern);
    if (!keys.length) return 0;
    return this.redis.del(...keys);
  }

  /* -------------------------------------------------------------- */
  /* Private Helpers                                                */
  /* -------------------------------------------------------------- */

  private buildCacheKey(args: {
    base: string;
    variationKey?: string;
    scope: CacheScope;
    userId?: string | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    extra?: any;
  }): string {
    const segments = [this.namespace, args.base];

    if (args.variationKey) {
      segments.push(args.variationKey);
    }

    if (args.scope === CacheScope.USER) {
      segments.push(args.userId ?? 'anonymous');
    }

    if (args.extra) {
      const hash = crypto
        .createHash('sha256')
        .update(JSON.stringify(args.extra))
        .digest('base64url')
        .slice(0, 12);
      segments.push(hash);
    }

    // Join using ":" to satisfy Redis key best practices
    return segments.join(':');
  }

  private extractUserId(req: Request): string | null {
    // Passport.js or custom auth populates req.user
    return (req as any).user?.id ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractUserIdFromArgs(args: any[]): string | null {
    // GraphQL resolver signature: (parent, args, context, info)
    const ctx = args[2];
    return ctx?.currentUser?.id ?? null;
  }

  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      logger.warn({ err, key }, 'Redis GET failed');
      return null;
    }
  }

  private async safeRedisSet(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      logger.warn({ err, key }, 'Redis SET failed');
    }
  }

  private startSpan(name: string, attrs: Record<string, unknown> = {}): Span {
    return tracer.startSpan(
      name,
      undefined,
      context.active(),
      // Attributes
    ).setAttributes({
      component: 'response-cache',
      ...attrs,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Singleton Export                                                   */
/* ------------------------------------------------------------------ */

/**
 * A shared instance configured via environment variables.  Most of the
 * codebase should rely on this singleton instead of constructing their
 * own manager (except for tests).
 */
export const responseCache = new ResponseCacheManager({
  namespace: process.env.CACHE_NAMESPACE || 'socialpulse',
  redis:
    process.env.REDIS_URL ??
    {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT) || 6379,
    },
});
```