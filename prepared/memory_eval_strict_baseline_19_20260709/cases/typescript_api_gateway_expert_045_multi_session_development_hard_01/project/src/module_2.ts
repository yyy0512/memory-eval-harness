```typescript
/**************************************************************************************************
 *  File:          src/module_2.ts
 *  Project:       SocialPulse Gateway (api_gateway)
 *  Module:        Response Caching & Version-Aware Cache Decorator
 *  Description:   Infrastructure-level cache provider with first-class support for:
 *                  • Fine-grained per-route TTLs
 *                  • Versioned cache keys (v1, v2 …) to avoid breaking clients
 *                  • Context-aware auto-keying (user, args, headers)
 *                  • Fault-tolerant fallbacks (graceful cache degradation)
 *
 *  NOTE: This source file intentionally avoids framework-specific code (NestJS/Fastify/etc.)
 *        so that it can be consumed in both REST controllers and GraphQL resolvers.
 **************************************************************************************************/

import Redis, { RedisOptions } from 'ioredis';
import crypto from 'crypto';
import { promisify } from 'util';

///////////////////////////////////////////////////////////////////////////////////////////////////
//#region Types & Interfaces
///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Minimal shape of an application-level logger used here.
 * Swap this for pino, winston etc. from the composition-root.
 */
export interface LoggerPort {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string | Error, meta?: Record<string, unknown>): void;
    error(message: string | Error, meta?: Record<string, unknown>): void;
}

/**
 * Cache provider contract
 */
export interface CacheProvider {
    /**
     * Resolve a payload by key, returning null if nothing is cached / cache errors out.
     */
    get<T = unknown>(key: string): Promise<T | null>;
    /**
     * Persist a payload with an optional TTL in seconds.
     */
    set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;
    /**
     * Completely invalidate a key.
     */
    delete(key: string): Promise<void>;
}

/**
 * Per-route cache configuration
 */
export interface CacheConfig {
    /**
     * TTL in seconds. If omitted, falls back to defaultTTL.
     * Use 0 to cache forever.
     */
    ttl?: number;
    /**
     * Explicit cache key prefix version (v1, v2 …). Defaults to "v1".
     * Changing version will naturally invalidate old data.
     */
    version?: string;
    /**
     * Allows custom key builder. When omitted we auto-hash the arguments.
     */
    key?(args: unknown[], ctx?: RequestContext): string;
}

/**
 * Lightweight context object that higher layers may enrich.
 * Only include properties that matter for cache scoping.
 */
export interface RequestContext {
    userId?: string;          // for private timeline etc.
    tenantId?: string;        // multi-tenant scenarios
    ip?: string;              // rate-limiting
    path?: string;            // route identifier
    method?: string;          // GET/POST etc.
    // … extend as needed
}

///////////////////////////////////////////////////////////////////////////////////////////////////
//#endregion
///////////////////////////////////////////////////////////////////////////////////////////////////
//#region Redis Implementation
///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Redis-backed cache provider
 */
export class RedisCacheProvider implements CacheProvider {
    private readonly redis: Redis;

    constructor(
        redisUrl: string,
        private readonly logger: LoggerPort,
        opts: RedisOptions = {},
    ) {
        this.redis = new Redis(redisUrl, {
            // sensible defaults for production hardened connections
            maxRetriesPerRequest: 3,
            enableReadyCheck: true,
            connectTimeout: 5_000,
            ...opts,
        });

        this.redis.on('error', (err) => {
            this.logger.error('Redis connection error', { err });
        });
    }

    async get<T>(key: string): Promise<T | null> {
        try {
            const raw = await this.redis.get(key);

            if (raw === null) return null;

            return JSON.parse(raw) as T;
        } catch (err) {
            this.logger.warn('Cache GET failed – falling back', { err, key });
            return null; // degrade gracefully
        }
    }

    async set<T>(key: string, value: T, ttl: number = 0): Promise<void> {
        try {
            const payload = JSON.stringify(value);
            if (ttl > 0) {
                await this.redis.set(key, payload, 'EX', ttl);
            } else {
                await this.redis.set(key, payload);
            }
        } catch (err) {
            this.logger.warn('Cache SET failed – continuing without cache', { err, key });
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.redis.del(key);
        } catch (err) {
            this.logger.warn('Cache DEL failed – ignoring', { err, key });
        }
    }

    /**
     * Gracefully close redis connection on app shutdown
     */
    async close(): Promise<void> {
        const quit = promisify(this.redis.quit).bind(this.redis);
        await quit();
    }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
//#endregion
///////////////////////////////////////////////////////////////////////////////////////////////////
//#region Decorator
///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Decorator factory to transparently cache method results.
 *
 * Usage:
 *   class TimelineController {
 *     constructor(private readonly feedService: FeedService) {}
 *
 *     @Cacheable({ ttl: 3, version: 'v2' })
 *     async getPublicFeed(_: void, ctx: RequestContext) {
 *       return this.feedService.getPublicFeed(ctx);
 *     }
 *   }
 */
export function Cacheable(config: CacheConfig = {}) {
    const {
        ttl,
        version = 'v1',
        key: customKeyBuilder,
    } = config;

    return function (
        target: unknown,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const original = descriptor.value;

        if (typeof original !== 'function') {
            throw new Error(`@Cacheable can only decorate methods, got: ${typeof original}`);
        }

        descriptor.value = async function (
            ...args: unknown[]
        ): Promise<unknown> {
            // Last param is assumed to be RequestContext (convention)
            const maybeCtx = args.at(-1);
            const ctx = isRequestContext(maybeCtx) ? (maybeCtx as RequestContext) : undefined;

            const cacheProvider: CacheProvider | undefined = (this as any)
                .cacheProvider as CacheProvider;

            const logger: LoggerPort | undefined = (this as any).logger as LoggerPort;

            if (!cacheProvider) {
                logger?.warn(
                    '@Cacheable: No cache provider found on `this`. Bypassing cache.',
                    { class: target.constructor.name, method: propertyKey },
                );
                return original.apply(this, args);
            }

            const key =
                customKeyBuilder?.(args, ctx) ??
                buildDefaultKey({
                    targetName: target.constructor.name,
                    methodName: propertyKey,
                    version,
                    args,
                    ctx,
                });

            // Attempt read-through
            const cached = await cacheProvider.get(key);
            if (cached !== null) {
                logger?.debug('Cache hit', { key });
                return cached;
            }

            logger?.debug('Cache miss', { key });
            const result = await original.apply(this, args);

            // Fire & forget – do not await to reduce latency
            cacheProvider
                .set(key, result, ttl)
                .catch((err) => logger?.warn('Cache SET async failed', { key, err }));

            return result;
        };

        return descriptor;
    };
}

///////////////////////////////////////////////////////////////////////////////////////////////////
//#endregion
///////////////////////////////////////////////////////////////////////////////////////////////////
//#region Helpers
///////////////////////////////////////////////////////////////////////////////////////////////////

function isRequestContext(obj: unknown): obj is RequestContext {
    if (obj === null || typeof obj !== 'object') return false;
    return (
        'userId' in obj ||
        'tenantId' in obj ||
        'ip' in obj ||
        'path' in obj ||
        'method' in obj
    );
}

/**
 * Build a cryptographically stable cache key from arguments & context
 */
function buildDefaultKey(params: {
    targetName: string;
    methodName: string;
    version: string;
    args: unknown[];
    ctx?: RequestContext;
}): string {
    const { targetName, methodName, version, args, ctx } = params;

    const serialized = JSON.stringify({
        args,
        ctx,
    });

    const digest = crypto.createHash('sha1').update(serialized).digest('hex');

    // Example key:
    //  TimelineController:getPublicFeed:v2:7b6f3a1…
    return `${targetName}:${methodName}:${version}:${digest}`;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
//#endregion
///////////////////////////////////////////////////////////////////////////////////////////////////
//#region Example Concrete Usage (for illustration only – not executed inside gateway bootstrapping)
///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * This example illustrates how a controller/presenter might leverage
 * the cache decorator assuming DI injects the required dependencies.
 */
class ExamplePublicTimelineController {
    // DI injection
    constructor(
        private readonly feedService: { getPublicFeed(): Promise<unknown> },
        public readonly cacheProvider: CacheProvider,
        public readonly logger: LoggerPort,
    ) {}

    @Cacheable({ ttl: 30, version: 'v2' })
    async getPublicTimeline(_: void, ctx: RequestContext) {
        // Business logic delegated to service layer
        return this.feedService.getPublicFeed();
    }
}

//#endregion
```