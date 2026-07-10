```typescript
/**
 * SocialPulse Gateway – Algorithm Versioning Service
 *
 * This module centralises the logic that decides which algorithmic
 * version (e.g., “ranking-v1”, “ranking-v2-canary”) a given request
 * should be routed to.  Controllers use it to forward requests to the
 * corresponding micro-service deployment or GraphQL resolver branch.
 *
 * Motivations
 * -----------
 * • Gradual roll-out / A-B experiments without client updates
 * • Canarying new algorithms for a small subset of users
 * • Deterministic routing through cache + hashing
 *
 * Design
 * ------
 * 1. Cache:     LRU in-memory cache (~5 k entries) to avoid hammering
 *               the remote config service on hot paths.
 * 2. Source of truth: A dedicated “Config-Service” micro-service that
 *               exposes feature-flag evaluation via REST.
 * 3. Fallbacks: Sensible defaults + last-known-good value persisted in
 *               cache if the remote call fails (circuit-breaker style).
 */

import axios, { AxiosInstance } from 'axios';
import LRUCache from 'lru-cache';
import pino, { Logger } from 'pino';

// ---------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------

/** Known algorithmic feature namespaces. Extend as features grow. */
export enum FeatureName {
    FEED_RANKING = 'feed-ranking',
    STORIES_ORDERING = 'stories-ordering',
    NOTIF_RANKING = 'notif-ranking'
}

/** A semver-like or label-based identifier of an algorithm revision. */
export type AlgorithmVersion = string;

/** Contextual data about the requester, used for targeting. */
export interface UserContext {
    userId: string;
    locale?: string;
    device?: string;
    createdAt?: string;
    /** Additional traits provided by upstream middlewares. */
    traits?: Record<string, string | number | boolean>;
}

/** Response contract from Config-Service. */
interface RemoteConfigResponse {
    version: AlgorithmVersion;
    ttlSeconds?: number;
}

// ---------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------

export interface AlgorithmVersioningOptions {
    /**
     * Base URL of Config-Service (e.g., https://config.socialpulse.svc).
     */
    remoteConfigBaseUrl: string;
    /**
     * Default algorithmic versions when none can be resolved.
     * Keys are FeatureName, values are AlgorithmVersion.
     */
    defaultVersions: Record<FeatureName, AlgorithmVersion>;
    /**
     * Max entries in local LRU cache.
     * Defaults to 5000 (roughly 10 MiB for short strings).
     */
    cacheSize?: number;
    /**
     * Hard time-to-live for cache keys. Defaults to 5 minutes.
     */
    cacheTTLSec?: number;
    /**
     * Inject custom logger (for tests or wiring with global logger).
     */
    logger?: Logger;
    /**
     * Optional pre-configured Axios instance (reuses interceptors)
     */
    httpClient?: AxiosInstance;
}

// ---------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------

/**
 * AlgorithmVersioningService
 *
 * Example:
 *   const avs = new AlgorithmVersioningService(opts);
 *   const ver = await avs.getActiveVersion(FeatureName.FEED_RANKING, ctx);
 *   timelineProxy.forward(ver, request);
 */
export class AlgorithmVersioningService {
    private readonly cache: LRUCache<string, AlgorithmVersion>;
    private readonly options: Required<Pick<AlgorithmVersioningOptions,
        'remoteConfigBaseUrl' | 'defaultVersions' | 'cacheSize' | 'cacheTTLSec'
    >>;
    private readonly logger: Logger;
    private readonly http: AxiosInstance;

    constructor(rawOpts: AlgorithmVersioningOptions) {
        // Fill defaults
        this.options = {
            remoteConfigBaseUrl: rawOpts.remoteConfigBaseUrl.replace(/\/+$/, ''),
            defaultVersions: rawOpts.defaultVersions,
            cacheSize: rawOpts.cacheSize ?? 5000,
            cacheTTLSec: rawOpts.cacheTTLSec ?? 300,
        };

        this.logger = rawOpts.logger ?? pino({ name: 'AlgorithmVersioningService' });
        this.http = rawOpts.httpClient ?? axios.create({
            baseURL: this.options.remoteConfigBaseUrl,
            timeout: 1_500, // ms
        });

        this.cache = new LRUCache<string, AlgorithmVersion>({
            max: this.options.cacheSize,
            ttl: this.options.cacheTTLSec * 1_000, // convert to ms
        });
    }

    /**
     * Returns the active algorithm version for a given feature & user.
     * Falls back to defaults on network or evaluation errors.
     */
    async getActiveVersion(
        feature: FeatureName,
        userCtx: UserContext,
    ): Promise<AlgorithmVersion> {
        const cacheKey = this.buildCacheKey(feature, userCtx.userId);

        // 1) Fast path: in-memory cache
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        // 2) Remote evaluation
        try {
            const { data } = await this.http.post<RemoteConfigResponse>(
                `/v1/features/${encodeURIComponent(feature)}/evaluate`,
                {
                    user: userCtx,
                },
            );

            const ver = data?.version ?? this.getDefaultVersion(feature);
            const ttlSec = data?.ttlSeconds ?? this.options.cacheTTLSec;

            this.cache.set(cacheKey, ver, { ttl: ttlSec * 1_000 });
            return ver;
        } catch (error) {
            this.logger.warn(
                { err: error, feature, userId: userCtx.userId },
                'Failed to resolve algorithm version, using default',
            );
            const fallback = this.getDefaultVersion(feature);
            // small TTL to avoid hammering when remote is down
            this.cache.set(cacheKey, fallback, { ttl: 30_000 });
            return fallback;
        }
    }

    /**
     * Manually overrides the cached version for a given user & feature.
     * Used by internal admin tools / tests.
     */
    public overrideVersion(
        feature: FeatureName,
        userId: string,
        version: AlgorithmVersion,
        ttlSec: number = this.options.cacheTTLSec,
    ): void {
        const cacheKey = this.buildCacheKey(feature, userId);
        this.cache.set(cacheKey, version, { ttl: ttlSec * 1_000 });
        this.logger.info(
            { feature, userId, version, ttlSec },
            'Manually overrode algorithm version',
        );
    }

    /**
     * Clears cached decision for the supplied user & feature.
     */
    public invalidate(feature: FeatureName, userId: string): void {
        this.cache.delete(this.buildCacheKey(feature, userId));
    }

    /**
     * Completely wipes the LRU cache (e.g., deploy-time).
     */
    public flushAll(): void {
        this.cache.clear();
        this.logger.debug('Algorithm version cache cleared');
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private buildCacheKey(feature: FeatureName, userId: string): string {
        return `${feature}:${userId}`;
    }

    private getDefaultVersion(feature: FeatureName): AlgorithmVersion {
        return (
            this.options.defaultVersions[feature] ??
            (() => {
                this.logger.error({ feature }, 'Missing default version, using "default"');
                return 'default';
            })()
        );
    }
}

// ---------------------------------------------------------------------
// Example wiring (would live in IoC container / app initialisation)
// ---------------------------------------------------------------------

/*
import { container } from './di-container';

const algVersionService = new AlgorithmVersioningService({
    remoteConfigBaseUrl: process.env.CONFIG_SVC_URL!,
    defaultVersions: {
        [FeatureName.FEED_RANKING]: 'v1',
        [FeatureName.STORIES_ORDERING]: 'v1',
        [FeatureName.NOTIF_RANKING]: 'v1',
    },
    logger: globalLogger.child({ module: 'alg-version' }),
});

container.register('AlgorithmVersioningService', algVersionService);
*/
```