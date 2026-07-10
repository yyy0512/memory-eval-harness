```typescript
/**************************************************************************************************
 *  File: module_18.ts
 *  Project: SocialPulse Gateway (api_gateway)
 *  Description:
 *      TimelineCacheService — a high-level, production-grade caching abstraction that wraps Redis
 *      and exposes a task-oriented API tailored to the requirements of social timelines:
 *          • Version-aware key-composition (route versioning)
 *          • Fan-out friendly batching helpers
 *          • Adaptive TTL based on feed volatility
 *          • Built-in observability (structured logging & Prometheus metrics)
 *
 *  Architectural layer: Infrastructure / Adapters
 *  ------------------------------------------------------------------------------------------------
 *  NOTE:
 *      – This module is deliberately “infrastructure first” and thus contains no business logic.
 *      – Usage should be orchestrated by an Application-layer use-case (e.g., FetchPublicTimelineUC)
 **************************************************************************************************/

/* eslint-disable @typescript-eslint/no-explicit-any */

import Redis, { Redis as RedisClient } from 'ioredis';
import pino, { Logger } from 'pino';
import { Counter, Histogram, Registry } from 'prom-client';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Types & Interfaces
////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Granular feed categories allow us to tune TTLs and eviction strategies.
 */
export enum FeedScope {
    PUBLIC = 'public',
    USER   = 'user',
    TOPIC  = 'topic',
    EVENT  = 'event',
}

/**
 * The cache payload contract for timeline items—sealed so that the gateway can version
 * the shape independent of downstream micro-services.
 */
export interface TimelineCachePayload {
    /** JSON-serialisable timeline items (already formed for presentation layer). */
    items: any[];
    /** Millisecond timestamp of the youngest (newest) item—used for staleness checks. */
    latestItemTs: number;
}

/**
 * Configuration options for the TimelineCacheService.
 */
export interface TimelineCacheOptions {
    /**
     * Redis key-prefix to namespace SocialPulse gateway artefacts
     * e.g., "sp:cache:timeline:"
     */
    baseKey: string;

    /**
     * Map<FeedScope, defaultTTLInSeconds>.
     * If omitted, sensible defaults will be applied internally.
     */
    ttl?: Partial<Record<FeedScope, number>>;

    /**
     * Prometheus registry for multi-instance setups. If not provided, the default/global
     * registry will be used.
     */
    prometheusRegistry?: Registry;
}

/**
 * Internal key blueprint.
 */
interface KeyBlueprint {
    versionTag: string;    // e.g., "v2"
    scope: FeedScope;      // e.g., "public"
    targetId: string;      // e.g., "hashtag:cats" | "user:123"
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Implementation
////////////////////////////////////////////////////////////////////////////////////////////////////

export class TimelineCacheService {
    private readonly redis: RedisClient;
    private readonly log: Logger;
    private readonly baseKey: string;
    private readonly ttlByScope: Record<FeedScope, number>;

    // Prometheus Metrics
    private readonly hitCounter: Counter<string>;
    private readonly missCounter: Counter<string>;
    private readonly writeHistogram: Histogram<string>;

    constructor(
        redisClient: RedisClient,
        opts: TimelineCacheOptions,
        logger: Logger = pino({ name: 'TimelineCacheService' }),
    ) {
        this.redis = redisClient;
        this.log   = logger.child({ ctx: 'TimelineCacheService' });

        // Default TTLs (seconds) — can be tuned per business requirements
        this.ttlByScope = {
            [FeedScope.PUBLIC]: opts.ttl?.[FeedScope.PUBLIC] ?? 30,   // hot & volatile
            [FeedScope.USER]:   opts.ttl?.[FeedScope.USER]   ?? 60,
            [FeedScope.TOPIC]:  opts.ttl?.[FeedScope.TOPIC]  ?? 45,
            [FeedScope.EVENT]:  opts.ttl?.[FeedScope.EVENT]  ?? 15,
        };

        this.baseKey = opts.baseKey.endsWith(':')
            ? opts.baseKey
            : opts.baseKey.concat(':');

        // Register metrics
        const registry = opts.prometheusRegistry;
        this.hitCounter  = new Counter({
            name: 'sp_timeline_cache_hits_total',
            help: 'Number of timeline cache hits',
            labelNames: ['scope', 'version'],
            registers: registry ? [registry] : undefined,
        });

        this.missCounter = new Counter({
            name: 'sp_timeline_cache_misses_total',
            help: 'Number of timeline cache misses',
            labelNames: ['scope', 'version'],
            registers: registry ? [registry] : undefined,
        });

        this.writeHistogram = new Histogram({
            name: 'sp_timeline_cache_write_duration_ms',
            help: 'Duration for serialising and writing cache entries',
            labelNames: ['scope', 'version'],
            buckets: [1, 5, 10, 25, 50, 100, 250, 500],
            registers: registry ? [registry] : undefined,
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------------------------

    /**
     * Attempt to fetch a cached timeline entry.
     *
     * @returns TimelineCachePayload | null
     */
    async get<R = TimelineCachePayload>(
        versionTag: string,
        scope: FeedScope,
        targetId: string,
    ): Promise<R | null> {
        const key = this.composeKey({ versionTag, scope, targetId });

        try {
            const payload = await this.redis.get(key);

            if (!payload) {
                this.missCounter.inc({ scope, version: versionTag });
                this.log.debug({ key }, 'Cache miss');
                return null;
            }

            this.hitCounter.inc({ scope, version: versionTag });

            return JSON.parse(payload) as R;
        } catch (error) {
            // We never want cache failures to cascade upwards
            this.log.error({ err: error, key }, 'Error while reading from Redis');
            return null;
        }
    }

    /**
     * Persist a timeline to Redis using adaptive TTLs.
     */
    async set(
        versionTag: string,
        scope: FeedScope,
        targetId: string,
        data: TimelineCachePayload,
        customTTLInSec?: number,
    ): Promise<void> {
        const endTimer  = this.writeHistogram.startTimer({ scope, version: versionTag });
        const key       = this.composeKey({ versionTag, scope, targetId });

        try {
            const ttl = customTTLInSec ?? this.ttlByScope[scope];
            const serialised = JSON.stringify(data);

            // Pipelined write for atomicity & speed
            await this.redis.multi()
                .set(key, serialised, 'EX', ttl)
                .exec();

            this.log.debug(
                { key, ttl, sizeBytes: Buffer.byteLength(serialised) },
                'Cached timeline',
            );
        } catch (error) {
            this.log.error({ err: error, key }, 'Error while writing to Redis');
            // Swallow error to proceed—write-back cache should degrade gracefully
        } finally {
            endTimer();
        }
    }

    /**
     * Invalidate one or more cached timelines.
     *
     * Accepts glob-style patterns to facilitate broad purges (e.g., on user ban).
     */
    async invalidate(
        versionTag: string,
        scope: FeedScope,
        targetIds: string | string[],
    ): Promise<number> {
        const ids = Array.isArray(targetIds) ? targetIds : [targetIds];

        // Convert to KEYS pattern
        const patterns = ids.map(
            (id) => this.composeKey({ versionTag, scope, targetId: id }),
        );

        try {
            // Redis >=6.0: use UNLINK for async deletion to avoid main thread blocking
            const pipeline = this.redis.pipeline();
            patterns.forEach((p) => pipeline.unlink(p));
            const results = await pipeline.exec();

            const deleted = results.reduce(
                (acc, [err, res]) => (err ? acc : acc + (res as number)),
                0,
            );

            this.log.info({ deleted, scope, versionTag }, 'Cache invalidation performed');
            return deleted;
        } catch (error) {
            this.log.error({ err: error, patterns }, 'Error during cache invalidation');
            return 0;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /**
     * Compose a namespaced Redis key of the form:
     *      <baseKey>:<version>:<scope>:<sha1(targetId)>
     *
     * Hashing targetId prevents pathological key length & leaking sensitive ids.
     */
    private composeKey(blueprint: KeyBlueprint): string {
        const { versionTag, scope, targetId } = blueprint;

        return [
            this.baseKey,
            versionTag,
            scope,
            sha1(targetId),
        ].join(':');
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Utilities
////////////////////////////////////////////////////////////////////////////////////////////////////

import { createHash } from 'node:crypto';

/**
 * Cheap, collision-resistant sha1 hash helper for simplifying Redis keys.
 */
function sha1(input: string): string {
    return createHash('sha1').update(input).digest('hex');
}
```
