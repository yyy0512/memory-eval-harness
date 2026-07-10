```typescript
/**
 * SocialPulse Gateway – Response Caching Module
 *
 * This module centralises response-caching concerns for both REST and GraphQL
 * entry points.  It exposes:
 *
 *  • RedisCacheProvider – a thin typed façade around ioredis.
 *  • cacheMiddleware     – an Express middleware for REST GET endpoints.
 *  • graphQLResponseCachePlugin – an Apollo-server plugin for GraphQL operations.
 *
 *  The design supports:
 *    – Version-aware cache keys (via X-Api-Version header or query string v).
 *    – Per-route configurable TTL.
 *    – Tag-based invalidation (e.g., “timeline:42”, “hashtag:typescript”).
 *    – Graceful degradation when Redis is unavailable.
 *
 *  Usage (REST):
 *      router.get(
 *          '/v1/timeline/:userId',
 *          cacheMiddleware({ ttl: 15, tags: ({ params }) => [`timeline:${params.userId}`] }),
 *          timelineController.getTimeline,
 *      );
 *
 *  Usage (GraphQL – Apollo v4):
 *      const apollo = new ApolloServer({
 *          typeDefs,
 *          resolvers,
 *          plugins: [graphQLResponseCachePlugin],
 *      });
 */

import { Request, Response, NextFunction } from 'express';
import Redis, { Redis as RedisClient, Pipeline } from 'ioredis';
import crypto from 'crypto';
import debugLib from 'debug';
import { PluginDefinition } from '@apollo/server';
import { GraphQLError } from 'graphql';

const debug = debugLib('socialpulse:cache');

/* -------------------------------------------------------------------------- */
/*                              Helper utilities                              */
/* -------------------------------------------------------------------------- */

/**
 * Generates a SHA-256 hash for arbitrary serialisable input.
 */
const sha256 = (input: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

/* -------------------------------------------------------------------------- */
/*                              Cache ‑ Provider                              */
/* -------------------------------------------------------------------------- */

export interface CacheProvider {
  readonly client: RedisClient;
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds: number, tags?: string[]): Promise<void>;
  invalidateTags(tags: string[]): Promise<void>;
  close(): Promise<void>;
}

export class RedisCacheProvider implements CacheProvider {
  public readonly client: RedisClient;

  constructor(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    this.client = new Redis(url, {
      lazyConnect: true,
      enableAutoPipelining: true,
      maxRetriesPerRequest: 2,
    });
    this.client.on('error', err => debug('Redis error:', err));
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch (err) {
      debug('GET failed for key %s: %O', key, err);
      return null;
    }
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds: number,
    tags: string[] = [],
  ): Promise<void> {
    try {
      const pipe: Pipeline = this.client.pipeline().setex(key, ttlSeconds, JSON.stringify(value));

      if (tags.length) {
        // Maintain a reverse-index:  tag -> Set[cache keys]
        tags.forEach(tag => pipe.sadd(`tag:${tag}`, key));
        // Ensure tag sets expire eventually to avoid leaks.
        tags.forEach(tag => pipe.expire(`tag:${tag}`, ttlSeconds * 2));
      }

      await pipe.exec();
    } catch (err) {
      debug('SET failed for key %s: %O', key, err);
    }
  }

  async invalidateTags(tags: string[]): Promise<void> {
    if (!tags.length) return;

    try {
      const pipe = this.client.pipeline();
      for (const tag of tags) {
        const memberKeys = await this.client.smembers(`tag:${tag}`);
        if (memberKeys.length) {
          pipe.del(...memberKeys);
        }
        pipe.del(`tag:${tag}`); // remove index itself
      }
      await pipe.exec();
      debug('Invalidated tags %o', tags);
    } catch (err) {
      debug('Failed to invalidate tags %o: %O', tags, err);
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

/* -------------------------------------------------------------------------- */
/*                               REST Middleware                              */
/* -------------------------------------------------------------------------- */

interface CacheOptions {
  /**
   * Time-to-live in seconds.
   */
  ttl: number;
  /**
   * Optional function to compute tags based on request.
   * These tags can later be used for bulk invalidation (e.g. after a post).
   */
  tags?: (req: Request) => string[];
  /**
   * Toggle caching globally per route; can be set to false from feature flags.
   */
  enabled?: boolean;
}

/**
 * Produces a deterministic cache key for an incoming HTTP request.
 *
 *  Factors:
 *    – path, method (only GET is allowed for caching)
 *    – query string
 *    – api version (from header, query param or path segment)
 *    – authenticated user (to avoid leakage of private feed)
 */
const buildRequestCacheKey = (req: Request): string | null => {
  if (req.method !== 'GET') return null;

  const basePath = req.baseUrl + req.path; // Express mounts respect
  const query = req.query;
  const apiVersion =
    (req.headers['x-api-version'] as string) ||
    (typeof req.query.v === 'string' ? req.query.v : undefined);

  const userId = (req as any).auth?.userId ?? 'anon';

  const composite = { basePath, query, apiVersion, userId };
  return `rest:${sha256(composite)}`;
};

/**
 * Express middleware that caches GET responses.
 */
export const cacheMiddleware =
  (opts: CacheOptions) => async (req: Request, res: Response, next: NextFunction) => {
    const { ttl, tags = () => [], enabled = true } = opts;

    if (!enabled) return next();

    const key = buildRequestCacheKey(req);
    if (!key) return next();

    const cache = Cache.instance();
    try {
      const cached = await cache.get<unknown>(key);
      if (cached) {
        debug('HIT %s', key);
        return res
          .set('X-Cache', 'HIT')
          .set('Cache-Control', `public, max-age=${ttl}`)
          .json(cached);
      }

      debug('MISS %s', key);
      // Hook into res.json to store the payload after controller finishes.
      const originalJson = res.json.bind(res);
      res.json = async (body: unknown) => {
        // Only cache successful payloads (2xx)
        if (res.statusCode >= 200 && res.statusCode < 300) {
          await cache.set(key, body, ttl, tags(req));
        }
        return originalJson(body);
      };
    } catch (err) {
      debug('Cache middleware error %O', err);
      // Fail open – continue request path
    }
    next();
  };

/* -------------------------------------------------------------------------- */
/*                          GraphQL Response Cache                            */
/* -------------------------------------------------------------------------- */

const GRAPHQL_CACHE_TTL_SECONDS = 10;

/**
 * Apollo plugin that caches GraphQL query results.
 * Mutations are intentionally excluded.
 */
export const graphQLResponseCachePlugin: PluginDefinition = {
  async requestDidStart() {
    const cache = Cache.instance();

    return {
      async didResolveOperation(ctx) {
        const { request, document } = ctx;
        if (!document) return;

        // Exclude mutations.
        const operation = document.definitions.find(
          (def: any) => def.kind === 'OperationDefinition',
        );
        if (!operation || operation.operation !== 'query') return;

        // Compute cache key.
        const key = `graphql:${sha256({
          query: request.query,
          variables: request.variables,
          user: ctx.contextValue?.auth?.userId ?? 'anon',
        })}`;

        // Serve from cache if possible.
        const cached = await cache.get(key);
        if (cached) {
          debug('GQL HIT %s', key);
          ctx.overallCachePolicy = { maxAge: GRAPHQL_CACHE_TTL_SECONDS };
          ctx.response!.http!.headers.set('X-Cache', 'HIT');
          ctx.response!.data = cached;
          // Short-circuit the execution pipeline.
          throw new GraphQLError('Response served from cache', {
            extensions: { code: 'CACHED_RESPONSE', cachedResponse: true },
          });
        }

        // Otherwise attach hook to store after execution.
        ctx.response!.http!.headers.set('X-Cache', 'MISS');

        ctx.response!.willSendResponse = async ({ response }) => {
          if (response.errors?.length) return; // do not cache erroneous responses
          await cache.set(key, response.data, GRAPHQL_CACHE_TTL_SECONDS);
        };
      },
    };
  },
};

/* -------------------------------------------------------------------------- */
/*                           Singleton Cache Access                           */
/* -------------------------------------------------------------------------- */

/**
 * Simple singleton wrapper to avoid accidental multi-instantiation of
 * Redis clients (would lead to connection explosion under hot reload).
 */
class Cache {
  private static _instance: CacheProvider;

  static instance(): CacheProvider {
    if (!Cache._instance) {
      Cache._instance = new RedisCacheProvider();
    }
    return Cache._instance;
  }
}

/* -------------------------------------------------------------------------- */
/*                          Graceful shutdown helper                          */
/* -------------------------------------------------------------------------- */

/**
 * Ensure Redis connections are terminated on process exit.  The gateway has a
 * centralised shutdown handler; this double-register ensures we never leak FDs
 * even if the caller forgets.
 */
const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

shutdownSignals.forEach(signal => {
  process.once(signal, async () => {
    debug('Received %s – draining cache connections...', signal);
    try {
      await Cache.instance().close();
      debug('Redis connection closed.');
    } catch (err) {
      debug('Error during Redis shutdown %O', err);
    } finally {
      process.kill(process.pid, signal);
    }
  });
});
```