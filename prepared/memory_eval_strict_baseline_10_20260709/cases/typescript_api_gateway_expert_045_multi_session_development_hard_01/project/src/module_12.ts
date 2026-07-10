```typescript
/***************************************************************************************************
 *  SocialPulse Gateway – Versioned Routing & Canary Roll-out Engine
 *
 *  File: src/module_12.ts
 *  ------------------------------------------------------------------------------------------------------------------
 *  Responsibility:
 *      • Resolve downstream micro-service endpoints based on semantic route keys (e.g., "timeline.rank")
 *      • Support versioned routing with weighted canary roll-outs (V1 ⇢ V2 migration, dark launches, A/B tests, etc.)
 *      • Cache routing decisions in-memory & Redis for ultra-low latency
 *      • Produce structured logs for observability, flag anomalies, and gracefully fall back to safe defaults
 *
 *  Architectural Layer: Application service (use-case orchestration, pure coordination, no business rules)
 *
 *  External Dependencies:
 *      npm i @redis/client         -- modern, promise-based Redis driver
 *      npm i uuid                  -- lightweight, RFC-compliant UUID generator (used for trace IDs)
 *
 ***************************************************************************************************/

import { createHash, randomUUID } from 'crypto';
import { RedisClientType, createClient as createRedisClient } from '@redis/client';

/**
 * Logger interface expected by this module.
 * The concrete implementation (Pino, Winston, Bunyan, etc.) is injected at runtime.
 */
interface ILogger {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string | Error, meta?: Record<string, unknown>): void;
}

/**
 * Environment-level configuration contract.
 * A container/DI framework (e.g., Inversify, Nest's provider system) should supply these values.
 */
interface VersionedRoutingConfig {
    /**
     * Default endpoint when nothing is configured for a routeKey.
     * Example: { host: 'timeline.default.svc.cluster.local', port: 8080, protocol: 'http', basePath: '/v1' }
     */
    fallbackEndpoint: ServiceEndpoint;

    /**
     * TTL (ms) for in-memory cache. Redis persistence is longer-lived (seconds–minutes).
     */
    inMemoryTtl: number;

    /**
     * Namespace/prefix for all Redis keys used by this module.
     * Allows multi-tenant safety when sharing a Redis instance.
     */
    redisKeyPrefix: string;
}

/* ------------------------------------------------------------------------------------------------
 *  Domain Types
 * --------------------------------------------------------------------------------------------- */

type HttpProtocol = 'http' | 'https';

export interface ServiceEndpoint {
    protocol: HttpProtocol;
    host: string;
    port: number;
    /**
     * Base path prefixed to every request—usually the version (/v1, /v2-beta, etc.)
     */
    basePath: string;
    version: string; // semantic alias to track currently served version (e.g., "v1", "v2-beta")
}

export interface RouteContext {
    userId: string;
    clientVersion: string;     // App version or SDK semantic version
    userRoles: string[];       // Might influence feature gating (e.g., "beta-tester")
    /**
     * Unique request ID used for distributed tracing.
     * Provided by upstream middleware; auto-generated when omitted.
     */
    traceId?: string;
}

interface WeightedRouteConfig {
    /**
     * Weighted buckets of version -> percentage.
     *
     * Example:
     *   { "v1": 80, "v2": 20 }  ==> 80% of traffic goes to v1, 20% to v2
     */
    buckets: Record<string, number>;
    /**
     * Absolute epoch milliseconds when this config expires.
     * Enables time-boxed canary windows without manual clean-up.
     */
    expiresAt: number;
}

/* ------------------------------------------------------------------------------------------------
 *  Helper Utilities
 * --------------------------------------------------------------------------------------------- */

/**
 * Deterministically bucket a user into a stable percentile [0, 100).
 * We hash the userId to keep distribution uniform and consistent between requests.
 */
function percentHash(userId: string): number {
    const hash = createHash('sha256').update(userId).digest('hex').slice(0, 8);
    // Take first 4 bytes -> int32
    const intVal = parseInt(hash, 16);
    return intVal % 10_000 / 100; /* => 0.00 – 99.99 */
}

function nowMs(): number {
    return Date.now();
}

/* ------------------------------------------------------------------------------------------------
 *  In-Memory LRU Cache (tiny custom implementation)
 * --------------------------------------------------------------------------------------------- */

interface CacheEntry<T> { value: T; expiresAt: number; }

class MemoryCache<T> {
    private store = new Map<string, CacheEntry<T>>();

    constructor(private ttl: number) {}

    get(key: string): T | undefined {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt < nowMs()) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        this.store.set(key, { value, expiresAt: nowMs() + this.ttl });
    }
}

/* ------------------------------------------------------------------------------------------------
 *  Core Service: VersionedRoutingService
 * --------------------------------------------------------------------------------------------- */

export class VersionedRoutingService {
    private memoryCache: MemoryCache<ServiceEndpoint>;

    constructor(
        private readonly redis: RedisClientType,
        private readonly config: VersionedRoutingConfig,
        private readonly logger: ILogger
    ) {
        this.memoryCache = new MemoryCache<ServiceEndpoint>(config.inMemoryTtl);
    }

    /**
     * Resolve a semantic routeKey to a concrete ServiceEndpoint, applying:
     *  1. Weighted bucket selection for canary roll-outs
     *  2. Redis-backed configuration override
     *  3. In-memory cache for ultra-fast hot-path
     */
    async resolve(routeKey: string, ctx: RouteContext): Promise<ServiceEndpoint> {
        const traceId = ctx.traceId ?? randomUUID();

        // 1. Hot path — in-memory cache (microseconds)
        const cached = this.memoryCache.get(routeKey + ctx.userId);
        if (cached) return cached;

        // 2. Fast path — Redis lookup (sub-millisecond network latency in typical deployments)
        let routeConfig: WeightedRouteConfig | null = null;
        try {
            const raw = await this.redis.get(this.redisKey(routeKey));
            if (raw) routeConfig = JSON.parse(raw) as WeightedRouteConfig;
        } catch (err) {
            this.logger.error('Redis read failed for route config', { err, routeKey, traceId });
        }

        // 3. Decide on version
        const selectedVersion = this.pickVersion(routeConfig, ctx);

        // 4. Build service endpoint
        const endpoint = await this.lookupServiceEndpoint(routeKey, selectedVersion, traceId);

        // 5. Cache decision for <ttl> to guarantee sticky version for the user
        this.memoryCache.set(routeKey + ctx.userId, endpoint);

        return endpoint;
    }

    /**
     * Determine which version a request should be routed to.
     *   – If no config, return fallback version
     *   – If config expired, also fallback
     *   – Deterministic hashing to maintain stickiness per user
     */
    private pickVersion(config: WeightedRouteConfig | null, ctx: RouteContext): string {
        if (!config || config.expiresAt < nowMs()) {
            return this.config.fallbackEndpoint.version;
        }

        const percentile = percentHash(ctx.userId);
        let cumulative = 0;
        for (const [version, weight] of Object.entries(config.buckets)) {
            cumulative += weight;
            if (percentile < cumulative) return version;
        }

        // Should never reach here if weights sum to 100
        this.logger.warn('Weights did not sum correctly, defaulting to fallback', {
            config,
            percentile,
            userId: ctx.userId,
        });
        return this.config.fallbackEndpoint.version;
    }

    /**
     * Look up the ServiceEndpoint for a given routeKey & version.
     * Strategy:
     *   1. Environment variables -> fastest (K8s Service DNS)
     *   2. Redis hash (allows runtime override)
     *   3. Fallback static endpoint
     */
    private async lookupServiceEndpoint(routeKey: string, version: string, traceId: string): Promise<ServiceEndpoint> {
        const envVar = process.env[`${routeKey.toUpperCase().replace(/[.:]/g, '_')}_${version.toUpperCase()}_URL`];
        if (envVar) {
            return this.parseUrlEndpoint(envVar, version);
        }

        try {
            const raw = await this.redis.hGet(this.redisKey('endpoint:' + routeKey), version);
            if (raw) return JSON.parse(raw) as ServiceEndpoint;
        } catch (err) {
            this.logger.error('Redis endpoint lookup failed', { err, routeKey, version, traceId });
        }

        // Fallback static config
        return { ...this.config.fallbackEndpoint, version };
    }

    private parseUrlEndpoint(url: string, version: string): ServiceEndpoint {
        try {
            const u = new URL(url);
            const basePath = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname;
            return {
                host: u.hostname,
                port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
                protocol: u.protocol.startsWith('https') ? 'https' : 'http',
                basePath,
                version,
            };
        } catch (err) {
            this.logger.error('Failed to parse endpoint URL, falling back', { url, version, err });
            return { ...this.config.fallbackEndpoint, version };
        }
    }

    private redisKey(suffix: string): string {
        return `${this.config.redisKeyPrefix}:${suffix}`;
    }
}

/* ------------------------------------------------------------------------------------------------
 *  Factory Helper
 * --------------------------------------------------------------------------------------------- */

/**
 * Create an instance of VersionedRoutingService with sane defaults.
 * Provided for convenience when DI container is not available (tests, scripts, etc.).
 */
export async function createVersionedRoutingService(
    redisUrl: string,
    logger: ILogger,
    overrides?: Partial<VersionedRoutingConfig>
): Promise<VersionedRoutingService> {
    const redis = createRedisClient({ url: redisUrl });
    await redis.connect();

    const config: VersionedRoutingConfig = {
        fallbackEndpoint: {
            protocol: 'http',
            host: 'socialpulse.default.svc.cluster.local',
            port: 80,
            basePath: '/v1',
            version: 'v1',
        },
        inMemoryTtl: 30_000,
        redisKeyPrefix: 'sp:route',
        ...overrides,
    };

    return new VersionedRoutingService(redis, config, logger);
}

/* ------------------------------------------------------------------------------------------------
 *  Example Usage (remove or wrap under `if (require.main === module)` for prod build)
 * --------------------------------------------------------------------------------------------- */

if (process.env.NODE_ENV === 'development' && require.main === module) {
    (async () => {
        // Minimalist stdout logger
        const logger: ILogger = {
            info: console.log,
            warn: console.warn,
            error: console.error,
        };

        const service = await createVersionedRoutingService('redis://127.0.0.1:6379', logger);

        const endpoint = await service.resolve('timeline.rank', {
            userId: 'user_123',
            clientVersion: '5.12.0',
            userRoles: ['beta-tester'],
        });

        logger.info('Resolved endpoint', endpoint);
        process.exit(0);
    })().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
```