```typescript
/***************************************************************************************************
 *  File:          src/module_4.ts
 *  Project:       SocialPulse Gateway – Response Caching & Invalidation Utilities
 *  Description:   Infrastructure-layer module that provides an opinionated, tag-aware response
 *                 cache built on top of Redis.  It exposes:
 *                   • A production-ready RedisCacheService with TTL support.
 *                   • Express middleware for REST endpoints (`cacheRoute`).
 *                   • Apollo GraphQL plugin for query result caching (`buildGraphQLResponseCache`).
 *
 *  The cache is “tag-aware”: every entry can be associated with one or more tags (e.g.,
 *  `public:timeline`, `user:1234`, `hashtag:typescript`).  Tags allow selective invalidation
 *  without resorting to expensive global flushes—critical for high-fan-out social feeds.
 *
 *  Usage (REST):
 *    router.get(
 *        '/v1/timeline/public',
 *        cacheRoute({ ttl: 30, tags: ['public:timeline'] }),
 *        publicTimelineController,
 *    );
 *
 *  Usage (GraphQL):
 *    const server = new ApolloServer({
 *        schema,
 *        plugins: [buildGraphQLResponseCache({ ttl: 15 })],
 *        context: ({ req }) => ({ authUser: req.user }),
 *    });
 *
 ***************************************************************************************************/

import { Request, Response, NextFunction } from 'express';
import { PluginDefinition } from 'apollo-server-core';
import Redis, { Redis as RedisClient } from 'ioredis';
import { EventEmitter } from 'events';
import crypto from 'crypto';

/* -------------------------------------------------------------------------------------------------
 * Configuration
 * -----------------------------------------------------------------------------------------------*/
const {
    REDIS_URL = 'redis://localhost:6379',
    CACHE_NAMESPACE = 'spg:cache', // SocialPulse Gateway cache namespace
} = process.env;

const DEFAULT_TTL_SECONDS = 60;

/* -------------------------------------------------------------------------------------------------
 * Helper Utilities
 * -----------------------------------------------------------------------------------------------*/

/**
 * Generates a stable SHA-256 hash out of an arbitrary object.
 * Used for building opaque but deterministic cache keys from complex request payloads.
 */
function sha256(obj: unknown): string {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

/**
 * Asserts that a value is neither undefined nor null.
 */
function isDefined<T>(value: T | undefined | null): value is T {
    return value !== undefined && value !== null;
}

/* -------------------------------------------------------------------------------------------------
 * RedisCacheService
 * -----------------------------------------------------------------------------------------------*/

/**
 * Tag-aware Redis-backed cache service.
 *
 *  Schema:
 *    – `${CACHE_NAMESPACE}:data:${key}`          → STRING (JSON)       (TTL attached here)
 *    – `${CACHE_NAMESPACE}:tag:${tag}`          → SET<String>         (keys for quick invalidation)
 */
export interface CacheServiceOptions {
    defaultTtlSeconds?: number;
    /**
     * Optional: an EventEmitter that will dispatch 'invalidate' events.
     * Useful for multi-node deployments in combination with Redis Pub/Sub.
     */
    eventBus?: EventEmitter;
}

export class RedisCacheService {
    private readonly defaultTtl: number;
    private readonly client: RedisClient;
    private readonly bus?: EventEmitter;

    constructor(client?: RedisClient, options: CacheServiceOptions = {}) {
        this.client = client ?? new Redis(REDIS_URL);
        this.defaultTtl = options.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
        this.bus = options.eventBus;

        /* ––––– Cluster-wide cache invalidation ––––– */
        if (this.bus) {
            this.bus.on('invalidate', (tag: string) => this.invalidateTag(tag).catch(console.error));
        }
    }

    /* -------------------------------------------------------------------------- */
    /*  PUBLIC API                                                                */
    /* -------------------------------------------------------------------------- */

    /**
     * Fetches a cached value by key.
     */
    async get<T>(key: string): Promise<T | null> {
        const redisKey = this.toDataKey(key);
        const payload = await this.client.get(redisKey);
        return payload ? (JSON.parse(payload) as T) : null;
    }

    /**
     * Stores a value under a key with optional TTL and tags.
     */
    async set<T>(key: string, value: T, ttlSeconds?: number, tags: string[] = []): Promise<void> {
        const redisKey = this.toDataKey(key);
        const payload = JSON.stringify(value);
        const ttl = ttlSeconds ?? this.defaultTtl;

        const pipeline = this.client.pipeline().set(redisKey, payload, 'EX', ttl);

        // Maintain tag → keys mapping for selective invalidation.
        for (const tag of tags) {
            pipeline.sadd(this.toTagKey(tag), redisKey);
        }

        await pipeline.exec();
    }

    /**
     * Invalidates all cache entries associated with the provided tag.
     * Emits an 'invalidate' event to instruct other nodes if an event bus is configured.
     */
    async invalidateTag(tag: string): Promise<void> {
        const tagKey = this.toTagKey(tag);

        const keys = await this.client.smembers(tagKey);
        if (keys.length) {
            const pipeline = this.client.pipeline();
            keys.forEach((k) => pipeline.del(k));
            // also remove the tag set itself
            pipeline.del(tagKey);
            await pipeline.exec();
        }

        // broadcast to cluster peers
        if (this.bus) {
            this.bus.emit('invalidate', tag);
        }
    }

    /**
     * Destroys the whole namespace. Use with caution!
     */
    async flushAll(): Promise<void> {
        const pattern = `${CACHE_NAMESPACE}:*`;
        const stream = this.client.scanStream({ match: pattern, count: 100 });
        const pipeline = this.client.pipeline();
        stream.on('data', (keys: string[]) => {
            keys.forEach((k) => pipeline.del(k));
        });
        return new Promise((resolve, reject) => {
            stream.on('end', async () => {
                await pipeline.exec();
                resolve();
            });
            stream.on('error', reject);
        });
    }

    /* -------------------------------------------------------------------------- */
    /*  PRIVATE HELPERS                                                           */
    /* -------------------------------------------------------------------------- */
    private toDataKey(key: string): string {
        return `${CACHE_NAMESPACE}:data:${key}`;
    }

    private toTagKey(tag: string): string {
        return `${CACHE_NAMESPACE}:tag:${tag}`;
    }
}

/* -------------------------------------------------------------------------------------------------
 * Singleton Export
 * -----------------------------------------------------------------------------------------------*/
export const responseCache = new RedisCacheService();

/* -------------------------------------------------------------------------------------------------
 * Express Middleware
 * -----------------------------------------------------------------------------------------------*/

export interface CacheRouteOptions<TReq extends Request = Request> {
    /**
     * Time-to-live in seconds. Default: 60
     */
    ttl?: number;
    /**
     * Optional static tags to associate with every cache entry.
     */
    tags?: string[];
    /**
     * Custom key builder. By default a key is derived from URL and query params.
     */
    key?(req: TReq): string;
    /**
     * Predicate to decide whether to cache. Default: cache GET 200 responses.
     */
    shouldCache?(req: TReq, res: Response): boolean;
}

/**
 * Express middleware that transparently caches JSON responses.
 */
export function cacheRoute(options: CacheRouteOptions = {}) {
    const {
        ttl = DEFAULT_TTL_SECONDS,
        key: keyBuilder,
        tags = [],
        shouldCache = (req: Request, res: Response) =>
            req.method === 'GET' && res.statusCode === 200,
    } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const cacheKey =
                keyBuilder?.(req) ??
                sha256({
                    url: req.originalUrl,
                    auth: req.get('authorization') ?? '',
                    // Incorporate API version header if present
                    'x-api-ver': req.get('x-api-version') ?? '',
                });

            /* ––––– Try fast path ––––– */
            const cached = await responseCache.get<string>(cacheKey);
            if (isDefined(cached)) {
                res.setHeader('x-cache', 'HIT');
                res.type('application/json').send(cached);
                return;
            }

            /* ––––– Slow path: wrap res.send ––––– */
            const originalSend = res.send.bind(res);

            // eslint-disable-next-line @typescript-eslint/ban-types
            res.send = ((body: any): Response => {
                if (shouldCache(req, res) && isDefined(body)) {
                    // NB: body may be Buffer | string | object
                    const payload = typeof body === 'string' ? body : JSON.stringify(body);
                    responseCache
                        .set<string>(cacheKey, payload, ttl, tags)
                        .catch((err) => console.error('Cache set failed', err));
                    res.setHeader('x-cache', 'MISS');
                }
                return originalSend(body);
            }) as unknown as typeof res.send;

            next();
        } catch (err) {
            /* Never break the request path because of cache issues. */
            console.error('cacheRoute middleware error', err);
            next();
        }
    };
}

/* -------------------------------------------------------------------------------------------------
 * Apollo GraphQL Plugin
 * -----------------------------------------------------------------------------------------------*/

export interface GraphQLCacheOptions {
    ttl?: number;
    /**
     * Function that derives a unique key from GraphQL request context.
     * Defaults to operationName + variables hash + user ID.
     */
    keyBuilder?(params: { operationName?: string; variables: Record<string, unknown>; context: any }): string;

    /**
     * Optional tags (static). Dynamic tags can be derived via keyBuilder if desired.
     */
    tags?: string[];
}

/**
 * Returns an Apollo Server plugin that caches GraphQL query results.
 */
export function buildGraphQLResponseCache(opts: GraphQLCacheOptions = {}): PluginDefinition {
    const ttl = opts.ttl ?? DEFAULT_TTL_SECONDS;

    return {
        async requestDidStart() {
            let cacheKey: string | null = null;
            let shouldCache = false;

            return {
                async parsingDidStart(requestContext) {
                    const { request } = requestContext;
                    const { operationName, variables } = request;
                    const context = requestContext.context;

                    // Only cache queries (not mutations/subscriptions)
                    shouldCache = request.operationName !== 'mutation' && request.query?.startsWith('query');
                    if (!shouldCache) return;

                    cacheKey =
                        opts.keyBuilder?.({ operationName, variables, context }) ??
                        sha256({
                            op: operationName,
                            vars: variables,
                            uid: context?.authUser?.id ?? 'anon',
                        });

                    if (!cacheKey) return;

                    const hit = await responseCache.get<string>(cacheKey);
                    if (hit) {
                        requestContext.response = {
                            data: JSON.parse(hit),
                            http: {
                                headers: {
                                    'x-cache': 'HIT',
                                } as any,
                            },
                        };
                    }
                },

                async willSendResponse(requestContext) {
                    if (!shouldCache || !cacheKey) return;
                    if (requestContext.response?.errors?.length) {
                        // never cache error responses
                        return;
                    }

                    try {
                        const data = requestContext.response?.data;
                        if (isDefined(data)) {
                            const payload = JSON.stringify(data);
                            await responseCache.set<string>(
                                cacheKey,
                                payload,
                                ttl,
                                opts.tags ?? [],
                            );
                            requestContext.response!.http?.headers.set('x-cache', 'MISS');
                        }
                    } catch (err) {
                        /* Swallow cache errors to avoid impacting user traffic */
                        console.error('GraphQL response cache error', err);
                    }
                },
            };
        },
    };
}

/* -------------------------------------------------------------------------------------------------
 * Convenience Helpers for Domain Layer
 * -----------------------------------------------------------------------------------------------*/

/**
 * Emits a cache invalidation event for a given tag and executes the underlying invalidation
 * against Redis.  This helper is intended to be imported by domain event handlers—e.g.,
 * after a user creates a new post we can invalidate `user:<id>:timeline`.
 */
export async function invalidateCacheByTag(tag: string): Promise<void> {
    await responseCache.invalidateTag(tag);
}

/* -------------------------------------------------------------------------------------------------
 * Module‐level Test (executed only when `npm run dev:cache-test`)
 * -----------------------------------------------------------------------------------------------*/
if (require.main === module && process.env.DEV_CACHE_TEST === 'true') {
    (async () => {
        console.log('[cache] running self-test…');
        const KEYS = ['k1', 'k2', 'k3'];

        await Promise.all(
            KEYS.map((k) => responseCache.set(k, { foo: k }, 5, ['test:batch'])),
        );

        const hit = await responseCache.get<{ foo: string }>('k1');
        console.assert(hit?.foo === 'k1', 'cache read failed');

        await responseCache.invalidateTag('test:batch');
        const miss = await responseCache.get('k2');
        console.assert(miss === null, 'cache invalidation failed');

        console.log('[cache] self-test successful ✅');
        process.exit(0);
    })().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
```